/** Real gateway + browser approval, in a disposable demo server and private runtime.
 * Builds source into a temporary asset directory; never edits the checked-in bundle.
 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build } from '../scripts/cnc-map-ui/node_modules/esbuild/lib/main.js';
import { observeTransport, openUtility, closeUtility } from './workbench_browser_helpers.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ui = path.join(repo, 'scripts/cnc-map-ui');
const root = await mkdtemp(path.join(tmpdir(), 'buildmaster-agent-browser-'));
const runtime = path.join(root, 'runtime');
const assets = path.join(root, 'assets');
const screenshots = path.join(repo, 'output/design-review/agents');
await mkdir(screenshots, { recursive: true });
let browser, server, page;
let serverErrors = '';

// A replacement must reset local fields even when its content/revision hint is
// unchanged. Apply that generation only after the matching geometry arrives.
async function checkReplacementGeneration() {
  const compiled = await build({ entryPoints: [path.join(ui, 'src/lib/machine-client.ts')], bundle: true, format: 'esm', platform: 'node', write: false });
  const { MachineClient } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
  const original = globalThis.fetch;
  let generation = 0, releaseJob;
  globalThis.fetch = async (url) => {
    if (url === '/api/state') return Response.json({ apiVersion: 7, sessionId: 'isolated-session', pcbRevision: 1, phase: 'setup', agent: { prepareEnabled: true, jobGeneration: generation, requests: [] } });
    if (url === '/api/pcb') {
      if (generation) await new Promise(resolve => { releaseJob = resolve; });
      return Response.json({ revision: 1, name: generation ? 'Replacement' : 'Original' });
    }
    throw Error('Unexpected request in generation check');
  };
  const client = new MachineClient('fixture-only', 'fixture-client');
  try {
    await client.poll(); await client.refreshJob();
    generation = 1;
    await client.poll();
    assert.equal(client.getSnapshot().jobGeneration, 0);
    assert.equal(client.getSnapshot().job.name, 'Original');
    releaseJob(); await client.refreshJob();
    assert.equal(client.getSnapshot().jobGeneration, 1);
    assert.equal(client.getSnapshot().job.name, 'Replacement');
    await client.poll();
    assert.equal(client.getSnapshot().jobGeneration, 1, 'Polling must not repeatedly reset fields');
    assert.equal(await client.call('arm', { confirmed: true }), false, 'Preparation must also guard client transport');
  } finally { client.dispose(); globalThis.fetch = original; }
}

try {
  await checkReplacementGeneration();
  await mkdir(runtime, { mode: 0o700 });
  await mkdir(assets);
  const config = JSON.parse(await readFile(path.join(repo, 'config/example.json'), 'utf8'));
  config.dataDir = path.join(root, 'jobs-data');
  const configPath = path.join(root, 'demo-config.json');
  await writeFile(configPath, JSON.stringify(config));
  await copyFile(path.join(repo, 'scripts/cnc-map-web/index.html'), path.join(assets, 'index.html'));
  await build({ absWorkingDir: ui, entryPoints: ['src/app.tsx'], bundle: true, format: 'iife', target: 'es2022', outfile: path.join(assets, 'app.bundle.js') });
  execFileSync(process.execPath, ['node_modules/@tailwindcss/cli/dist/index.mjs', '-i', 'src/styles.css', '-o', path.join(assets, 'app.css'), '--minify'], { cwd: ui, stdio: 'pipe' });
  const launcher = "import sys; from pathlib import Path; sys.path.insert(0,'scripts'); import cnc_map_web; cnc_map_web.ASSETS=Path(sys.argv.pop(1)); cnc_map_web.main()";
  server = spawn('python3', ['-c', launcher, assets, '--demo', '--port', '0'], {
    cwd: repo, env: { ...process.env, CNC_MAP_RUNTIME_DIR: runtime, CNC_BUILDMASTER_CONFIG: configPath }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', chunk => { serverErrors = (serverErrors + chunk).slice(-4000); });
  const url = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(Error('Disposable demo did not start within 15 seconds')), 15000);
    server.stdout.on('data', chunk => {
      output = (output + chunk).slice(-4000);
      const match = output.match(/Open (http:\S+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    server.once('error', error => { clearTimeout(timer); reject(error); });
    server.once('exit', () => { clearTimeout(timer); reject(Error('Disposable demo exited before startup')); });
  });
  const port = new URL(url).port;
  assert.notEqual(port, '8765');
  // Credentials stay in this test process, never injected into browser context.
  const connection = JSON.parse(await readFile(path.join(runtime, `agent-${port}.json`), 'utf8'));
  assert.equal(connection.apiBase, `http://127.0.0.1:${port}`);
  async function tool(name, args = {}) {
    const response = await fetch(connection.apiBase + '/api/agent/call', {
      method: 'POST', headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, arguments: args }), signal: AbortSignal.timeout(10000),
    });
    const result = await response.json();
    assert.equal(response.ok, true, result.error?.message ?? 'Tool HTTP request failed');
    assert.equal(result.error, undefined, result.error?.message);
    return result;
  }
  async function mutate(name, action, parameters = {}, reason = 'Inspect the bounded demo action.') {
    const { state } = await tool('buildmaster_status');
    const args = { action, parameters, requestId: crypto.randomUUID(), sessionId: state.sessionId, pcbRevision: state.pcbRevision };
    if (name === 'buildmaster_request_action') args.reason = reason;
    return tool(name, args);
  }
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(10000);
  const errors = [], writes = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error' && /Content Security Policy|Refused to/.test(message.text())) errors.push(message.text()); });
  page.on('request', request => {
    if (request.method() === 'POST') writes.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() });
  });
  await observeTransport(page);
  await page.goto(url);
  await page.waitForFunction(() => window.testTransport.state?.agent && window.testTransport.job);
  assert.equal(await page.evaluate(() => window.testTransport.state.agent.prepareEnabled), false);
  assert.equal(await page.getByRole('dialog').count(), 0);

  // Existing local drafts block granting the editing lease.
  await page.locator('#pcbTab').click();
  await page.locator('#pcbName').fill('Unapplied browser draft');
  await openUtility(page, 'Agent access');
  assert.equal(await page.locator('#agentPrepare').isDisabled(), true);
  await closeUtility(page);
  await page.getByRole('button', { name: 'Discard setup edits', exact: true }).click();
  await openUtility(page, 'Agent access');
  await page.locator('#agentPrepare').click();
  await page.waitForFunction(() => window.testTransport.state.agent.prepareEnabled && !window.testTransport.pending);
  await closeUtility(page);
  assert.equal(await page.locator('#mainWorkspace').evaluate(element => element.inert), true);
  const writesBeforeNav = writes.length;
  for (const tab of ['guide', 'pcb', 'tools', 'surface']) {
    await page.locator(`#${tab}Tab`).click();
    assert.equal(await page.locator(`#${tab}Tab`).getAttribute('data-active'), 'true');
  }
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('Enter');
  assert.equal(writes.length, writesBeforeNav, 'Locked workspaces must not edit or move by keyboard');
  const example = await mutate('buildmaster_prepare', 'pcb-example');
  assert.equal(example.status, 'completed');
  await page.waitForFunction(() => window.testTransport.state.agent.jobGeneration === 1 && window.testTransport.job?.name === 'Rectangle example');
  const preparedJob = (await tool('buildmaster_job')).job;
  const settings = Object.fromEntries(['name', 'boardRevision', 'face', 'stock', 'placement', 'tolerance'].map(key => [key, preparedJob[key]]));
  settings.name = 'Prepared by local agent';
  assert.equal((await mutate('buildmaster_prepare', 'pcb-configure', { settings })).status, 'completed');
  const focusBeforeRequest = await page.evaluate(() => document.activeElement.id);
  const queuedDuringLease = await mutate('buildmaster_request_action', 'arm');
  await page.getByRole('button', { name: /Review requests/ }).waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0, 'Requests must not open a popup or steal focus');
  assert.equal(await page.evaluate(() => document.activeElement.id), focusBeforeRequest);
  await page.getByRole('button', { name: /Review requests/ }).click();
  let row = page.locator(`[data-request-id="${queuedDuringLease.requestId}"]`);
  assert.equal(await row.getByRole('button', { name: 'Approve', exact: true }).isDisabled(), true);
  await row.getByRole('button', { name: 'Reject', exact: true }).click();
  await row.getByTestId('request-status').filter({ hasText: 'rejected' }).waitFor();
  await closeUtility(page);
  await page.getByRole('button', { name: 'Pause agent editing', exact: true }).click();
  await page.waitForFunction(() => !window.testTransport.state.agent.prepareEnabled && !window.testTransport.pending);
  assert.equal(await page.locator('#mainWorkspace').evaluate(element => element.inert), false);
  await page.locator('#pcbTab').click();
  assert.equal(await page.locator('#pcbName').inputValue(), 'Prepared by local agent');
  assert.equal(await page.locator('#pcbName').isEnabled(), true);

  // Enable simulated teaching through the existing human controls.
  await page.locator('#surfaceTab').click();
  await page.locator('#attest').check(); await page.locator('#arm').click();
  await page.waitForFunction(() => window.testTransport.state.armed && !window.testTransport.pending);
  const startX = (await tool('buildmaster_status')).state.status.machineCoord.x;
  const request = await mutate('buildmaster_request_action', 'jog', { axis: 'x', delta: 1, speed: 'slow' }, '<img src=x onerror="window.agentInjected=true"> Inspect this text; move X by 1 mm in simulation.');
  await page.getByRole('button', { name: /Review requests/ }).waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal((await tool('buildmaster_status')).state.status.machineCoord.x, startX);
  await page.getByRole('button', { name: /Review requests/ }).click();
  row = page.locator(`[data-request-id="${request.requestId}"]`);
  assert.equal(await page.locator('#agentPrepare').isDisabled(), true, 'Armed teaching cannot grant an editing lease');
  assert.match(await row.getByLabel('Exact action parameters').textContent(), /"delta": 1/);
  assert.equal(await row.locator('img').count(), 0, 'Reason text must never become HTML');
  await page.screenshot({ path: path.join(screenshots, 'operator-review-desktop.png') });
  const approve = row.getByRole('button', { name: 'Approve', exact: true });
  assert.equal(await approve.isDisabled(), true);
  await row.getByRole('checkbox', { name: 'I inspected the machine and clearance for this exact action.' }).check();
  assert.equal(await approve.isEnabled(), true);
  const decisionCount = () => writes.filter(write => write.path === '/api/agent-decide' && write.body.requestId === request.requestId).length;
  await approve.focus();
  await approve.dispatchEvent('keydown', { key: 'Enter', repeat: true, bubbles: true, cancelable: true });
  assert.equal(decisionCount(), 0, 'A repeated keydown must not record approval');
  await page.keyboard.press('Enter');
  await row.getByTestId('request-status').filter({ hasText: 'Submitted' }).waitFor();
  await page.waitForFunction(x => !window.testTransport.state.busy && window.testTransport.state.status.machineCoord.x === x, startX + 1);
  assert.equal(decisionCount(), 1);
  assert.match(await row.textContent(), /Submission does not confirm completion/);
  assert.equal((await tool('buildmaster_request_status', { requestId: request.requestId })).status, 'dispatched');
  assert.equal(writes.find(write => write.path === '/api/agent-decide' && write.body.requestId === request.requestId).body.operatorConfirmed, true);
  await closeUtility(page);

  // Rejection needs no physical checkbox and sends no movement.
  const rejected = await mutate('buildmaster_request_action', 'jog', { axis: 'x', delta: -1, speed: 'slow' });
  await page.locator('#pcbTab').click();
  await page.locator('#pcbName').fill('Unapplied edit while a request is pending');
  await openUtility(page, 'Agent access');
  row = page.locator(`[data-request-id="${rejected.requestId}"]`);
  assert.equal(await row.getByRole('button', { name: 'Approve', exact: true }).isDisabled(), true);
  assert.equal(await row.getByRole('checkbox').isDisabled(), true);
  await row.getByRole('button', { name: 'Reject', exact: true }).click();
  await row.getByTestId('request-status').filter({ hasText: 'rejected' }).waitFor();
  assert.equal(writes.find(write => write.body.requestId === rejected.requestId).body.operatorConfirmed, false);
  assert.equal((await tool('buildmaster_status')).state.status.machineCoord.x, startX + 1);
  await closeUtility(page);
  await page.getByRole('button', { name: 'Discard setup edits', exact: true }).click();
  await page.locator('#surfaceTab').click();

  // Same revision/session, changed pose: the real server must refuse the old action.
  const stale = await mutate('buildmaster_request_action', 'jog', { axis: 'x', delta: 1, speed: 'slow' });
  await page.locator('[data-axis="y"][data-sign="1"]').click();
  await page.waitForFunction(() => !window.testTransport.pending && !window.testTransport.state.busy && window.testTransport.state.status.machineCoord.y === 1);
  await openUtility(page, 'Agent access');
  row = page.locator(`[data-request-id="${stale.requestId}"]`);
  await row.getByRole('checkbox').check();
  await row.getByRole('button', { name: 'Approve', exact: true }).click();
  await row.getByTestId('request-status').filter({ hasText: 'stale' }).waitFor();
  assert.match(await row.textContent(), /changed|fresh action/i);
  assert.equal((await tool('buildmaster_status')).state.status.machineCoord.x, startX + 1);
  await closeUtility(page);

  // HTTP failures remain visible and must not become an optimistic success.
  const failed = await mutate('buildmaster_request_action', 'jog', { axis: 'x', delta: 1, speed: 'slow' });
  await openUtility(page, 'Agent access');
  row = page.locator(`[data-request-id="${failed.requestId}"]`);
  await page.route('**/api/agent-decide', route => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Isolated decision failure; no action submitted.' }) }), { times: 1 });
  await row.getByRole('checkbox').check();
  await row.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.getByRole('dialog').getByText('Isolated decision failure; no action submitted.', { exact: true }).waitFor();
  assert.equal(await row.getByTestId('request-status').textContent(), 'pending');
  assert.equal(await row.getByRole('checkbox').isChecked(), false);
  await row.getByRole('button', { name: 'Reject', exact: true }).click();
  await row.getByTestId('request-status').filter({ hasText: 'rejected' }).waitFor();
  await closeUtility(page);

  // Narrow panel stays usable, Stop remains actionable inside the modal.
  await page.setViewportSize({ width: 390, height: 844 });
  await openUtility(page, 'Agent access');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await page.screenshot({ path: path.join(screenshots, 'operator-review-mobile.png') });
  const modalStop = page.getByRole('dialog').getByRole('button', { name: /^Stop/ });
  assert.equal(await modalStop.isVisible(), true);
  await modalStop.click();
  await page.waitForFunction(() => window.testTransport.state.phase === 'stopped' && !window.testTransport.state.armed);
  assert.ok(writes.some(write => write.path === '/api/stop'));
  await page.locator('#agentPrepare').click();
  await page.waitForFunction(() => window.testTransport.state.agent.prepareEnabled && !window.testTransport.pending);
  const stopsBeforeLease = writes.filter(write => write.path === '/api/stop').length;
  const stoppedWithLease = page.waitForResponse(response => response.url().endsWith('/api/stop') && response.request().method() === 'POST');
  await modalStop.click();
  assert.equal((await stoppedWithLease).ok(), true);
  assert.equal(writes.filter(write => write.path === '/api/stop').length, stopsBeforeLease + 1);
  assert.equal((await tool('buildmaster_status')).state.agent.prepareEnabled, false, 'Browser Stop must close the agent preparation lease');
  await page.waitForFunction(() => !window.testTransport.state.agent.prepareEnabled && !window.testTransport.pending);
  assert.equal(writes.some(write => write.path.startsWith('/api/agent/')), false, 'Browser decisions must never use the agent endpoint');
  assert.equal((await page.locator('body').innerText()).includes(connection.token), false);
  assert.equal((await page.locator('body').innerText()).includes(url.split('#')[1]), false);
  assert.deepEqual(errors, []);
  if (process.env.CNC_AGENT_SMOKE_SCREENSHOT) await page.screenshot({ path: process.env.CNC_AGENT_SMOKE_SCREENSHOT });
  console.log('Agent access passed: isolated actual gateway requests, editing lease, generation refresh, operator approval, one bounded demo jog, rejection, stale-pose refusal, visible HTTP failure, repeat-key guard, narrow layout and modal Stop. No hardware used.');
} catch (error) {
  if (page && process.env.CNC_AGENT_SMOKE_SCREENSHOT) await page.screenshot({ path: process.env.CNC_AGENT_SMOKE_SCREENSHOT });
  if (server?.exitCode != null && serverErrors) console.error(serverErrors.replace(/#[A-Za-z0-9_-]+/g, '#[redacted]'));
  throw error;
} finally {
  if (browser) await browser.close();
  if (server && server.exitCode === null) {
    await new Promise(resolve => {
      const timer = setTimeout(() => server.kill('SIGKILL'), 5000);
      server.once('exit', () => { clearTimeout(timer); resolve(); });
      server.kill('SIGTERM');
    });
  }
  await rm(root, { recursive: true, force: true });
}
