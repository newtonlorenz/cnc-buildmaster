// Controller reports are evidence, not acknowledgements of a physical stop.
export function machineStatusEvidence(state, online) {
  if (!state || state.offline || state.demo) return null;
  const report = state.controllerReport;
  const status = report?.status;
  const fresh = online && state.phase !== 'stopped' && report?.fresh === true && Number.isFinite(report.ageMs) && report.ageMs >= 0 && report.ageMs <= 3000;
  const override = status?.overrides?.feed;
  const feed = Number.isFinite(override) && override > 0 ? override : null;
  const hold = typeof status?.state === 'string' && status.state.startsWith('HOLD');
  return {
    fresh,
    controller: status?.state ? `${fresh ? 'UGS report' : 'Last UGS report'}: ${status.state}` : 'Controller report unavailable',
    feed: feed === null ? 'Feed override unknown' : `${fresh ? 'Feed override' : 'Last feed override'} ${feed}%`,
    nonDefaultFeed: feed !== null && feed !== 100,
    notice: state.phase === 'stopped'
      ? 'Session ended; physical stop unverified.' + (hold ? ' HOLD may leave the spindle running.' : '')
      : hold ? 'HOLD reported; the spindle may still run. An acknowledged pause request is not a verified stop.'
      : !fresh ? 'Live machine monitoring is inactive or stale. Check status and overrides in UGS.' : null,
  };
}
