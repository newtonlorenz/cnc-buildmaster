import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { AgentBridge, ROOT, LIMITS, checkPrivateFile, createMcpServer } from '../scripts/agent_bridge.mjs';

const objectSchema = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const mutationFields = {
  action: { type: 'string', enum: ['set_stock'] }, parameters: { type: 'object' },
  sessionId: { type: 'string', minLength: 1 }, pcbRevision: { type: 'integer', minimum: 0 },
  requestId: { type: 'string', minLength: 1 },
};
const tools = () => [
  ['buildmaster_status', objectSchema(), true],
  ['buildmaster_job', objectSchema({ includePaths: { const: false } }), true],
  ['buildmaster_prepare', objectSchema(mutationFields, Object.keys(mutationFields)), false],
  ['buildmaster_request_action', objectSchema({ ...mutationFields, action: { enum: ['capture_corner'] }, reason: { type: 'string', minLength: 1 } }, [...Object.keys(mutationFields), 'reason']), false],
  ['buildmaster_request_status', objectSchema({ requestId: { type: 'string' } }, ['requestId']), true],
  ['buildmaster_stop', objectSchema({ reason: { type: 'string', minLength: 1 } }, ['reason']), false],
].map(([name, inputSchema, readOnlyHint]) => ({ name, description: `Mock ${name}`, inputSchema,
  annotations: { readOnlyHint, destructiveHint: !readOnlyHint, idempotentHint: readOnlyHint, openWorldHint: false } }));
const sampleMutation = () => ({ action: 'set_stock', parameters: { width: 40 }, sessionId: 'session-supplied', pcbRevision: 7, requestId: 'request-supplied' });

async function backendTools() {
  const { stdout } = await promisify(execFile)('python3', ['-B', '-c',
    'import json, sys; sys.path.insert(0, "scripts"); from agent_api import TOOLS; print(json.dumps(TOOLS))'], { cwd: ROOT });
  return JSON.parse(stdout);
}

function packageCall(bytes) {
  const args = { ...sampleMutation(), action: 'pcb-load', parameters: { package: { padding: '' } } };
  const overhead = Buffer.byteLength(JSON.stringify({ name: 'buildmaster_prepare', arguments: args }));
  // Include multibyte content: the boundary must count UTF-8 bytes, not characters.
  const remaining = bytes - overhead;
  args.parameters.package.padding = 'é'.repeat(Math.floor(remaining / 2)) + 'x'.repeat(remaining % 2);
  return args;
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'buildmaster-agent-test-'));
  const state = { requests: [], calls: [], capabilities: { protocolVersion: 1, instanceId: 'mock-instance', tools: tools() },
    result: { sessionId: 'session-supplied', pcbRevision: 7, mode: 'offline' },
    token: randomBytes(32).toString('hex'), callStatus: 200 };
  const server = http.createServer(async (request, response) => {
    state.requests.push({ method: request.method, url: request.url, headers: request.headers });
    response.setHeader('content-type', 'application/json');
    if (request.headers.authorization !== `Bearer ${state.token}`) {
      response.writeHead(401).end(JSON.stringify({ error: { code: 'unauthorised', message: 'Bad credential', retryable: false } }));
      return;
    }
    if (request.url === '/api/agent/capabilities' && request.method === 'GET') {
      if (state.capabilitiesHandler) { state.capabilitiesHandler(request, response); return; }
      response.end(JSON.stringify(state.capabilities));
      return;
    }
    if (request.url === '/api/agent/call' && request.method === 'POST') {
      let text = '';
      for await (const chunk of request) text += chunk;
      const call = JSON.parse(text);
      state.calls.push(call);
      if (state.callHandler) { state.callHandler(request, response, call); return; }
      response.writeHead(state.callStatus).end(JSON.stringify(state.result));
      return;
    }
    response.writeHead(404).end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const connection = path.join(directory, `agent-${port}.json`);
  state.discovery = { protocolVersion: 1, instanceId: state.capabilities.instanceId, pid: process.pid, apiBase: `http://127.0.0.1:${port}`, token: state.token };
  state.save = (data = state.discovery, filename = connection) => writeFile(filename, JSON.stringify(data), { mode: 0o600 });
  await state.save();
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return Object.assign(state, { connection, directory, port, server, bridge: new AgentBridge({ connection }) });
}

async function cli(args, { input, env = {} } = {}) {
  const child = spawn(path.join(ROOT, 'cnc-agent'), args, { cwd: tmpdir(), env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
  child.stdin.end(input);
  try {
    const [code, signal] = await once(child, 'close');
    assert.equal(signal, null, stderr);
    return { code, stdout, stderr };
  } finally { clearTimeout(timeout); }
}

test('private discovery, authenticated typed calls, exact caller IDs and compact reads', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.bridge.tools()).tools, f.capabilities.tools);
  assert.deepEqual(await f.bridge.call('buildmaster_status'), f.result);
  await f.bridge.call('buildmaster_job');
  const args = sampleMutation();
  await f.bridge.call('buildmaster_prepare', args);
  assert.deepEqual(f.calls, [
    { name: 'buildmaster_status', arguments: {} }, { name: 'buildmaster_job', arguments: {} },
    { name: 'buildmaster_prepare', arguments: args },
  ]);
  assert.deepEqual(args, sampleMutation());
  assert.ok(f.requests.every(request => ['/api/agent/capabilities', '/api/agent/call'].includes(request.url)));
  assert.ok(f.requests.every(request => request.headers.authorization === `Bearer ${f.token}`));
  assert.ok(f.requests.every(request => !request.headers.cookie));
});

