import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const script = fileURLToPath(new URL('./surface_config.py', import.meta.url));
let cached;
export function getConfig() {
  return cached ??= JSON.parse(execFileSync(process.env.PYTHON || 'python3', [script, '--demo'], {encoding:'utf8'}));
}
export const apiBase = `http://127.0.0.1:${getConfig().ugsPort}/api/v1/`;
export const socketUrl = `ws://127.0.0.1:${getConfig().ugsPort}/ws/v1/events`;
