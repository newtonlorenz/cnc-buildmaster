import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server, ProtocolError } from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Match MAX_JOB_PACKAGE_BYTES in the Python HTTP boundary. MCP framing needs
// separate headroom; the encoded backend request still has the exact same cap.
export const LIMITS = Object.freeze({
  discovery: 16 * 1024, arguments: 24_000_000,
  stdio: 24_000_000 + 64 * 1024, response: 2 * 1024 * 1024,
});
const TOOL_NAMES = new Set([
  'buildmaster_status', 'buildmaster_job', 'buildmaster_prepare',
  'buildmaster_request_action', 'buildmaster_request_status', 'buildmaster_stop',
]);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = (code, message) => ({ error: { code, message, retryable: false } });

export class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
  }
}

function fail(code, message) { throw new BridgeError(code, message); }

export function checkPrivateFile(metadata, uid = process.getuid?.()) {
  if (uid === undefined || !metadata.isFile() || metadata.uid !== uid || (metadata.mode & 0o077)) {
    fail('unsafe_connection', 'Connection file must be a regular file owned by this user with no group or other permissions.');
  }
  if (metadata.size <= 0 || metadata.size > LIMITS.discovery) {
    fail('unsafe_connection', 'Connection file has an invalid size.');
  }
}

async function boundedFile(filename, limit, privateFile = false) {
  let handle;
  try {
    const absolute = path.resolve(filename);
    if (privateFile && await realpath(path.dirname(absolute)) !== path.dirname(absolute)) {
      fail('unsafe_connection', 'Connection file directories must not be symbolic links.');
    }
    const before = await lstat(absolute);
    if (before.isSymbolicLink() || !before.isFile()) {
      fail('unsafe_file', 'Input must be a regular file, not a symbolic link.');
    }
    if (privateFile) checkPrivateFile(before);
    if (before.size > limit) fail('input_too_large', 'Input exceeds the size limit.');
    handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino) fail('unsafe_file', 'Input file changed while opening.');
    if (privateFile) checkPrivateFile(after);
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = await handle.read(buffer, size, buffer.length - size, null);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > limit) fail('input_too_large', 'Input exceeds the size limit.');
    return buffer.toString('utf8', 0, size);
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    fail(privateFile ? 'connection_unavailable' : 'input_unavailable',
      privateFile ? 'Cannot read the private connection file. Start Buildmaster and check the selected port or connection file.' : 'Cannot read the JSON input file.');
  } finally {
    await handle?.close();
  }
}

function parseJson(text) {
  try { return JSON.parse(text); }
  catch { fail('invalid_json', 'Expected valid JSON.'); }
}

function portNumber(value) {
  if (!/^\d+$/.test(String(value)) || !Number.isInteger(Number(value)) || Number(value) < 1024 || Number(value) > 65535) {
    fail('invalid_port', 'Port must be an integer from 1024 to 65535.');
  }
  return Number(value);
}

/** Both front ends use the same typed, server-discovered tool boundary. */
export class AgentBridge {
  #connection;
  #connectionPromise;
  #secrets = new Set();
  #filename;
  #selectedPort;
  #timeoutMs;
  #schemaValidator = new AjvJsonSchemaValidator();
  #toolSignature;

  constructor({ connection, port, env = process.env, timeoutMs = 10000 } = {}) {
    const chosenPort = portNumber(port ?? 8765);
    this.#filename = connection ?? path.join(env.CNC_MAP_RUNTIME_DIR || path.join(ROOT, '.runtime/cnc-map'), `agent-${chosenPort}.json`);
    this.#selectedPort = connection && port === undefined ? undefined : chosenPort;
    this.#timeoutMs = timeoutMs;
  }