test('missing IDs, invalid actions and additional fields fail before a mutation', async t => {
  const f = await fixture(t);
  for (const key of ['sessionId', 'pcbRevision', 'requestId']) {
    const args = sampleMutation();
    delete args[key];
    assert.equal((await f.bridge.call('buildmaster_prepare', args)).error.code, 'invalid_arguments');
  }
  for (const args of [null, [], 'raw', { ...sampleMutation(), action: 'raw_command' }, { ...sampleMutation(), approve: true }]) {
    assert.equal((await f.bridge.call('buildmaster_prepare', args)).error.code, 'invalid_arguments');
  }
  assert.equal((await f.bridge.call('buildmaster_job', { includePaths: true })).error.code, 'invalid_arguments');
  assert.equal(f.calls.length, 0);
  const before = f.requests.length;
  for (const name of ['raw_command', 'buildmaster_approve', 'buildmaster_readinessreply', 'buildmaster_hold', 'buildmaster_spindle', 'http://127.0.0.1/api/state']) {
    assert.equal((await f.bridge.call(name)).error.code, 'unknown_tool');
  }
  assert.equal(f.requests.length, before);
});

test('discovery rejects public files, symlinks, directories, wrong owner and oversized data', async t => {
  const f = await fixture(t);
  for (const mode of [0o644, 0o640, 0o666]) {
    await chmod(f.connection, mode);
    assert.equal((await new AgentBridge({ connection: f.connection }).call('buildmaster_status')).error.code, 'unsafe_connection');
  }
  await chmod(f.connection, 0o600);
  const link = path.join(f.directory, 'connection-link.json');
  await symlink(f.connection, link);
  assert.equal((await new AgentBridge({ connection: link }).call('buildmaster_status')).error.code, 'unsafe_file');
  const dirLink = path.join(f.directory, 'directory-link');
  await symlink(f.directory, dirLink);
  assert.equal((await new AgentBridge({ connection: path.join(dirLink, path.basename(f.connection)) }).call('buildmaster_status')).error.code, 'unsafe_connection');
  assert.equal((await new AgentBridge({ connection: f.directory }).call('buildmaster_status')).error.code, 'unsafe_file');
  assert.throws(() => checkPrivateFile({ isFile: () => true, uid: 999, mode: 0o600, size: 100 }, 998), { code: 'unsafe_connection' });
  await writeFile(f.connection, 'x'.repeat(LIMITS.discovery + 1));
  assert.equal((await new AgentBridge({ connection: f.connection }).call('buildmaster_status')).error.code, 'unsafe_connection');
  assert.equal(f.requests.length, 0);
});

