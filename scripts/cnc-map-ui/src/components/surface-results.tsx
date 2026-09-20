import { useId, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown, Download, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  downloadFile,
  formatNumber as number,
  useWorkbench,
} from "@/workbench-context";
import {
  createSurfaceReport,
  summariseSurface,
  surfaceImportBlocker,
  surfaceReportFilename,
  verifiedSurfaceReceipt,
  type SurfaceResultsState,
} from "@/lib/surface-results";

const signed = (value: number | null) =>
  value === null ? "—" : `${value > 0 ? "+" : ""}${number(value)}`;

/** Actual grid contacts only. Empty cells stay empty; the return never overwrites sample 1. */
export function SurfaceResults({
  state,
  className = "",
}: {
  state: SurfaceResultsState;
  className?: string;
}) {
  const summary = summariseSurface(state);
  const [selected, setSelected] = useState(1);
  const buttons = useRef(new Map<number, HTMLButtonElement>());
  const detailsId = useId();
  const headingId = useId();
  const sample =
    summary.samples.find((point) => point.number === selected) ??
    summary.samples[0];
  const status = summary.complete
    ? "Complete"
    : summary.fullMeasurements && state.phase === "scan"
      ? "Awaiting acceptance"
      : "Incomplete";
  const byXY = new Map(
    summary.grid.map((point) => [`${point.record.x},${point.record.y}`, point]),
  );

  function inspectKey(
    event: KeyboardEvent<HTMLButtonElement>,
    pointNumber: number,
  ) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const index = summary.samples.findIndex(
      (point) => point.number === pointNumber,
    );
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? summary.samples.length - 1
          : ["ArrowRight", "ArrowDown"].includes(event.key)
            ? (index + 1) % summary.samples.length
            : ["ArrowLeft", "ArrowUp"].includes(event.key)
              ? (index + summary.samples.length - 1) % summary.samples.length
              : null;
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    const target = summary.samples[next].number;
    setSelected(target);
    buttons.current.get(target)?.focus();
  }

  function pointButton(point: typeof sample) {
    const value = point.relativeZ;
    const tint =
      value === null || !summary.heightRange || summary.minRelativeZ === null
        ? 4
        : 4 +
          30 *
            Math.max(
              0,
              Math.min(1, (value - summary.minRelativeZ) / summary.heightRange),
            );
    return (
      <Button
        key={point.number}
        type="button"
        variant="outline"
        ref={(node) => {
          if (node) buttons.current.set(point.number, node);
          else buttons.current.delete(point.number);
        }}
        data-result-point={point.number}
        data-result-kind={point.kind}
        aria-label={`${point.kind === "return" ? "Return check" : "Point"} ${point.number}, X ${number(point.record.x)}, Y ${number(point.record.y)}, relative height ${signed(value)} mm`}
        aria-pressed={sample?.number === point.number}
        aria-controls={detailsId}
        onClick={() => setSelected(point.number)}
        onKeyDown={(event) => inspectKey(event, point.number)}
        style={{
          backgroundColor:
            value === null
              ? undefined
              : `color-mix(in srgb, var(--primary) ${tint}%, var(--card))`,
        }}
        className="h-auto min-h-14 w-full min-w-0 flex-col gap-0.5 px-1 py-2 font-mono text-xs text-foreground tabular-nums aria-pressed:ring-2 aria-pressed:ring-ring"
      >
        <span className="font-semibold">
          {point.kind === "return" ? "R · " : ""}
          {point.number}
        </span>
        <span>{signed(value)}</span>
      </Button>
    );
  }

  return (
    <Card
      id="surfaceResults"
      className={`gap-4 rounded-none border-0 py-4 shadow-none ${className}`}
      aria-labelledby={headingId}
    >
      <CardHeader className="gap-3 px-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id={headingId} className="text-base font-semibold">
            Surface results
          </h2>
          <div className="flex flex-wrap gap-2">
            {summary.simulated && <Badge variant="outline">Simulated</Badge>}
            <Badge id="surfaceResultStatus" variant="secondary">
              {status}
            </Badge>
          </div>
        </div>
        <p className="text-xs text-muted-foreground" id="surfaceResultCount">
          {summary.grid.length} / {summary.expectedGrid ?? "unknown"} grid
          samples · return check{" "}
          {summary.returnPoint && summary.returnPoint.contactZ !== null
            ? "recorded"
            : "not recorded"}
          .
          {state.phase === "stopped"
            ? " Session stopped; results were not accepted."
            : ""}
          {summary.fullMeasurements &&
          state.phase !== "complete" &&
          state.phase !== "scan"
            ? " Session completion is not confirmed."
            : ""}
        </p>
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <dt className="text-xs text-muted-foreground">
              {summary.complete ? "Grid height range" : "Measured grid range"}
            </dt>
            <dd
              id="surfaceHeightRange"
              className="font-mono text-lg tabular-nums"
            >
              {number(summary.heightRange)} <span className="text-xs">mm</span>
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Max repeat spread</dt>
            <dd
              id="surfaceRepeatSpread"
              className="font-mono text-lg tabular-nums"
            >
              {number(summary.maxRepeatSpread)}{" "}
              <span className="text-xs">mm</span>
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Return drift</dt>
            <dd
              id="surfaceReturnDrift"
              className="font-mono text-lg tabular-nums"
            >
              {signed(summary.returnDrift)} <span className="text-xs">mm</span>
            </dd>
          </div>
        </dl>
        <p className="text-xs text-muted-foreground">
          {signed(summary.minRelativeZ)} to {signed(summary.maxRelativeZ)} mm
          relative to the first grid contact. Range excludes the return check.
          Repeat spread includes it. These values do not release cutting.
        </p>
        {typeof state.plan?.probe?.repeatTolerance === "number" && (
          <p className="text-xs text-muted-foreground">
            Recorded repeat limit: {number(state.plan.probe.repeatTolerance)} mm
            ·{" "}
            {summary.maxRepeatSpread === null
              ? "no valid readings"
              : summary.maxRepeatSpread >
                  state.plan.probe.repeatTolerance + 1e-9
                ? "exceeded"
                : "within limit for recorded samples"}
            .
          </p>
        )}
        {typeof state.plan?.probe?.driftTolerance === "number" && (
          <p className="text-xs text-muted-foreground">
            Recorded return limit: ±{number(state.plan.probe.driftTolerance)} mm
            ·{" "}
            {summary.returnDrift === null
              ? "return check unavailable"
              : Math.abs(summary.returnDrift) >
                  state.plan.probe.driftTolerance + 1e-9
                ? "exceeded"
                : "within limit"}
            .
          </p>
        )}
        {summary.issues.map((issue) => (
          <p key={issue} className="text-xs text-[var(--danger)]">
            {issue}
          </p>
        ))}
      </CardHeader>
      <CardContent className="space-y-4 px-4">
        <div>
          <h3 className="text-sm font-medium">Measured points · top view</h3>
          <p className="mb-3 text-xs text-muted-foreground">
            Each tile is one contact, with its point number and relative height
            in mm. No interpolation between points. Select a point to inspect
            it. Arrow keys follow measurement order; Home / End select the first
            / last record.
          </p>
          <div
            role="group"
            aria-label="Numbered measurement map"
            className="max-w-full overflow-x-auto pb-2"
          >
            {summary.xs.length > 0 && summary.ys.length > 0 ? (
              <div
                className="grid gap-2 p-1"
                style={{
                  gridTemplateColumns: `4.5rem repeat(${summary.xs.length}, minmax(4.5rem, 1fr))`,
                }}
              >
                <span className="self-center text-xs text-muted-foreground">
                  Y ↑ / X →
                </span>
                {summary.xs.map((x) => (
                  <span
                    key={`x-${x}`}
                    className="text-center font-mono text-xs text-muted-foreground"
                  >
                    {number(x)}
                  </span>
                ))}
                {[...summary.ys].reverse().flatMap((y) => [
                  <span
                    key={`y-${y}`}
                    className="self-center font-mono text-xs text-muted-foreground"
                  >
                    {number(y)}
                  </span>,
                  ...summary.xs.map((x) => {
                    const point = byXY.get(`${x},${y}`);
                    return point ? (
                      pointButton(point)
                    ) : (
                      <span
                        key={`${x},${y}`}
                        aria-label={`X ${number(x)}, Y ${number(y)}: not measured`}
                        className="grid min-h-14 place-items-center rounded-md border border-dashed text-xs text-muted-foreground"
                      >
                        —
                      </span>
                    );
                  }),
                ])}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                The planned grid is unavailable. Original records remain below.
              </p>
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <span>
              Negative: below sample 1 · positive: above · —: not measured
            </span>
            <span>
              Tint increases from the lowest to highest recorded grid contact.
            </span>
            <span>Grid arrangement; use XY values for exact spacing.</span>
          </div>
        </div>
        {summary.samples.some((point) => point.kind !== "grid") && (
          <div className="flex flex-wrap items-center gap-3 border-t pt-3">
            <span className="text-xs text-muted-foreground">
              Return / other records
            </span>
            {summary.samples
              .filter((point) => point.kind !== "grid")
              .map((point) => (
                <div className="w-24" key={point.number}>
                  {pointButton(point)}
                </div>
              ))}
          </div>
        )}
        <div
          id={detailsId}
          role="status"
          aria-live="polite"
          className="rounded-md border bg-muted/30 p-3 text-xs"
        >
          {sample ? (
            <>
              <p className="font-semibold">
                {sample.kind === "return"
                  ? "Return check"
                  : sample.kind === "grid"
                    ? "Grid point"
                    : "Unclassified record"}{" "}
                {sample.number}
                {sample.number === 1 ? " · height reference" : ""}
              </p>
              <p className="mt-1 font-mono tabular-nums">
                X {number(sample.record.x)} · Y {number(sample.record.y)} · ΔZ{" "}
                {signed(sample.relativeZ)} mm
              </p>
              <p className="mt-1 text-muted-foreground">
                Contact Z {number(sample.contactZ)} mm · repeat spread{" "}
                {number(sample.spread)} mm. Contact Z is the recorded second
                touch, not an average.
              </p>
            </>
          ) : (
            "No measurements recorded. A planned point is not a measured height."
          )}
        </div>
        <Button
          id="downloadSurfaceReport"
          variant="outline"
          className="h-auto max-w-full whitespace-normal py-2"
          onClick={() => {
            const report = createSurfaceReport(state);
            downloadFile(
              surfaceReportFilename(report),
              JSON.stringify(report, null, 2),
            );
          }}
        >
          <Download />
          Download measurement report
        </Button>
        <p className="text-xs text-muted-foreground">
          Timestamped JSON evidence. Includes session, plan and original
          readings. Cannot be imported as a map. No cutting release.
        </p>
        <Collapsible className="border-t pt-2">
          <CollapsibleTrigger asChild>
            <Button
              variant="ghost"
              className="h-auto w-full justify-between whitespace-normal px-0 text-left"
            >
              Original measurement details
              <ChevronDown />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-3">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Record</TableHead>
                  <TableHead>X / Y (mm)</TableHead>
                  <TableHead>Contact Z (mm)</TableHead>
                  <TableHead>Spread (mm)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {summary.samples.map((point) => (
                  <TableRow key={point.number}>
                    <TableCell>
                      {point.number} · {point.kind}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {number(point.record.x)} / {number(point.record.y)}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {number(point.contactZ)}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {number(point.spread)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="mt-2 text-xs text-muted-foreground">
              Machine coordinates{summary.simulated ? " · simulated" : ""}. The
              JSON report retains both touch records and timestamps where the
              runner supplies them.
            </p>
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  );
}

/** Reusable in Surface or the Job guide. Import stays explicit and uses the existing guarded client. */
export function SurfaceImportAction({
  active,
  id = "surfaceImport",
}: {
  active: boolean;
  id?: string;
}) {
  const { state, client, call, online, pending, activeHold, modalOpen, dirty } =
    useWorkbench();
  const access = {
    online,
    pending,
    dirty,
    activeHold,
    isActive: active && !modalOpen,
  };
  const blocker = surfaceImportBlocker(state, access);
  const receipt = verifiedSurfaceReceipt(state);
  const helpId = useId();
  return (
    <div className="space-y-3">
      <Button
        id={id}
        variant="outline"
        className="h-auto min-h-9 w-full whitespace-normal py-2"
        disabled={!!blocker}
        aria-describedby={helpId}
        onClick={() => {
          const fresh = client.getSnapshot();
          if (
            fresh.state?.sessionId !== state?.sessionId ||
            surfaceImportBlocker(fresh.state, { ...access, ...fresh })
          )
            return;
          void call("surface-import");
        }}
      >
        <Upload />
        Import accepted map into UGS
      </Button>
      <p id={helpId} className="text-xs text-muted-foreground">
        {blocker ??
          "Requires the updated UGS extension, an open empty AutoLeveler and no selected cutting file. Keep this connection, tool and workholding unchanged. The server checks the accepted map before importing."}
      </p>
      <p
        id={`${id}Receipt`}
        role="status"
        className="text-xs text-muted-foreground"
      >
        {receipt
          ? "Native map import verified by server readback. Compensation was not applied. Material Z and physical reference continuity remain unverified."
          : "No verified native import receipt in this setup. Import does not apply compensation or release cutting."}
      </p>
      {receipt && (
        <Collapsible>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" className="h-auto px-0 text-xs">
              Import receipt
              <ChevronDown />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="whitespace-pre-wrap break-all font-mono text-xs">
              {JSON.stringify(receipt, null, 2)}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}

/** Explicitly release the reference observer. This is not a cutting or physical verification action. */
export function SurfaceFinishAction({
  active,
  id = "finishPreparation",
}: {
  active: boolean;
  id?: string;
}) {
  const { state, client, call, online, pending, activeHold, modalOpen, dirty } =
    useWorkbench();
  const locked =
    !active ||
    modalOpen ||
    !online ||
    pending ||
    !!activeHold ||
    !!state?.busy ||
    !!state?.offline ||
    state?.phase !== "complete" ||
    state?.continuityActive !== true ||
    !!state?.preparationClosed;
  const helpId = useId();
  return (
    <div className="space-y-3 border-t pt-3">
      {state?.preparationClosed ? (
        <p
          id={id === "finishPreparation" ? "preparationClosed" : `${id}Closed`}
          role="status"
          className="text-muted-foreground"
        >
          Preparation closed. Continue in UGS; a new measurement needs a fresh
          setup.
        </p>
      ) : (
        <>
          <p id={helpId} className="text-xs text-muted-foreground">
            Save/export what you need first. This ends Buildmaster’s reference
            monitoring so you can load and review files in UGS.
          </p>
          <Button
            id={id}
            className="h-auto min-h-9 w-full whitespace-normal py-2"
            disabled={locked}
            aria-describedby={helpId}
            onClick={() => {
              const fresh = client.getSnapshot();
              if (
                locked ||
                !fresh.online ||
                fresh.pending ||
                fresh.activeHold ||
                fresh.state?.busy ||
                fresh.state?.offline ||
                fresh.state?.sessionId !== state?.sessionId ||
                fresh.state?.phase !== "complete" ||
                fresh.state?.continuityActive !== true ||
                fresh.state?.preparationClosed
              )
                return;
              void call("handoff-finish");
            }}
          >
            Finish preparation in UGS
          </Button>
        </>
      )}
    </div>
  );
}
