/** Passive evidence helpers. No UGS connection, commands, sender or resume API.
 * Callers must pin the selected source independently. Stop samples must come from
 * newly received controller-status events, never repeated cached HTTP snapshots.
 */
export function selectedSourceComments(source) {
  if (typeof source !== 'string') throw new TypeError('Source must be text');
  return new Set(source.split(/\r?\n/).filter(line =>
    !/[\x00-\x08\x0b-\x1f\x7f]/.test(line) &&
    /^(?:\s*;[^\r\n]*|\s*(?:\([^()\r\n]*\)\s*)+(?:;[^\r\n]*)?)$/.test(line)));
}

export function isSelectedSourceComment(command, comments) {
  return command != null && typeof command.command === 'string' &&
    command.command.trim() === '' && typeof command.originalCommand === 'string' &&
    comments instanceof Set && comments.has(command.originalCommand);
}

const axes = ['x', 'y', 'z'];
function positionValid(position) {
  return position?.units === 'MM' && axes.every(axis => Number.isFinite(position[axis]));
}
function stationaryStatus(status) {
  return status && ['HOLD', 'IDLE'].includes(status.state) && status.feedSpeed === 0 &&
    positionValid(status.machineCoord) && positionValid(status.workCoord);
}
function samePosition(a, b, tolerance) {
  return ['machineCoord', 'workCoord'].every(frame => axes.every(axis =>
    Math.abs(a[frame][axis] - b[frame][axis]) <= tolerance));
}

/** Pure evaluation of consecutive newly received status events after a stop request.
 * sequence is a strictly increasing event counter in one uninterrupted observer;
 * observedAtMs is its monotonic reception time, using the same clock as nowMs.
 * A software acknowledgement is not a sample. Neither result proves physical stop.
 */
export function stationaryStopEvidence(samples, {
  nowMs, requestedAtMs, minSamples = 3, minDurationMs = 500,
  maxAgeMs = 1500, toleranceMM = .005,
} = {}) {
  if (![nowMs, requestedAtMs, minDurationMs, maxAgeMs, toleranceMM].every(Number.isFinite) ||
      nowMs < requestedAtMs || minDurationMs <= 0 || maxAgeMs <= 0 || toleranceMM < 0 ||
      !Number.isInteger(minSamples) || minSamples < 2 || !Array.isArray(samples))
    throw new TypeError('Invalid stop-evidence parameters');
  let consecutive = [], previous = null, latestValid = false;
  for (const sample of samples) {
    const valid = sample && Number.isSafeInteger(sample.sequence) && sample.sequence >= 0 &&
      Number.isFinite(sample.observedAtMs) && sample.observedAtMs > requestedAtMs &&
      sample.observedAtMs <= nowMs && (!previous ||
        (sample.sequence > previous.sequence && sample.observedAtMs > previous.observedAtMs &&
         sample.observedAtMs - previous.observedAtMs <= maxAgeMs));
    latestValid = Boolean(valid);
    if (!valid) { consecutive = []; previous = sample; continue; }
    previous = sample;
    if (!stationaryStatus(sample.status)) { consecutive = []; continue; }
    if (consecutive.length && !samePosition(consecutive[0].status, sample.status, toleranceMM))
      consecutive = [];
    consecutive.push(sample);
  }
  const last = samples.at(-1);
  const fresh = latestValid && last && Number.isFinite(last.observedAtMs) && last.observedAtMs > requestedAtMs &&
    last.observedAtMs <= nowMs && nowMs - last.observedAtMs <= maxAgeMs;
  const speed = fresh ? last.status?.spindleSpeed : undefined;
  const accessories = fresh ? last.status?.accessoryStates : undefined;
  // UGS may report zero speed while its spindle accessory remains enabled.
  // Older versions expose only CW; an absent CCW flag is not off evidence.
  const spindleReportedOff = speed > 0 && Number.isFinite(speed) ||
    accessories?.spindleCW === true || accessories?.spindleCCW === true ? false :
    speed === 0 && accessories?.spindleCW === false && accessories?.spindleCCW === false ? true : null;
  const durationMs = consecutive.length ? consecutive.at(-1).observedAtMs - consecutive[0].observedAtMs : 0;
  const controllerStationaryVerified = Boolean(fresh && consecutive.length >= minSamples && durationMs >= minDurationMs);
  return {
    controllerStationaryVerified, spindleReportedOff,
    spindleSpeedReportedZero: Number.isFinite(speed) && speed >= 0 ? speed === 0 : null,
    spindleCWReported: typeof accessories?.spindleCW === 'boolean' ? accessories.spindleCW : null,
    spindleCCWReported: typeof accessories?.spindleCCW === 'boolean' ? accessories.spindleCCW : null,
    samples: consecutive.length, durationMs,
    state: fresh ? last.status?.state ?? null : null,
    reason: !fresh ? 'status_stale_or_missing' : controllerStationaryVerified ?
      'consecutive_stationary_controller_reports' : 'stationary_evidence_incomplete',
    physicalStopVerified: false,
  };
}