test('connection rejects non-loopback URLs, URL components, invalid protocol and selected-port mismatch', async t => {
  const f = await fixture(t);
  for (const apiBase of ['https://127.0.0.1:8765', 'http://localhost:8765', 'http://127.1:8765', 'http://2130706433:8765',
    'http://example.com:8765', 'http://127.0.0.1:8765/path', 'http://127.0.0.1:8765/', 'http://127.0.0.1:8765?x=1', 'http://user@127.0.0.1:8765', 'http://127.0.0.1:8765#x']) {
    await f.save({ ...f.discovery, apiBase });
    assert.equal((await new AgentBridge({ connection: f.connection }).call('buildmaster_status')).error.code, 'invalid_connection');
  }
  for (const changes of [{ protocolVersion: 2 }, { pid: 0 }, { instanceId: '' }, { token: [f.token, 'injected-header'].join('\r\n') }]) {
    await f.save({ ...f.discovery, ...changes });
    assert.equal((await new AgentBridge({ connection: f.connection }).call('buildmaster_status')).error.code, 'invalid_connection');
  }
  await f.save();
  const differentPort = f.port === 8765 ? 8766 : 8765;
  assert.equal((await new AgentBridge({ connection: f.connection, port: differentPort }).call('buildmaster_status')).error.code, 'port_mismatch');
  assert.equal(f.requests.length, 0);
});

test('instance and protocol are verified on each call; restart never silently reconnects', async t => {
  const f = await fixture(t);
  for (const update of [{ instanceId: 'another-instance' }, { protocolVersion: 2 }]) {
    const bridge = new AgentBridge({ connection: f.connection });
    const original = structuredClone(f.capabilities);
    Object.assign(f.capabilities, update);
    assert.equal((await bridge.call('buildmaster_prepare', sampleMutation())).error.code, 'instance_mismatch');
    f.capabilities = original;
  }
  await f.bridge.call('buildmaster_status');
  f.capabilities.instanceId = 'restarted';
  await f.save({ ...f.discovery, instanceId: 'restarted' });
  assert.equal((await f.bridge.call('buildmaster_prepare', sampleMutation())).error.code, 'instance_mismatch');
  assert.equal(f.calls.length, 1);
});

test('backend errors and conflicts remain structured and are never retried', async t => {
  const f = await fixture(t);
  for (const [status, code] of [[403, 'preparation_disabled'], [409, 'revision_conflict'], [409, 'request_conflict'], [423, 'operator_required']]) {
    f.callStatus = status;
    f.result = { error: { code, message: `Mock ${code}`, retryable: false, requestId: 'request-supplied', currentRevision: 9 } };
    assert.deepEqual(await f.bridge.call('buildmaster_prepare', sampleMutation()), f.result);
  }
  assert.equal(f.calls.length, 4);
});

test('backend failure records and legacy HTTP string errors are tool errors; dispatched stays an acknowledgement', async t => {
  const f = await fixture(t);
  f.result = { requestId: 'request-supplied', status: 'failed', error: { code: 'FAILED', message: 'Mock failure', retryable: false } };
  assert.deepEqual(await f.bridge.call('buildmaster_prepare', sampleMutation()), f.result);
  f.callStatus = 400;
  f.result = { error: `Malformed request ${f.token}` };
  assert.deepEqual(await f.bridge.call('buildmaster_status'), { error: { code: 'http_error', message: 'Malformed request [REDACTED]', retryable: false } });
  f.callStatus = 200;
  f.result = { requestId: 'request-supplied', status: 'dispatched' };
  assert.deepEqual(await f.bridge.call('buildmaster_request_status', { requestId: 'request-supplied' }), f.result);
});

test('authoritative Python tool schemas pass through unchanged and validate action-specific parameters', async t => {
  const f = await fixture(t);
  f.capabilities.tools = await backendTools();
  assert.deepEqual((await f.bridge.tools()).tools, f.capabilities.tools);
  for (const [name, args] of [
    ['buildmaster_status', {}], ['buildmaster_job', {}],
    ['buildmaster_prepare', { ...sampleMutation(), action: 'pcb-example', parameters: {} }],
    ['buildmaster_request_action', { ...sampleMutation(), action: 'capture', parameters: { corner: 'front-left' }, reason: 'Operator review requested' }],
    ['buildmaster_request_status', { requestId: 'request-supplied' }],
    ['buildmaster_stop', { reason: 'Operator requested stop' }],
  ]) assert.deepEqual(await f.bridge.call(name, args), f.result);
  assert.equal(f.calls.length, 6);
  const invalid = await f.bridge.call('buildmaster_prepare', { ...sampleMutation(), action: 'pcb-import', parameters: {} });
  assert.equal(invalid.error.code, 'invalid_arguments');
  assert.equal(f.calls.length, 6);
});