  #redact(value) {
    if (typeof value === 'string') {
      for (const secret of this.#secrets) value = value.split(secret).join('[REDACTED]');
      return value;
    }
    if (Array.isArray(value)) return value.map(item => this.#redact(item));
    if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      this.#redact(key), /^(?:token|authorization|agentToken|bearerToken)$/i.test(key) ? '[REDACTED]' : this.#redact(item),
    ]));
    return value;
  }

  errorResult(error) {
    return this.#redact(error instanceof BridgeError
      ? failure(error.code, error.message)
      : failure('bridge_error', 'Agent bridge failed. No automatic retry was made.'));
  }

  async #loadConnection() {
    const data = parseJson(await boundedFile(this.#filename, LIMITS.discovery, true));
    if (isObject(data) && typeof data.token === 'string' && data.token) this.#secrets.add(data.token);
    if (!isObject(data) || data.protocolVersion !== 1 || typeof data.instanceId !== 'string' || !data.instanceId
        || !Number.isSafeInteger(data.pid) || data.pid <= 0 || typeof data.token !== 'string'
        || !/^[A-Za-z0-9._~+\/-]+=*$/.test(data.token) || data.token.length > 4096) {
      fail('invalid_connection', 'Connection file has an invalid protocol, instance, process or token.');
    }
    const match = typeof data.apiBase === 'string' && /^http:\/\/127\.0\.0\.1:([1-9]\d*)$/.exec(data.apiBase);
    if (!match) fail('invalid_connection', 'Connection API must use http://127.0.0.1:<port> with no other URL components.');
    const port = portNumber(match[1]);
    if (this.#selectedPort !== undefined && port !== this.#selectedPort) {
      fail('port_mismatch', 'Connection file does not match the selected port.');
    }
    this.#connection = { port, instanceId: data.instanceId, token: data.token };
  }

  async #ensureConnection() {
    // Pin the first discovery result for this process; never silently reconnect a mutation.
    this.#connectionPromise ??= this.#loadConnection();
    await this.#connectionPromise;
  }

  async #request(endpoint, body) {
    await this.#ensureConnection();
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    if (encoded && Buffer.byteLength(encoded) > LIMITS.arguments) fail('input_too_large', 'Tool arguments exceed the size limit.');
    return new Promise((resolve, reject) => {
      // Explicit Agent with empty proxy configuration bypasses environment/global proxies.
      const agent = new http.Agent({ keepAlive: false, proxyEnv: {} });
      let settled = false;
      let timer;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        agent.destroy();
        error ? reject(error) : resolve(value);
      };
      const request = http.request({
        hostname: '127.0.0.1', port: this.#connection.port, path: endpoint,
        method: encoded === undefined ? 'GET' : 'POST', agent,
        headers: { authorization: `Bearer ${this.#connection.token}`, accept: 'application/json',
          ...(encoded === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) }) },
      }, response => {
        const rejectResponse = (code, message) => {
          finish(new BridgeError(code, message));
          response.destroy();
        };
        if (response.statusCode >= 300 && response.statusCode < 400) {
          rejectResponse('redirect_refused', 'Agent API redirects are not permitted.');
          return;
        }
        if (!/^application\/json(?:\s*;|$)/i.test(response.headers['content-type'] || '')) {
          rejectResponse('invalid_response', 'Agent API did not return JSON.');
          return;
        }
        let size = 0;
        const chunks = [];
        response.on('data', chunk => {
          size += chunk.length;
          if (size > LIMITS.response) rejectResponse('response_too_large', 'Agent API response exceeds the size limit.');
          else chunks.push(chunk);
        });
        response.on('error', () => finish(new BridgeError('connection_lost', 'Agent API connection ended. Outcome may be unknown; no automatic retry was made.')));
        response.on('end', () => {
          if (settled) return;
          try {
            const data = this.#redact(parseJson(Buffer.concat(chunks).toString('utf8')));
            if (!isObject(data)) fail('invalid_response', 'Agent API result must be a JSON object.');
            // The HTTP boundary also uses {error: string} for malformed requests.
            if (typeof data.error === 'string') data.error = {
              code: response.statusCode >= 400 ? 'http_error' : 'agent_error', message: data.error, retryable: false,
            };
            if (data.error !== undefined && (!isObject(data.error) || typeof data.error.code !== 'string'
                || typeof data.error.message !== 'string' || data.error.retryable !== false)) {
              fail('invalid_response', 'Agent API error has an invalid shape.');
            }
            if ((response.statusCode < 200 || response.statusCode >= 300) && !data.error) {
              fail('http_error', `Agent API returned HTTP ${response.statusCode}. No automatic retry was made.`);
            }
            finish(undefined, data);
          } catch (error) { finish(error); }
        });
      });
      request.on('error', () => finish(new BridgeError('connection_failed', 'Cannot reach the agent API. Outcome may be unknown; no automatic retry was made.')));
      timer = setTimeout(() => {
        finish(new BridgeError('request_timeout', 'Agent API timed out. Outcome may be unknown; no automatic retry was made.'));
        request.destroy();
      }, this.#timeoutMs);
      request.end(encoded);
    });
  }

  async tools() {
    const data = await this.#request('/api/agent/capabilities');
    if (data.error) throw new BridgeError(data.error.code, data.error.message);
    if (data.protocolVersion !== 1 || data.instanceId !== this.#connection.instanceId) {
      fail('instance_mismatch', 'Agent API protocol or instance does not match discovery. Restart the bridge after checking Buildmaster.');
    }
    if (!Array.isArray(data.tools) || data.tools.length > TOOL_NAMES.size) fail('invalid_capabilities', 'Agent API returned an invalid tool list.');
    const names = new Set();
    const tools = data.tools.map(tool => {
      if (!isObject(tool) || !TOOL_NAMES.has(tool.name) || names.has(tool.name) || typeof tool.description !== 'string'
          || !isObject(tool.inputSchema) || tool.inputSchema.type !== 'object' || !isObject(tool.annotations)) {
        fail('invalid_capabilities', 'Agent API returned an invalid or unsupported tool.');
      }
      names.add(tool.name);
      return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations };
    });
    const signature = JSON.stringify(tools);
    const changed = this.#toolSignature !== undefined && signature !== this.#toolSignature;
    this.#toolSignature = signature;
    if (changed) this.onToolsChanged?.();
    return { protocolVersion: 1, instanceId: data.instanceId, tools };
  }

  async call(name, arguments_ = {}) {
    try {
      if (!TOOL_NAMES.has(name)) fail('unknown_tool', 'Only the named Buildmaster agent tools are supported.');
      if (!isObject(arguments_)) fail('invalid_arguments', 'Tool arguments must be a JSON object.');
      const capabilities = await this.tools();
      const tool = capabilities.tools.find(item => item.name === name);
      if (!tool) fail('unavailable_tool', 'This tool is not available from the current server.');
      let validation;
      try { validation = this.#schemaValidator.getValidator(tool.inputSchema)(arguments_); }
      catch { fail('invalid_schema', 'The server tool schema could not be validated.'); }
      if (!validation.valid) fail('invalid_arguments', 'Arguments do not match the current server inputSchema. Inspect tools and supply the exact required fields.');
      // Preserve caller-supplied identifiers/revisions and conflicts. The backend owns permission and action gates.
      return await this.#request('/api/agent/call', { name, arguments: arguments_ });
    } catch (error) { return this.errorResult(error); }
  }
}

