/** Read-only interpretation of the runner's records. This never creates a height map. */
export interface SurfaceMeasurement {
  x?: unknown;
  y?: unknown;
  contactZ?: unknown;
  spread?: unknown;
  simulated?: boolean;
  [key: string]: unknown;
}
export interface SurfaceResultsState {
  sessionId?: string;
  apiVersion?: number;
  phase?: string;
  demo?: boolean;
  offline?: boolean;
  busy?: boolean;
  preparationClosed?: boolean;
  continuityActive?: boolean;
  scanStarted?: number;
  probeMode?: string;
  area?: unknown;
  planId?: string;
  plan?: {
    grid?: { x?: unknown[]; y?: unknown[]; spacing?: number };
    probe?: { repeatTolerance?: number; driftTolerance?: number };
    [key: string]: unknown;
  };
  route?: { points?: { x?: unknown; y?: unknown }[] };
  measurements?: SurfaceMeasurement[];
  result?: {
    path?: string;
    summary?: Record<string, unknown>;
    acceptedHashes?: Record<string, string>;
  };
  mapSource?: unknown;
  handoff?: { verified?: boolean; sha256?: string; [key: string]: unknown };
}

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const axis = (values: unknown[] | undefined) =>
  values?.length &&
  values.every(finite) &&
  new Set(values).size === values.length
    ? [...values].sort((a, b) => a - b)
    : [];

export function summariseSurface(state: SurfaceResultsState | null) {
  const measurements = state?.measurements ?? [];
  const xs = axis(state?.plan?.grid?.x);
  const ys = axis(state?.plan?.grid?.y);
  const expectedGrid = xs.length && ys.length ? xs.length * ys.length : null;
  const route = state?.route?.points ?? [];
  const seen = new Set<string>();
  const samples = measurements.map((record, index) => {
    const coordinate = `${record.x},${record.y}`;
    const inGrid =
      finite(record.x) &&
      finite(record.y) &&
      xs.includes(record.x) &&
      ys.includes(record.y);
    const isGrid =
      expectedGrid !== null &&
      index < expectedGrid &&
      inGrid &&
      !seen.has(coordinate);
    if (isGrid) seen.add(coordinate);
    // The final return is a distinct measurement at the first point, never another grid cell.
    const isReturn =
      expectedGrid !== null &&
      index === expectedGrid &&
      inGrid &&
      record.x === measurements[0]?.x &&
      record.y === measurements[0]?.y;
    const ordered =
      expectedGrid !== null &&
      route.length === expectedGrid + 1 &&
      route[index]?.x === record.x &&
      route[index]?.y === record.y;
    return {
      number: index + 1,
      record,
      kind: isGrid
        ? ("grid" as const)
        : isReturn
          ? ("return" as const)
          : ("unclassified" as const),
      ordered,
      contactZ: finite(record.contactZ) ? record.contactZ : null,
      spread:
        finite(record.spread) && record.spread >= 0 ? record.spread : null,
      relativeZ: null as number | null,
    };
  });
  const first = samples[0];
  const reference = first?.kind === "grid" ? first.contactZ : null;
  for (const sample of samples) {
    sample.relativeZ =
      reference !== null && sample.contactZ !== null
        ? sample.contactZ - reference
        : null;
  }
  const grid = samples.filter((sample) => sample.kind === "grid");
  const returnPoint =
    samples.find((sample) => sample.kind === "return") ?? null;
  const heights = grid.flatMap((sample) =>
    sample.relativeZ === null ? [] : [sample.relativeZ],
  );
  const spreads = samples.flatMap((sample) =>
    sample.spread === null ? [] : [sample.spread],
  );
  const minRelativeZ = heights.length ? Math.min(...heights) : null;
  const maxRelativeZ = heights.length ? Math.max(...heights) : null;
  const fullMeasurements =
    expectedGrid !== null &&
    measurements.length === expectedGrid + 1 &&
    grid.length === expectedGrid &&
    returnPoint !== null &&
    samples.every(
      (sample) =>
        sample.ordered && sample.contactZ !== null && sample.spread !== null,
    );
  const issues: string[] = [];
  if (measurements.length && expectedGrid === null)
    issues.push("Scan grid unavailable; sample roles cannot be confirmed.");
  if (
    expectedGrid !== null &&
    samples.some((sample) => sample.kind === "unclassified" || !sample.ordered)
  )
    issues.push(
      "Some records do not match the planned route. Inspect the original measurements.",
    );
  if (
    samples.some((sample) => sample.contactZ === null || sample.spread === null)
  )
    issues.push(
      "Some contact heights or repeat spreads are missing or invalid.",
    );
  return {
    samples,
    grid,
    returnPoint,
    xs,
    ys,
    expectedGrid,
    reference,
    minRelativeZ,
    maxRelativeZ,
    heightRange:
      minRelativeZ !== null && maxRelativeZ !== null
        ? maxRelativeZ - minRelativeZ
        : null,
    maxRepeatSpread: spreads.length ? Math.max(...spreads) : null,
    returnDrift: returnPoint?.relativeZ ?? null,
    fullMeasurements,
    complete: state?.phase === "complete" && fullMeasurements,
    simulated:
      state?.demo === true ||
      measurements.some((record) => record.simulated === true),
    issues,
  };
}