test('redirects on discovery and mutation are refused without following or retrying', async t => {
  const f = await fixture(t);
  const redirect = (_request, response) => response.writeHead(307, { location: `http://127.0.0.1:${f.port}/credential-sink` }).end();
  f.capabilitiesHandler = redirect;
  assert.equal((await f.bridge.call('buildmaster_status')).error.code, 'redirect_refused');
  f.capabilitiesHandler = undefined;
  f.callHandler = redirect;
  assert.equal((await f.bridge.call('buildmaster_prepare', sampleMutation())).error.code, 'redirect_refused');
  assert.equal(f.calls.length, 1);
  assert.ok(f.requests.every(request => !request.url.includes('credential-sink')));
});

test('responses and errors cannot expose the bearer token', async t => {
  const f = await fixture(t);
  f.result = { token: f.token, nested: { message: `Bearer ${f.token}`, authorization: `Bearer ${f.token}`, [f.token]: f.token } };
  const result = await f.bridge.call('buildmaster_status');
  assert.ok(!JSON.stringify(result).includes(f.token));
  assert.equal(result.token, '[REDACTED]');
  f.callStatus = 403;
  f.result = { error: { code: 'denied', message: `Denied ${f.token}`, retryable: false } };
  const output = await cli(['--connection', f.connection, 'status']);
  assert.equal(output.code, 1);
  assert.ok(!`${output.stdout}${output.stderr}`.includes(f.token));
  assert.match(output.stdout, /REDACTED/);
  f.capabilitiesHandler = (_request, response) => response.end(`not-json ${f.token}`);
  assert.ok(!JSON.stringify(await f.bridge.call('buildmaster_status')).includes(f.token));
});

test('malformed, oversized and timed-out responses fail without retry', async t => {
  const f = await fixture(t);
  f.capabilitiesHandler = (_request, response) => response.end('invalid');
  assert.equal((await f.bridge.call('buildmaster_status')).error.code, 'invalid_json');
  f.capabilitiesHandler = (_request, response) => response.end(JSON.stringify({ padding: 'x'.repeat(LIMITS.response) }));
  assert.equal((await f.bridge.call('buildmaster_status')).error.code, 'response_too_large');
  f.capabilitiesHandler = undefined;
  f.result = { error: { code: 'bad', message: 'retry me', retryable: true } };
  assert.equal((await f.bridge.call('buildmaster_status')).error.code, 'invalid_response');
  f.callHandler = () => {};
  const bridge = new AgentBridge({ connection: f.connection, timeoutMs: 80 });
  assert.equal((await bridge.call('buildmaster_prepare', sampleMutation())).error.code, 'request_timeout');
  assert.equal(f.calls.length, 2);
});

test('tool discovery remains server-owned and rejects unrecognised additions', async t => {
  const f = await fixture(t);
  f.capabilities.tools[2].inputSchema.properties.action.enum.push('new_preparation');
  assert.deepEqual((await f.bridge.tools()).tools, f.capabilities.tools);
  await f.bridge.call('buildmaster_prepare', { ...sampleMutation(), action: 'new_preparation' });
  assert.equal(f.calls.length, 1);
  f.capabilities.tools = f.capabilities.tools.filter(tool => tool.name !== 'buildmaster_prepare');
  assert.equal((await f.bridge.call('buildmaster_prepare', sampleMutation())).error.code, 'unavailable_tool');
  f.capabilities.tools.push({ name: 'buildmaster_raw', description: 'No', inputSchema: objectSchema(), annotations: {} });
  await assert.rejects(f.bridge.tools(), { code: 'invalid_capabilities' });
});

test('CLI supports schemas, status, job, explicit JSON file, stdin and runtime/port selection', async t => {
  const f = await fixture(t);
  for (const command of ['tools', 'status', 'job']) {
    const output = await cli([command, '--port', String(f.port)], { env: { CNC_MAP_RUNTIME_DIR: f.directory } });
    assert.equal(output.code, 0, output.stdout + output.stderr);
    assert.deepEqual(JSON.parse(output.stdout), command === 'tools' ? f.capabilities : f.result);
    assert.equal(output.stderr, '');
  }
  const jsonFile = path.join(f.directory, 'arguments.json');
  await writeFile(jsonFile, JSON.stringify(sampleMutation()));
  const file = await cli(['call', 'buildmaster_prepare', '--json-file', jsonFile, '--connection', f.connection]);
  assert.equal(file.code, 0, file.stdout);
  for (const extra of [[], ['--json-file', '-']]) {
    const stdin = await cli(['--connection', f.connection, 'call', 'buildmaster_prepare', ...extra], { input: JSON.stringify(sampleMutation()) });
    assert.equal(stdin.code, 0, stdin.stdout);
  }
  assert.deepEqual(f.calls.slice(-3), Array.from({ length: 3 }, () => ({ name: 'buildmaster_prepare', arguments: sampleMutation() })));
});