/** Observe only; the socket is supplied for an offline fake-socket regression test. */
export async function observeRunDiagnostics(socket, {
  durationMs = 10000, now = () => performance.now(), comments = new Set(),
} = {}) {
  if (!Number.isFinite(durationMs) || durationMs < 1 || durationMs > 60000)
    throw new TypeError('Observation duration must be 1–60000 ms');
  const requestedAtMs = now();
  let sequence = 0, samples = [], error = null, expectedCommentEvents = 0, unknownEmptyCommandEvents = 0;
  const message = raw => {
    try {
      const event = JSON.parse(String(raw).replace(/"([abc])"\s*:\s*NaN(?=\s*[,}])/g, '"$1":null'));
      if (event.eventType === 'ControllerStatusEvent') {
        samples.push({sequence:sequence++, observedAtMs:now(), status:event.event?.status});
        samples = samples.slice(-128);
      } else if (event.eventType === 'ControllerStateEvent') {
        const change = event.event;
        if (!['HOLD','IDLE'].includes(change?.state) ||
            (change.previousState !== undefined && !['HOLD','IDLE','RUN'].includes(change.previousState))) samples = [];
      } else if (event.eventType === 'CommandEvent' && event.event?.commandEventType === 'COMMAND_SENT') {
        const command = event.event.command;
        if (isSelectedSourceComment(command, comments)) expectedCommentEvents++;
        else {
          samples = []; // Require new reports after another command, including unknown input.
          if (!command || typeof command.command !== 'string' || command.command.trim() === '') unknownEmptyCommandEvents++;
        }
      } else if (event.eventType === 'AlarmEvent') samples = [];
    } catch { error = 'malformed_event'; samples = []; }
  };
  const failed = () => { error = 'event_connection_failed'; samples = []; };
  const closed = () => { error = 'event_connection_closed'; samples = []; };
  socket.on('message', message); socket.on('error', failed); socket.on('close', closed);
  await new Promise(resolve => setTimeout(resolve, durationMs));
  socket.off('message', message); socket.off('error', failed); socket.off('close', closed);
  const result = stationaryStopEvidence(error ? [] : samples, {requestedAtMs, nowMs:now()});
  return {...result, observerError:error, expectedCommentEvents, unknownEmptyCommandEvents,
    sourceCommentsChecked:comments.size > 0};
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node scripts/ugs_run_diagnostics.mjs [--seconds 10] [--source FILE --sha256 HEX]\nRead-only event observation. Exit 0: fresh stationary controller reports and spindle reported off; exit 2: unverified. Never requests a stop or resume.');
    return;
  }
  const options = {};
  for (let i=0;i<args.length;i+=2) {
    if (!['--seconds','--source','--sha256'].includes(args[i]) || args[i+1] === undefined || args[i] in options)
      throw new Error('Invalid arguments; use --help');
    options[args[i]]=args[i+1];
  }
  const seconds = Number(options['--seconds'] ?? 10);
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 60) throw new Error('Seconds must be 1–60');
  if (Boolean(options['--source']) !== Boolean(options['--sha256'])) throw new Error('Source and SHA-256 are required together');
  let comments = new Set();
  if (options['--source']) {
    const {readFileSync, statSync} = await import('node:fs');
    const {createHash} = await import('node:crypto');
    if (!/^[a-f0-9]{64}$/.test(options['--sha256'])) throw new Error('Invalid SHA-256');
    if (statSync(options['--source']).size > 64*1024*1024) throw new Error('Source exceeds 64 MiB');
    const source=readFileSync(options['--source']);
    if (createHash('sha256').update(source).digest('hex') !== options['--sha256']) throw new Error('Source SHA-256 mismatch');
    comments=selectedSourceComments(source.toString('utf8'));
  }
  // The shared JS configuration helper permits demo defaults. Diagnostics must
  // instead validate the explicitly selected real profile before any connection.
  const {execFileSync} = await import('node:child_process');
  const {fileURLToPath} = await import('node:url');
  const configScript = fileURLToPath(new URL('./surface_config.py', import.meta.url));
  let configuration;
  try {
    configuration = JSON.parse(execFileSync(process.env.PYTHON || 'python3', [configScript],
      {encoding:'utf8', stdio:['ignore','pipe','pipe'], timeout:10000}));
  } catch (error) {
    throw new Error(error.stderr?.toString().trim() || 'Machine configuration could not be validated');
  }
  const socketUrl = `ws://127.0.0.1:${configuration.ugsPort}/ws/v1/events`;
  const {default:WebSocket} = await import('ws');
  const socket = new WebSocket(socketUrl);
  // terminate() can emit an error when the connection has not opened yet.
  socket.on('error', () => {});
  try {
    const result=await observeRunDiagnostics(socket,{durationMs:seconds*1000,comments});
    console.log(JSON.stringify(result,null,2));
    process.exitCode=result.controllerStationaryVerified && result.spindleReportedOff === true ? 0 : 2;
  } finally { socket.terminate(); }
}

// Importing the pure functions never loads configuration or opens a connection.
const {pathToFileURL} = await import('node:url');
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode=1; });
}