/** SDK owns framing, negotiation, request validation and lifecycle. */
export function createMcpServer(bridge) {
  const server = new Server({ name: 'cnc-buildmaster', version: '0.1.0' }, {
    capabilities: { tools: { listChanged: true } },
    instructions: 'Use the server tool schemas. Preparation needs operator permission. Machine actions are requests for browser approval. Use the current server sessionId and pcbRevision. The caller supplies a new unique requestId for each intended action. Retain the exact same ID and arguments when checking an ambiguous original result; inspect buildmaster_request_status with the original ID. Never automatically repeat a movement with a new ID or silently retry a mutation.',
  });
  bridge.onToolsChanged = () => { void server.sendToolListChanged().catch(() => {}); };
  server.setRequestHandler('tools/list', async () => {
    try { return { tools: (await bridge.tools()).tools }; }
    catch (error) {
      const result = bridge.errorResult(error);
      throw new ProtocolError(-32603, result.error.message, result);
    }
  });
  server.setRequestHandler('tools/call', async request => {
    const result = await bridge.call(request.params.name, request.params.arguments ?? {});
    return server.projectCallToolResult({
      content: [{ type: 'text', text: JSON.stringify(result) }],
      structuredContent: result, isError: Boolean(result.error),
    }, undefined);
  });
  return server;
}