test('CLI rejects missing, oversized, malformed JSON and raw options without reaching HTTP', async t => {
  const f = await fixture(t);
  for (const [args, input] of [
    [['call', 'buildmaster_prepare'], ''], [['call', 'buildmaster_prepare'], '{broken'],
    [['call', 'buildmaster_prepare'], 'x'.repeat(LIMITS.arguments + 1)],
    [['status', '--url', 'http://example.com'], undefined], [['status', '--json-file', f.connection], undefined],
    [['call', 'buildmaster_prepare', '--json-file', path.join(f.directory, 'missing.json')], undefined],
  ]) {
    const result = await cli(['--connection', f.connection, ...args], { input });
    assert.equal(result.code, 1);
    assert.ok(JSON.parse(result.stdout).error);
    assert.equal(result.stderr, '');
  }
  assert.equal(f.requests.length, 0);
});

test('CLI accepts 4 MB CAM imports and an exact 24,000,000-byte request, but rejects one byte over', async t => {
  const f = await fixture(t);
  f.capabilities.tools = await backendTools();
  const jsonFile = path.join(f.directory, 'large-import.json');
  const source = ';' + 'x'.repeat(3_999_999);
  const args = { ...sampleMutation(), action: 'pcb-import', parameters: { files: [{ name: 'large.nc', source }] } };
  await writeFile(jsonFile, JSON.stringify(args));
  const imported = await cli(['--connection', f.connection, 'call', 'buildmaster_prepare', '--json-file', jsonFile]);
  assert.equal(imported.code, 0, imported.stdout + imported.stderr);
  assert.equal(f.calls[0].arguments.parameters.files[0].source, source);

  const exact = await cli(['--connection', f.connection, 'call', 'buildmaster_prepare'], { input: JSON.stringify(packageCall(24_000_000)) });
  assert.equal(exact.code, 0, exact.stdout + exact.stderr);
  assert.equal(Number(f.requests.filter(request => request.method === 'POST').at(-1).headers['content-length']), 24_000_000);
  const oversized = await cli(['--connection', f.connection, 'call', 'buildmaster_prepare'], { input: JSON.stringify(packageCall(24_000_001)) });
  assert.equal(oversized.code, 1, oversized.stdout);
  assert.equal(JSON.parse(oversized.stdout).error.code, 'input_too_large');
  assert.equal(f.calls.length, 2);

  await writeFile(jsonFile, 'x'.repeat(24_000_001));
  const requestsBefore = f.requests.length;
  const oversizedFile = await cli(['--connection', f.connection, 'call', 'buildmaster_prepare', '--json-file', jsonFile]);
  assert.equal(oversizedFile.code, 1);
  assert.equal(JSON.parse(oversizedFile.stdout).error.code, 'input_too_large');
  assert.equal(f.requests.length, requestsBefore);
});

test('explicit full geometry remains subject to the compact response budget', async t => {
  const f = await fixture(t);
  f.capabilities.tools = await backendTools();
  f.result = { paths: 'x'.repeat(2 * 1024 * 1024) };
  const result = await f.bridge.call('buildmaster_job', { includePaths: true });
  assert.equal(result.error.code, 'response_too_large');
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].arguments, { includePaths: true });
});

test('HTTP bypasses all proxy environment variables even when Node proxy support is enabled', async t => {
  const f = await fixture(t);
  const proxyCalls = [];
  const proxy = http.createServer((request, response) => { proxyCalls.push(request.url); response.writeHead(502).end(); });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => proxy.close(resolve)));
  const url = `http://127.0.0.1:${proxy.address().port}`;
  const result = await cli(['--connection', f.connection, 'status'], { env: {
    NODE_USE_ENV_PROXY: '1', HTTP_PROXY: url, HTTPS_PROXY: url, ALL_PROXY: url,
    http_proxy: url, https_proxy: url, all_proxy: url, NO_PROXY: '', no_proxy: '',
  } });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.deepEqual(proxyCalls, []);
  assert.equal(f.calls.length, 1);
});

