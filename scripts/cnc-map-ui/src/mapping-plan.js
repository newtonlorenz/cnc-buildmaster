// View-only grid arithmetic. The server still validates and authorises every plan.
const round = n => Math.round(n * 1000) / 1000;
export function gridAxis(lo, hi, spacing) {
  if (![lo, hi, spacing].every(Number.isFinite) || spacing < .1 || spacing > hi - lo)
    throw Error('Use spacing from 0.1 mm up to the shorter side.');
  if ([lo, hi, spacing].some(n => Math.abs(n * 1000 - Math.round(n * 1000)) > 1e-6))
    throw Error('Use at most three decimal places.');
  const count = Math.floor((hi - lo) / spacing + 1e-9);
  if (count > 99) throw Error('Increase spacing: each axis can have at most 100 points.');
  const values = Array.from({length: count + 1}, (_, i) => round(lo + i * spacing));
  const tail = hi - values.at(-1);
  if (tail > .0005) {
    if (tail < .1 - 1e-9) throw Error('The final interval is under 0.1 mm. Choose another spacing.');
    values.push(round(hi));
  }
  if (values.length > 100) throw Error('Increase spacing: each axis can have at most 100 points.');
  return values;
}
export function previewGrid(area, spacing, position) {
  if (!area) return null;
  try {
    const x = gridAxis(...area.x, spacing), y = gridAxis(...area.y, spacing);
    if (x.length * y.length > 2500) throw Error('Increase spacing: a map can have at most 2,500 points.');
    const startsHere = !!position && x.includes(round(position.x)) && y.includes(round(position.y));
    return {grid: {x, y, spacing}, points: x.length * y.length, placements: x.length * y.length + 1, startsHere};
  } catch (e) { return {error: e.message}; }
}
export function gridChoices(area) {
  if (!area) return [];
  const side = Math.min(...['x', 'y'].map(a => area[a][1] - area[a][0]));
  return [{label:'Wide', divisions:2}, {label:'Medium', divisions:4}, {label:'Close', divisions:8}].map(option => {
    // Avoid an invalid sub-0.1 mm boundary interval when rounding a preset.
    let spacing = Math.max(.1, Math.floor(side / option.divisions * 1000) / 1000);
    let draft = previewGrid(area, spacing);
    for (let i=0; draft?.error && i<100 && spacing>.1; i++) {
      spacing = round(spacing - .001); draft = previewGrid(area, spacing);
    }
    return {...option, spacing, draft};
  });
}
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const n = Math.max(0, Math.floor(seconds));
  return n < 60 ? `${n}s` : n < 3600 ? `${Math.floor(n/60)}m ${n%60}s` : `${Math.floor(n/3600)}h ${Math.floor(n%3600/60)}m`;
}