const HELP = `Usage: cnc-agent [--connection PATH] [--port PORT] <command>

  tools                         Show current server-owned tools and schemas
  status                        Call buildmaster_status with {}
  job                           Call buildmaster_job with {} (compact result)
  call TOOL --json-file PATH     Call a named tool with an explicit JSON object
  call TOOL --json-file -        Read that JSON object from stdin
  call TOOL                     Read that JSON object from piped stdin
  mcp                           Serve persistent MCP over stdin/stdout

Options may appear before or after the command. Default port: 8765.
Discovery: CNC_MAP_RUNTIME_DIR/agent-<port>.json, or ROOT/.runtime/cnc-map.
Machine requests need browser approval. No raw URLs, commands or automatic retries.
`;

function parseArguments(argv) {
  const options = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (['--connection', '--port', '--json-file'].includes(arg)) {
      const key = { '--connection': 'connection', '--port': 'port', '--json-file': 'jsonFile' }[arg];
      if (options[key] !== undefined || !argv[i + 1] || argv[i + 1].startsWith('--')) fail('usage', 'Option requires one value and must not be repeated.');
      options[key] = argv[++i];
    } else if (arg.startsWith('-')) fail('usage', 'Unsupported option. Use --help.');
    else positional.push(arg);
  }
  const [command, tool] = positional;
  if (!['tools', 'status', 'job', 'call', 'mcp'].includes(command)
      || positional.length !== (command === 'call' ? 2 : 1)
      || (command !== 'call' && options.jsonFile !== undefined)) fail('usage', 'Invalid command or arguments. Use --help.');
  return { ...options, command, tool };
}

async function readArguments(filename) {
  if (filename && filename !== '-') return parseJson(await boundedFile(filename, LIMITS.arguments));
  if (process.stdin.isTTY) fail('usage', 'Supply --json-file PATH or pipe a JSON object into stdin.');
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += Buffer.byteLength(chunk);
    if (size > LIMITS.arguments) fail('input_too_large', 'JSON input exceeds the size limit.');
    chunks.push(Buffer.from(chunk));
  }
  return parseJson(Buffer.concat(chunks).toString('utf8'));
}

export async function main(argv = process.argv.slice(2)) {
  let bridge;
  let mcp = argv.includes('mcp');
  try {
    if (!argv.length || (argv.length === 1 && ['--help', '-h'].includes(argv[0]))) {
      process.stdout.write(HELP);
      return;
    }
    const options = parseArguments(argv);
    bridge = new AgentBridge(options);
    mcp = options.command === 'mcp';
    if (mcp) {
      const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: LIMITS.stdio });
      const handle = serveStdio(() => createMcpServer(bridge), {
        transport, onerror: () => process.stderr.write('MCP transport error.\n'),
      });
      const close = () => { void handle.close(); };
      process.stdin.once('end', close);
      process.once('SIGTERM', close);
      process.once('SIGINT', close);
      return handle;
    }
    const result = options.command === 'tools' ? await bridge.tools()
      : await bridge.call(options.command === 'status' ? 'buildmaster_status'
        : options.command === 'job' ? 'buildmaster_job' : options.tool,
      options.command === 'call' ? await readArguments(options.jsonFile) : {});
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.error) process.exitCode = 1;
  } catch (error) {
    const result = bridge ? bridge.errorResult(error)
      : failure(error instanceof BridgeError ? error.code : 'bridge_error', error instanceof BridgeError ? error.message : 'Agent bridge failed.');
    (mcp ? process.stderr : process.stdout).write(`${JSON.stringify(result)}\n`);
    process.exitCode = 1;
  }
}