test('SDK in-memory transport lists dynamic schemas and returns structured tool errors', async t => {
  const f = await fixture(t);
  const server = createMcpServer(f.bridge);
  const client = new Client({ name: 'bridge-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  assert.deepEqual((await client.listTools()).tools, f.capabilities.tools);
  assert.equal(client.getServerCapabilities().tools.listChanged, true);
  const result = await client.callTool({ name: 'buildmaster_status', arguments: {} });
  assert.deepEqual(result.structuredContent, f.result);
  assert.equal(result.isError, false);
  const error = await client.callTool({ name: 'buildmaster_prepare', arguments: {} });
  assert.equal(error.isError, true);
  assert.equal(error.structuredContent.error.code, 'invalid_arguments');
  let changed = 0;
  client.setNotificationHandler('notifications/tools/list_changed', () => { changed++; });
  f.capabilities.tools[0].description = 'Updated by the backend';
  assert.deepEqual((await client.listTools()).tools, f.capabilities.tools);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(changed, 1);
  f.result = { error: { code: 'revision_conflict', message: 'Mock conflict', retryable: false } };
  f.callStatus = 409;
  const conflict = await client.callTool({ name: 'buildmaster_prepare', arguments: sampleMutation() });
  assert.equal(conflict.isError, true);
  assert.deepEqual(conflict.structuredContent, f.result);
  f.callStatus = 200;
  f.result = { status: 'failed', requestId: 'request-supplied', error: { code: 'FAILED', message: 'Mock failure', retryable: false } };
  const failed = await client.callTool({ name: 'buildmaster_prepare', arguments: sampleMutation() });
  assert.equal(failed.isError, true);
  assert.deepEqual(failed.structuredContent, f.result);
});

for (const mode of ['legacy', { pin: '2026-07-28' }]) {
  test(`actual executable stdio MCP lifecycle (${JSON.stringify(mode)}) uses SDK transport`, { timeout: 15000 }, async t => {
    const f = await fixture(t);
    const transport = new StdioClientTransport({ command: path.join(ROOT, 'cnc-agent'), args: ['mcp', '--connection', f.connection], stderr: 'pipe', cwd: tmpdir() });
    let stderr = '';
    transport.stderr.on('data', chunk => { stderr += chunk; });
    const client = new Client({ name: 'stdio-test', version: '1' }, { versionNegotiation: { mode } });
    t.after(async () => { await client.close(); await transport.close(); });
    await client.connect(transport);
    assert.equal(client.getServerVersion().name, 'cnc-buildmaster');
    assert.deepEqual((await client.listTools()).tools, f.capabilities.tools);
    for (const name of ['buildmaster_status', 'buildmaster_job']) {
      const result = await client.callTool({ name, arguments: {} });
      assert.deepEqual(result.structuredContent, f.result);
      assert.equal(result.isError, false);
    }
    f.result = { error: { code: 'operator_required', message: `Mock ${f.token}`, retryable: false } };
    f.callStatus = 403;
    const error = await client.callTool({ name: 'buildmaster_prepare', arguments: sampleMutation() });
    assert.equal(error.isError, true);
    assert.equal(error.structuredContent.error.code, 'operator_required');
    assert.ok(!JSON.stringify(error).includes(f.token));
    assert.equal(stderr, '');
    assert.equal(f.calls.length, 3);
    f.capabilities.tools = await backendTools();
    f.result = { status: 'completed', requestId: 'request-supplied' };
    f.callStatus = 200;
    const large = await client.callTool({ name: 'buildmaster_prepare', arguments: packageCall(24_000_000) });
    assert.equal(large.isError, false);
    assert.deepEqual(large.structuredContent, f.result);
    assert.equal(Number(f.requests.filter(request => request.method === 'POST').at(-1).headers['content-length']), 24_000_000);
    const oversized = await client.callTool({ name: 'buildmaster_prepare', arguments: packageCall(24_000_001) });
    assert.equal(oversized.isError, true);
    assert.equal(oversized.structuredContent.error.code, 'input_too_large');
    assert.equal(f.calls.length, 4);
    assert.equal(stderr, '');
    await client.close();
  });
}
