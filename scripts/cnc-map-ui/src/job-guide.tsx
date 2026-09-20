import { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  Check,
  FilePlus2,
  Layers3,
  Save,
  ScanLine,
  ChevronDown,
  Upload,
  ArrowRight,
  Circle,
  Download,
} from "lucide-react";
import {
  Plan,
  PlanHeader,
  PlanTitle,
  PlanDescription,
  PlanContent,
  PlanFooter,
} from "@/components/ai-elements/plan";
import {
  Task,
  TaskTrigger,
  TaskContent,
  TaskItem,
} from "@/components/ai-elements/task";
import {
  Queue,
  QueueItem,
  QueueItemContent,
} from "@/components/ai-elements/queue";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  SelectField,
  CheckField,
  Panel,
  Notice,
} from "@/components/workbench-controls";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import {
  SurfaceImportAction,
  SurfaceFinishAction,
} from "@/components/surface-results";
import {
  preparationChecks,
  setupSheet,
  type PreparationCheck,
} from "@/lib/job-readiness";
import { useWorkbench, downloadFile } from "./workbench-context";
const mm = (n: number) => Number(n.toFixed(3)).toString();
function Overview({ job, proposal }: { job: any; proposal: any }) {
  const { navigate } = useWorkbench();
  const stock = job.stock,
    pad = Math.max(stock.width, stock.height) * 0.1,
    x = stock.x - pad,
    y = stock.y - pad,
    w = stock.width + 2 * pad,
    h = stock.height + 2 * pad;
  let count = 0;
  const paths: React.ReactNode[] = [];
  for (const op of job.operations)
    for (const [i, p] of (op.paths || []).entries()) {
      if (p.rapid || count > 18000) continue;
      count += p.points.length;
      paths.push(
        <polyline
          key={op.id + "-" + i}
          points={p.points.map((q: number[]) => `${q[0]},${q[1]}`).join(" ")}
          fill="none"
          stroke={`var(--${op.role === "outline" ? "outline" : op.role === "drilling" ? "drilling" : "isolation"})`}
          strokeWidth="1.2"
          vectorEffect="non-scaling-stroke"
        />,
      );
    }
  return (
    <Panel
      title="Workpiece overview"
      description={`${mm(stock.width)} × ${mm(stock.height)} × ${mm(stock.thickness)} mm · ${job.face} face`}
      className="overview-panel"
      action={
        <Button variant="outline" size="sm" onClick={() => navigate("pcb")}>
          Inspect paths
          <ArrowUpRight />
        </Button>
      }
    >
      <svg
        className="overview-canvas"
        viewBox={`${x} ${y} ${w} ${h}`}
        role="img"
        aria-label="Stock, cutting paths, proposed scan rectangle and clamps"
      >
        <g transform={`translate(0 ${2 * stock.y + stock.height}) scale(1 -1)`}>
          <rect
            x={stock.x}
            y={stock.y}
            width={stock.width}
            height={stock.height}
            fill="var(--stock)"
            stroke="var(--stock-line)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
          <rect
            x={stock.x + stock.margin}
            y={stock.y + stock.margin}
            width={Math.max(0, stock.width - stock.margin * 2)}
            height={Math.max(0, stock.height - stock.margin * 2)}
            fill="none"
            stroke="var(--border)"
            strokeDasharray="3 3"
            vectorEffect="non-scaling-stroke"
          />
          {paths}
          {proposal?.area && (
            <rect
              x={proposal.area.x[0]}
              y={proposal.area.y[0]}
              width={proposal.area.x[1] - proposal.area.x[0]}
              height={proposal.area.y[1] - proposal.area.y[0]}
              fill="var(--primary)"
              fillOpacity=".05"
              stroke="var(--primary)"
              strokeDasharray="5 4"
              strokeWidth="1.3"
              vectorEffect="non-scaling-stroke"
            />
          )}
          {(job.workflow.fixture?.clamps || []).map((c: any) => (
            <rect
              key={c.id}
              x={c.x}
              y={c.y}
              width={c.width}
              height={c.height}
              fill="var(--warning-soft)"
              stroke="var(--warning)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </g>
      </svg>
      <div className="canvas-legend">
        <span>
          <i className="legend-cut" />
          Cutting paths
        </span>
        <span>
          <i className="legend-map" />
          Proposed map
        </span>
        <span>{count > 18000 ? "Simplified overview" : "Machine XY · mm"}</span>
      </div>
    </Panel>
  );
}
export function JobGuide() {
  const {
    state,
    job,
    online,
    pending,
    dirty,
    dirtyKeys,
    setDirty,
    post,
    call,
    navigate,
    section,
    openUtility,
    importFiles,
    openPackage,
    savePackage,
    jobGeneration,
    view,
  } = useWorkbench();
  const [message, setMessage] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [process, setProcess] = useState({
    material: "pcb",
    intent: "isolation",
    sourceCompensation: "unknown",
  });
  const reportDirty = useRef(setDirty);
  reportDirty.current = setDirty;
  useEffect(() => {
    if (job)
      setProcess({
        material: job.workflow.material,
        intent: job.workflow.intent,
        sourceCompensation: job.workflow.sourceCompensation,
      });
  }, [
    job?.workflow.material,
    job?.workflow.intent,
    job?.workflow.sourceCompensation,
    jobGeneration,
  ]);
  useEffect(
    () => setReviewed(false),
    [job?.guide.fingerprint, state?.sessionId],
  );
  useEffect(() => {
    if (section === "processSettings") {
      setSettingsOpen(true);
      requestAnimationFrame(() =>
        document
          .getElementById("processSettings")
          ?.scrollIntoView({ block: "nearest" }),
      );
    }
    if (section === "nativeHandoff")
      requestAnimationFrame(() =>
        document
          .getElementById("nativeHandoff")
          ?.scrollIntoView({ block: "nearest" }),
      );
  }, [section]);
  const processDirty =
    !!job &&
    Object.entries(process).some(([key, value]) => value !== job.workflow[key]);
  useEffect(
    () => reportDirty.current("guide-process", processDirty),
    [processDirty],
  );
  useEffect(() => () => reportDirty.current("guide-process", false), []);
  if (!job)
    return (
      <div className="page-scroll">
        <h1>Your workbench</h1>
        <p className="text-muted-foreground">Loading local job data…</p>
        <Skeleton className="mt-8 h-80 w-full" />
      </div>
    );
  const processLocked =
    !online ||
    pending ||
    state?.busy ||
    Object.entries(dirtyKeys).some(
      ([key, value]) => key !== "guide-process" && value,
    );
  const locked = processLocked || processDirty;
  const operations = job.operations,
    guide = job.guide,
    proposal = job.scanProposal;
  const checks = preparationChecks(job, state);
  const next = checks.find((c) => !c.complete);
  const adopt =
    !locked &&
    reviewed &&
    !state?.offline &&
    state?.phase === "teach" &&
    state.armed &&
    guide.steps[0].complete &&
    guide.steps[1].complete &&
    proposal?.area &&
    process.sourceCompensation === "none";
  const canImport =
    !locked &&
    !state?.demo &&
    !state?.offline &&
    state?.phase === "complete" &&
    !!state?.result &&
    !state?.preparationClosed;
  const run: typeof post = async (action, body = {}, receive) => {
    setMessage("");
    const ok = await post(action, body, receive);
    if (!ok)
      setMessage(
        "The action did not finish. Your job is still here; review the reported issue.",
      );
    return ok;
  };
  function openCheck(check: PreparationCheck) {
    if (check.id === "source") setSettingsOpen(true);
    navigate(check.view, check.section);
  }
  const openHandoff = () =>
    document
      .getElementById("nativeHandoff")
      ?.scrollIntoView({ block: "nearest" });
  const jobName = String(job.name || "job").replace(/[^a-zA-Z0-9_-]+/g, "-");
  return (
    <div className="page-scroll guide">
      <div className="page-heading">
        <div>
          <h1>{operations.length ? job.name : "What are you making?"}</h1>
          <p>
            {operations.length
              ? "Prepare this setup, then continue with the cut in UGS."
              : "Prepare a cutting job or go straight to measuring a surface."}
          </p>
        </div>
        {operations.length > 0 && (
          <div className="actions">
            <Button variant="outline" disabled={locked} onClick={importFiles}>
              <FilePlus2 />
              Add files
            </Button>
            <Button
              variant="outline"
              disabled={locked}
              onClick={async () => {
                if (await savePackage())
                  setMessage(
                    "Job package saved. Reopening requires fresh machine references.",
                  );
              }}
            >
              <Save />
              Save job
            </Button>
          </div>
        )}
      </div>
      {state?.offline && (
        <Notice>
          Offline preparation · Open files, check the layout and save your job.
          Machine controls are unavailable.{" "}
          <Button
            variant="link"
            className="h-auto px-1 py-0"
            onClick={() => openUtility("connection")}
          >
            Connect a machine later
          </Button>
        </Notice>
      )}
      {dirty && (
        <Notice tone="warning">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>
              You have unapplied edits. Apply or discard them before saving the
              job.
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                processDirty
                  ? setSettingsOpen(true)
                  : navigate(
                      Object.keys(dirtyKeys).some(
                        (k) => k.startsWith("surface") && dirtyKeys[k],
                      )
                        ? "surface"
                        : "pcb",
                    )
              }
            >
              Review edits
              <ArrowUpRight />
            </Button>
          </div>
        </Notice>
      )}
      {message && <Notice>{message}</Notice>}
      {!operations.length ? (
        <>
          <div className="start-workspace" data-offline={!!state?.offline}>
            <section
              className="start-measure"
              aria-labelledby="measureStartTitle"
            >
              <ScanLine className="size-7 text-primary" />
              <div>
                <h2 id="measureStartTitle">Measure a surface</h2>
                <p>
                  Map a PCB, a piece of MDF or other material. No cutting file
                  needed.
                </p>
              </div>
              <ol className="start-sequence">
                <li>Mark two opposite corners</li>
                <li>Choose the measurement spacing</li>
                <li>Place the puck and press Enter</li>
              </ol>
              <Button
                className="h-10 w-fit"
                disabled={!online || state?.offline}
                onClick={() => navigate("surface")}
              >
                {state?.phase === "complete"
                  ? "View surface results"
                  : state?.armed
                    ? "Continue surface setup"
                    : "Start surface mapping"}
                <ArrowRight />
              </Button>
              <p className="text-xs text-muted-foreground">
                Continuous PCB copper also supports an automatic route after a
                contact check.
              </p>
            </section>
            <section className="start-job" aria-labelledby="jobStartTitle">
              <FilePlus2 className="size-6 text-muted-foreground" />
              <div>
                <h2 id="jobStartTitle">Prepare a cutting job</h2>
                <p>
                  Check CAM files, fit them to your stock and line up the
                  workpiece before measuring.
                </p>
              </div>
              <div className="actions">
                <Button disabled={locked} onClick={importFiles}>
                  Add CAM files
                  <ArrowRight />
                </Button>
                <Button
                  variant="outline"
                  disabled={locked}
                  onClick={openPackage}
                >
                  Open saved job
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                G-code: .nc, .gcode, .ngc, .tap or .cnc. Convert Gerber files in
                your CAM software first.
              </p>
              <Button
                variant="link"
                className="w-fit px-0"
                disabled={locked}
                onClick={() => void run("pcb-example")}
              >
                Explore a geometry example
                <ArrowUpRight />
              </Button>
            </section>
          </div>
          {job.savedJobs?.length > 0 && (
            <Panel
              title="Recent jobs"
              description="Reopen the files and planning records. Establish fresh machine references when you return to the CNC."
            >
              <div className="divide-y">
                {job.savedJobs.slice(0, 5).map((saved: any) => (
                  <Button
                    key={saved.id}
                    variant="ghost"
                    className="h-auto w-full justify-between py-3 text-left"
                    disabled={locked}
                    onClick={async () => {
                      if (await run("pcb-load", { savedId: saved.id }))
                        navigate("guide");
                    }}
                  >
                    <span className="truncate">{saved.label}</span>
                    <ArrowRight />
                  </Button>
                ))}
              </div>
            </Panel>
          )}
          <section className="mt-6 flex flex-wrap items-center justify-between gap-4 border-t py-5">
            <div>
              <h2 className="text-sm font-semibold">
                Need a workshop calculation?
              </h2>
              <p className="text-sm text-muted-foreground">
                Clamp clearance, cutters, V-bit width, camera offsets and wood
                drafts.
              </p>
            </div>
            <Button variant="outline" onClick={() => navigate("tools")}>
              Open workshop tools
              <ArrowUpRight />
            </Button>
          </section>
          <div className="workflow-boundary">
            <span>Design &amp; CAM</span>
            <ArrowRight />
            <strong>Buildmaster · prepare &amp; measure</strong>
            <ArrowRight />
            <span>UGS · compensate &amp; cut</span>
            <Button variant="link" onClick={() => openUtility("help")}>
              How it works
            </Button>
          </div>
        </>
      ) : (
        <>
          <nav className="preparation-steps" aria-label="Preparation stages">
            {guide.steps.map((s: any, i: number) => (
              <Button
                key={s.id}
                variant="ghost"
                className="preparation-step"
                aria-current={guide.nextStep === s.id ? "step" : undefined}
                onClick={() =>
                  s.id === "handoff"
                    ? openHandoff()
                    : navigate(
                        s.id === "surface" ? "surface" : "pcb",
                        s.id === "alignment"
                          ? "pcbAlignmentSection"
                          : "pcbSetupSection",
                      )
                }
              >
                <span
                  className={
                    s.complete ? "step-number complete" : "step-number"
                  }
                >
                  {s.complete ? <Check /> : i + 1}
                </span>
                <span>{s.label}</span>
                <ArrowRight className="step-arrow" />
              </Button>
            ))}
          </nav>
          <div className="guide-body">
            <div className="guide-main">
              <Overview job={job} proposal={proposal} />
              <Panel
                title="Preparation checks"
                description="Each check links to the place where you can complete it."
                action={
                  <Badge variant="outline">
                    {checks.filter((c) => c.complete).length} / {checks.length}
                  </Badge>
                }
              >
                <ul className="preparation-checks">
                  {checks.map((c) => (
                    <li key={c.id}>
                      <span
                        className={
                          c.complete
                            ? "check-indicator complete"
                            : "check-indicator"
                        }
                      >
                        {c.complete ? <Check /> : <Circle />}
                      </span>
                      <div>
                        <strong>{c.title}</strong>
                        <p>{c.detail}</p>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Review ${c.title}`}
                        onClick={() => openCheck(c)}
                      >
                        {c.complete ? "Review" : "Set up"}
                        <ArrowUpRight />
                      </Button>
                    </li>
                  ))}
                </ul>
              </Panel>
              <Panel
                title="Operation sequence"
                description="Files stay in this order. Each cutter change needs a fresh Z reference."
                action={
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => navigate("pcb", "pcbOperationsSection")}
                  >
                    Edit
                    <ArrowUpRight />
                  </Button>
                }
              >
                <Queue className="operation-queue">
                  <ol>
                    {operations.map((op: any, i: number) => (
                      <QueueItem key={op.id} className="operation-row">
                        <span className="step-number">{i + 1}</span>
                        <div className="min-w-0 flex-1">
                          <QueueItemContent className="font-medium">
                            {op.name}
                          </QueueItemContent>
                          <p className="field-help">
                            {op.tool || "Cutter not set"}
                            {op.diameter != null
                              ? ` · Ø ${mm(op.diameter)} mm`
                              : ""}{" "}
                            · {op.role}
                          </p>
                        </div>
                        <Badge variant="secondary">
                          {i === 0
                            ? "First cutter"
                            : op.tool &&
                                op.tool === operations[i - 1].tool &&
                                op.diameter === operations[i - 1].diameter
                              ? "Same cutter"
                              : "Tool change"}
                        </Badge>
                      </QueueItem>
                    ))}
                  </ol>
                </Queue>
              </Panel>
              <Button
                variant="outline"
                className="w-fit"
                onClick={() => navigate("tools")}
              >
                Workshop tools
                <ArrowUpRight />
              </Button>
            </div>
            <aside className="guide-aside">
              <Plan defaultOpen className="next-step-plan">
                <PlanHeader>
                  <div>
                    <PlanTitle>
                      {next ? next.title : "Continue in UGS"}
                    </PlanTitle>
                    <PlanDescription>
                      {next
                        ? next.detail
                        : "Your preparation checks are recorded. Review the map, material Z and cutting paths in UGS."}
                    </PlanDescription>
                  </div>
                </PlanHeader>
                <PlanContent>
                  <Button
                    className="h-auto min-h-10 w-full whitespace-normal"
                    onClick={() =>
                      next
                        ? next.id === "files"
                          ? importFiles()
                          : openCheck(next)
                        : openHandoff()
                    }
                  >
                    {next
                      ? next.id === "files"
                        ? "Open cutting files"
                        : `Review ${next.title.toLowerCase()}`
                      : "Review UGS handoff"}
                    <ArrowRight />
                  </Button>
                  <Collapsible
                    id="processSettings"
                    open={settingsOpen}
                    onOpenChange={setSettingsOpen}
                    className="mt-5 border-t pt-2"
                  >
                    <CollapsibleTrigger asChild>
                      <Button
                        variant="ghost"
                        className="w-full justify-between px-0"
                      >
                        Material &amp; process
                        <ChevronDown />
                      </Button>
                    </CollapsibleTrigger>
                    <CollapsibleContent className="space-y-4 pt-2">
                      <SelectField
                        label="Material"
                        value={process.material}
                        disabled={processLocked}
                        onChange={(e) =>
                          setProcess({
                            ...process,
                            material: e.target.value,
                            intent:
                              e.target.value === "pcb"
                                ? "isolation"
                                : process.intent === "isolation"
                                  ? "engraving"
                                  : process.intent,
                          })
                        }
                        options={[
                          { value: "pcb", label: "PCB copper" },
                          { value: "wood", label: "Wood / MDF" },
                          { value: "plastic", label: "Plastic" },
                          { value: "other", label: "Other" },
                        ]}
                      />
                      <SelectField
                        label="Task"
                        value={process.intent}
                        disabled={processLocked}
                        onChange={(e) =>
                          setProcess({ ...process, intent: e.target.value })
                        }
                        options={[
                          { value: "isolation", label: "PCB isolation" },
                          { value: "engraving", label: "Engraving" },
                          { value: "profile", label: "Profile / outline" },
                          { value: "surfacing", label: "Surfacing" },
                        ]}
                      />
                      <SelectField
                        label="Source file compensation"
                        help="Height compensation adjusts Z to follow an uneven surface. Applying it twice can spoil the cut."
                        value={process.sourceCompensation}
                        disabled={processLocked}
                        onChange={(e) =>
                          setProcess({
                            ...process,
                            sourceCompensation: e.target.value,
                          })
                        }
                        options={[
                          { value: "unknown", label: "Not checked yet" },
                          { value: "none", label: "No height compensation" },
                          { value: "applied", label: "Already compensated" },
                        ]}
                      />
                      {processDirty && (
                        <div className="flex flex-wrap gap-2">
                          <Button
                            disabled={processLocked}
                            onClick={() =>
                              void run("pcb-workflow", { settings: process })
                            }
                          >
                            Save process settings
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={() =>
                              setProcess({
                                material: job.workflow.material,
                                intent: job.workflow.intent,
                                sourceCompensation:
                                  job.workflow.sourceCompensation,
                              })
                            }
                          >
                            Discard edits
                          </Button>
                        </div>
                      )}
                    </CollapsibleContent>
                  </Collapsible>
                </PlanContent>
                <PlanFooter className="text-xs text-muted-foreground">
                  Saved records describe the setup. They do not approve a cut.
                </PlanFooter>
              </Plan>
              <Panel
                title="Map only what you need"
                description={
                  proposal?.area
                    ? `${mm(proposal.area.x[1] - proposal.area.x[0])} × ${mm(proposal.area.y[1] - proposal.area.y[0])} mm, including cutter footprint and 1 mm margin.`
                    : proposal?.error
                }
              >
                {proposal?.area ? (
                  <div className="space-y-3">
                    <p className="text-sm text-muted-foreground">
                      {job.workflow.material === "pcb"
                        ? "Continuous copper can follow the checked route automatically. Choose a puck in Surface mapping if the surface is not continuously conductive."
                        : "Place the puck and confirm at each point. The machine retracts and moves to the next point."}
                    </p>
                    <CheckField
                      label="Every point supports the probe; the complete route clears clamps and leads."
                      checked={reviewed}
                      onCheckedChange={(v) => setReviewed(v === true)}
                      disabled={locked}
                    />
                    <Button
                      className="w-full"
                      disabled={!adopt}
                      onClick={async () => {
                        if (
                          await run("pcb-map-job", {
                            reviewed: true,
                            fingerprint: guide.fingerprint,
                            margin: 1,
                          })
                        )
                          navigate("surface");
                      }}
                    >
                      <ScanLine />
                      Use this scan area
                    </Button>
                    {!adopt && (
                      <p className="field-help">
                        {state?.offline
                          ? "Open a configured machine workspace to capture references and measure."
                          : !state?.armed || state.phase !== "teach"
                            ? "Enable a fresh setup in Surface mapping first."
                            : !guide.steps[0].complete
                              ? "Complete the file, stock and cutter checks first."
                              : !guide.steps[1].complete
                                ? "Capture and check the three alignment references first."
                                : process.sourceCompensation !== "none"
                                  ? "Confirm that the source files have no height compensation."
                                  : "Confirm support and clearance to use this area."}
                      </p>
                    )}
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => navigate("pcb")}
                  >
                    Review files &amp; stock
                    <ArrowRight />
                  </Button>
                )}
              </Panel>
              <Panel
                id="nativeHandoff"
                title="Continue in UGS"
                description="Keep preparation, map import and cutting review distinct."
              >
                <ol className="handoff-steps">
                  <li>
                    <strong>1. Export the aligned files</strong>
                    <p>
                      Review the UGS draft tab for each operation and its source
                      checks.
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => navigate("pcb", "pcbReviewSection")}
                    >
                      Review aligned draft
                      <ArrowUpRight />
                    </Button>
                  </li>
                  <li>
                    <strong>2. Import the accepted surface</strong>
                    <p>
                      {state?.handoff?.verified === true
                        ? "The last native import readback matched. Current physical continuity is still unverified."
                        : "Open an empty AutoLeveler with no cutting file selected. Import checks the actual native grid."}
                    </p>
                    <SurfaceImportAction
                      active={view === "guide" && !locked}
                      id="guideSurfaceImport"
                    />
                  </li>
                  <li>
                    <strong>3. Finish preparation here</strong>
                    <p>
                      After exporting and importing the map, end Buildmaster’s
                      monitoring before changing Z or loading cutting files in
                      UGS.
                    </p>
                    {state?.phase === "complete" && (
                      <SurfaceFinishAction
                        active={view === "guide" && !locked}
                        id="guideFinishPreparation"
                      />
                    )}
                  </li>
                  <li>
                    <strong>4. Set Z and inspect compensation in UGS</strong>
                    <p>
                      Establish material-top Z for this cutter. Check coverage
                      and apply height correction once in UGS. Remove probe
                      leads before using the spindle.
                    </p>
                  </li>
                </ol>
                <Button
                  variant="outline"
                  className="mt-4 w-full"
                  disabled={locked}
                  onClick={() =>
                    downloadFile(
                      `${jobName}-setup-sheet.md`,
                      setupSheet(job, state),
                      "text/markdown;charset=utf-8",
                    )
                  }
                >
                  <Download />
                  Download setup sheet
                </Button>
              </Panel>
            </aside>
          </div>
        </>
      )}
    </div>
  );
}