export function createSurfaceReport(
  state: SurfaceResultsState,
  generatedAt = new Date(),
) {
  const summary = summariseSurface(state);
  // An allowlist keeps credentials, arbitrary status and transport state out of the download.
  return {
    schema: "cnc-buildmaster.surface-measurement-report",
    version: 1,
    generatedAt: generatedAt.toISOString(),
    simulated: summary.simulated,
    units: "mm",
    coordinates:
      "Machine XY and contact Z; relative heights use the first grid contact Z.",
    importableAsMap: false,
    cuttingReleased: false,
    purpose:
      "Measurement evidence only. Cannot import this report as a height map. No cutting release.",
    provenance: {
      sessionId: state.sessionId ?? null,
      apiVersion: state.apiVersion ?? null,
      phase: state.phase ?? null,
      offline: state.offline === true,
      preparationClosed: state.preparationClosed ?? null,
      continuityActive: state.continuityActive ?? null,
      scanStarted: state.scanStarted ?? null,
      planId: state.planId ?? null,
      mapSource: state.mapSource ?? null,
    },
    probeMode: state.probeMode ?? null,
    area: state.area ?? null,
    plan: state.plan ?? null,
    route: state.route ?? null,
    summary: {
      complete: summary.complete,
      fullMeasurements: summary.fullMeasurements,
      gridSamples: summary.grid.length,
      expectedGridSamples: summary.expectedGrid,
      referenceContactZ: summary.reference,
      minRelativeZ: summary.minRelativeZ,
      maxRelativeZ: summary.maxRelativeZ,
      heightRange: summary.heightRange,
      maxRepeatSpread: summary.maxRepeatSpread,
      returnDrift: summary.returnDrift,
      issues: summary.issues,
    },
    sampleRoles: summary.samples.map((sample) => ({
      number: sample.number,
      kind: sample.kind,
    })),
    measurements: state.measurements ?? [],
    savedMap: state.result ?? null,
    nativeImportReceipt: state.handoff ?? null,
  };
}

export function surfaceReportFilename(
  report: ReturnType<typeof createSurfaceReport>,
) {
  return `surface-measurements-${report.simulated ? "simulated-" : ""}${report.generatedAt.replace(/[:.]/g, "-")}.json`;
}

export interface ImportAvailability {
  online: boolean;
  pending: boolean;
  dirty?: boolean;
  activeHold: unknown;
  isActive: boolean;
}

/** UX guard only. The server verifies evidence hashes, job identity and live UGS requirements. */
export function surfaceImportBlocker(
  state: SurfaceResultsState | null,
  access: ImportAvailability,
) {
  if (access.dirty)
    return "Apply or discard pending edits before importing the accepted map.";
  if (state?.offline)
    return "Offline preparation cannot import a machine map. Open Job preparation to continue.";
  if (state?.preparationClosed)
    return "Preparation closed. Continue in UGS; a new measurement needs a fresh setup.";
  if (summariseSurface(state).simulated)
    return "Simulated measurements cannot be imported into UGS.";
  if (!access.isActive)
    return "Open Surface and close any dialog before importing.";
  if (!access.online) return "Restore the local connection before importing.";
  if (access.pending || access.activeHold || state?.busy)
    return "Wait for the current operation to finish.";
  if (state?.phase !== "complete" || !state.result)
    return "Complete and accept a real scan in this setup before importing.";
  if (state.continuityActive !== true)
    return "Reference monitoring is unavailable. Start a fresh setup before importing.";
  return null;
}

export function verifiedSurfaceReceipt(state: SurfaceResultsState | null) {
  if (
    summariseSurface(state).simulated ||
    state?.offline ||
    state?.phase !== "complete" ||
    !state.result
  )
    return null;
  const receipt = state.handoff;
  // A boolean alone is not a receipt; keep the server's checksum available for inspection.
  return receipt?.verified === true &&
    typeof receipt.sha256 === "string" &&
    /^[a-f0-9]{64}$/i.test(receipt.sha256)
    ? receipt
    : null;
}
