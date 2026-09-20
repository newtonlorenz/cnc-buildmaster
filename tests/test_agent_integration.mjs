import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {mkdtemp, realpath, rm, readFile, writeFile, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {ROOT} from '../scripts/agent_bridge.mjs';
const exec = promisify(execFile);
const source = 'G21 G90 G17 G94 G54\nM5\nG0 X5 Y5 Z3\nM3 S500\nG1 Z-0.1 F5\nG1 X15 F50\nY15\nX5\nY5\nG0 Z3\nM5\nM2\n';

test('real CLI and MCP prepare a disposable offline Python job, with no browser owner or machine I/O', {timeout:30000}, async t => {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'buildmaster-agent-integration-'));
  const runtime = path.join(root, 'runtime');
  const launcher = "import sys; from pathlib import Path; sys.path.insert(0,'scripts'); import surface_config; surface_config.ROOT=Path(sys.argv.pop(1)); import cnc_map_web; cnc_map_web.main()";
  const server = spawn('python3', ['-c', launcher, root, '--offline', '--agent-prepare', '--port', '0'], {
    cwd:ROOT, env:{...process.env,CNC_MAP_RUNTIME_DIR:runtime}, stdio:['ignore','pipe','pipe'],
  });
  let browserLink, connectionPath, client, transport;
  t.after(async () => {
    if(client) await client.close();
    if(transport) await transport.close();
    if(server.exitCode===null){const stopped=once(server,'exit');server.kill('SIGTERM');await stopped;}
    if(connectionPath)await assert.rejects(stat(connectionPath),{code:'ENOENT'});
    await rm(root,{recursive:true,force:true});
  });
  const port = await new Promise((resolve,reject)=>{
    let pending='';const timer=setTimeout(()=>reject(Error('Isolated offline startup timed out')),10000);
    server.once('exit',()=>{clearTimeout(timer);reject(Error('Isolated offline server exited before startup'));});
    server.stdout.on('data',chunk=>{pending+=chunk;const match=pending.match(/Open (http:\/\/127\.0\.0\.1:(\d+)\/#[A-Za-z0-9_-]+)/);if(match){clearTimeout(timer);browserLink=match[1];resolve(Number(match[2]));}});
  });
  connectionPath = path.join(runtime, `agent-${port}.json`);
  const discovery=JSON.parse(await readFile(connectionPath,'utf8'));
  async function cli(args){
    const {stdout,stderr}=await exec(path.join(ROOT,'cnc-agent'),['--connection',connectionPath,...args],{cwd:tmpdir(),timeout:10000,maxBuffer:3_000_000});
    assert.equal(stderr,'');assert.equal(stdout.includes(discovery.token),false);
    assert.equal(stdout.includes(browserLink.split('#')[1]),false);
    return JSON.parse(stdout);
  }
  const capabilities=await cli(['tools']);assert.equal(capabilities.tools.length,6);
  const observed=await cli(['status']);assert.equal(observed.state.mode,'offline');assert.equal(observed.heartbeatRenewed,false);
  assert.equal(observed.state.agent.prepareEnabled,true);assert.equal(observed.state.armed,false);
  const initial=await cli(['job']);assert.equal(initial.job.operations.length,0);
  const args={action:'pcb-import',parameters:{files:[{name:'fixture.nc',source}]},sessionId:initial.sessionId,pcbRevision:initial.job.revision,requestId:'integration-import-01'};
  const input=path.join(root,'import.json');await writeFile(input,JSON.stringify(args));
  const imported=await cli(['call','buildmaster_prepare','--json-file',input]);assert.equal(imported.status,'completed');
  assert.deepEqual(await cli(['call','buildmaster_prepare','--json-file',input]),imported);
  const job=await cli(['job']);assert.equal(job.job.operations.length,1);assert.equal(job.job.canExport,false);
  assert.equal('source' in job.job.operations[0],false);assert.equal('paths' in job.job.operations[0],false);
  transport=new StdioClientTransport({command:path.join(ROOT,'cnc-agent'),args:['mcp','--connection',connectionPath],cwd:tmpdir(),stderr:'pipe'});
  client=new Client({name:'buildmaster-integration-test',version:'1'});
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length,6);
  const saved=await client.callTool({name:'buildmaster_prepare',arguments:{action:'pcb-save',parameters:{},sessionId:job.sessionId,pcbRevision:job.job.revision,requestId:'integration-save-01'}});
  assert.equal(saved.isError,false);assert.equal(saved.structuredContent.status,'completed');
  const savedPath=saved.structuredContent.result.savedPath;
  assert.ok(savedPath.startsWith(path.join(root,'data','offline-preparation')));
  const pkg=JSON.parse(await readFile(savedPath,'utf8'));assert.equal(pkg.files[0].source,source);assert.equal(pkg.executionReleased,false);
  const rejected=await client.callTool({name:'buildmaster_prepare',arguments:{...args,requestId:'integration-stale-01'}});
  assert.equal(rejected.isError,true);assert.equal(rejected.structuredContent.error.code,'STALE');
  // Observation/preparation did not acquire the browser lease: a fresh browser can own it immediately.
  const response=await fetch(`http://127.0.0.1:${port}/api/state`,{headers:{Authorization:`Bearer ${browserLink.split('#')[1]}`,'X-Client-ID':'integration-browser'}});
  assert.equal(response.status,200);assert.equal((await response.json()).mode,'offline');
});
