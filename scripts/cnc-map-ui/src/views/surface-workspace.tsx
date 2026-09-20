import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  ChevronDown,
  Copy,
  Crosshair,
  Grid2X2,
  LockKeyhole,
  Move,
  ScanLine,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { NativeSelectOption } from "@/components/ui/native-select";
import { Progress } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import {
  SurfaceFinishAction,
  SurfaceImportAction,
  SurfaceResults,
} from "@/components/surface-results";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  CheckField,
  NumberField,
  SelectField,
  StopButton,
} from "@/components/workbench-controls";
import { formatNumber as number, useWorkbench } from "@/workbench-context";
import {
  formatDuration,
  gridChoices,
  previewGrid,
  type MappingArea,
} from "@/mapping-plan.js";
import {
  SurfacePlot,
  areaCorner,
  cornerLabel,
  cornerNames,
  type CornerName,
  type MappingCorner,
  type XY,
} from "./surface-plot";

type Axis = "x" | "y" | "z";
type MappingView = "teach" | "grid";
const opposites: Record<CornerName, CornerName> = {
  "front-left": "back-right",
  "front-right": "back-left",
  "back-right": "front-left",
  "back-left": "front-right",
};
const jogKeys: Record<string, [Axis, number]> = {
  ArrowLeft: ["x", -1],
  ArrowRight: ["x", 1],
  ArrowUp: ["y", 1],
  ArrowDown: ["y", -1],
  PageUp: ["z", 1],
  PageDown: ["z", -1],
};
const jogButtons: {
  axis: Axis;
  sign: number;
  label: string;
  className: string;
  icon: typeof ArrowUp;
}[] = [
  {
    axis: "y",
    sign: 1,
    label: "Jog Y positive",
    className: "col-start-2 row-start-1",
    icon: ArrowUp,
  },
  {
    axis: "x",
    sign: -1,
    label: "Jog X negative",
    className: "col-start-1 row-start-2",
    icon: ArrowLeft,
  },
  {
    axis: "x",
    sign: 1,
    label: "Jog X positive",
    className: "col-start-3 row-start-2",
    icon: ArrowRight,
  },
  {
    axis: "y",
    sign: -1,
    label: "Jog Y negative",
    className: "col-start-2 row-start-3",
    icon: ArrowDown,
  },
  {
    axis: "z",
    sign: 1,
    label: "Raise Z",
    className: "col-start-4 row-start-1 ml-2",
    icon: ArrowUp,
  },
  {
    axis: "z",
    sign: -1,
    label: "Lower Z",
    className: "col-start-4 row-start-3 ml-2",
    icon: ArrowDown,
  },
];
const interactiveSelector =
  'input,textarea,select,button,a,summary,form,[contenteditable]:not([contenteditable="false"]),[role="button"],[role="menu"],[role="menuitem"],[role="menubar"],[role="listbox"],[role="combobox"],[role="slider"],[role="spinbutton"],[role="tablist"],[role="dialog"],[data-radix-popper-content-wrapper]';
const primaryAction = "h-auto min-h-9 w-full whitespace-normal py-2 text-left";

function Disclosure({
  title,
  children,
  id,
  className = "",
}: {
  title: string;
  children: ReactNode;
  id?: string;
  className?: string;
}) {
  return (
    <Collapsible id={id} className={`border-t pt-2 ${className}`}>
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          className="group h-auto w-full justify-between whitespace-normal px-0 py-2 text-left text-[13px] hover:bg-transparent"
        >
          {title}
          <ChevronDown className="shrink-0 group-data-[state=open]:rotate-180" />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-3 pb-2 pt-1">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Stay mounted across workspace navigation; a new server session clears all local drafts. */
export function SurfaceWorkspace({ active }: { active: boolean }) {
  const { state } = useWorkbench();
  return (
    <SurfaceSession key={state?.sessionId ?? "connecting"} active={active} />
  );
}

function SurfaceSession({ active }: { active: boolean }) {
  const workbench = useWorkbench();
  const {
    state,
    online,
    pending,
    activeHold,
    client,
    call,
    view,
    modalOpen,
    navigate,
  } = workbench;
  const root = useRef<HTMLElement>(null);
  const inspector = useRef<HTMLElement>(null);
  const latest = useRef(workbench);
  latest.current = workbench;
  const [mappingView, setMappingView] = useState<MappingView>("teach");
  const [attested, setAttested] = useState(false);
  const [clickMove, setClickMove] = useState(false);
  const [selected, setSelected] = useState<CornerName>("front-left");
  const [entry, setEntry] = useState({ x: "", y: "", edited: false });
  const [jogMode, setJogMode] = useState<"step" | "hold">("step");
  const [speed, setSpeed] = useState("normal");
  const [fastHold, setFastHold] = useState(false);
  const [distance, setDistance] = useState("1");
  const [spacing, setSpacing] = useState(
    String(state?.plan?.grid?.spacing ?? 50),
  );
  const [spacingEdited, setSpacingEdited] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const [resultGeometryOpen, setResultGeometryOpen] = useState(false);
  const [clock, setClock] = useState(Date.now());

  const corners: MappingCorner[] = state?.corners ?? [];
  const area: MappingArea | null = state?.area ?? null;
  const position = state?.status?.machineCoord;
  const phase = state?.phase ?? "setup";
  const copper = state?.probeMode === "copper";
  const isActive = active && view === "surface" && !modalOpen;
  const geometryReady = corners.length === 4 && !!area && !state?.geometryIssue;
  const stage: MappingView = geometryReady ? mappingView : "teach";
  const baseLocked =
    !isActive ||
    !!state?.offline ||
    !online ||
    pending ||
    !!state?.busy ||
    !state?.armed ||
    phase !== "teach";
  const teachingLocked = baseLocked || stage !== "teach";
  const controlsLocked = teachingLocked || !!activeHold;
  const planningLocked = baseLocked || !!activeHold;
  const setupLocked =
    !isActive ||
    !!state?.offline ||
    !online ||
    pending ||
    !!state?.busy ||
    phase !== "setup";
  const draft = previewGrid(area, Number(spacing), position);
  const choices = gridChoices(area);
  // The route belongs only to the exact server plan. Local dots are never scan approval.
  const currentPlan =
    !!state?.plan && Number(spacing) === state.plan.grid.spacing;
  const spacingDirty = spacingEdited && !currentPlan;
  const plan = state?.plan;
  const prompt = state?.prompt;
  const point = state?.currentPoint;
  const placement = prompt?.expected === "" && !!point;
  const returning = !!point && point.index === point.total;
  const nextPoint = point ? state?.route?.points?.[point.index] : null;
  const measurements: any[] = state?.measurements ?? [];
  const showResults =
    phase === "complete" ||
    (measurements.length > 0 &&
      (phase === "stopped" || prompt?.expected === "accept observations"));
  const total = state?.route?.points?.length || 1;
  const measured = measurements.length;
  const progress = Math.min(100, (measured / total) * 100);
  const lastMeasurement = measurements.at(-1);
  const readyLocked =
    !isActive ||
    !!state?.offline ||
    !online ||
    pending ||
    !!activeHold ||
    phase !== "scan" ||
    !prompt;
  const nearest = position
    ? [...corners].sort(
        (a, b) =>
          Math.hypot(a.x - position.x, a.y - position.y) -
          Math.hypot(b.x - position.x, b.y - position.y),
      )[0]
    : undefined;
  const selectedPoint =
    corners.find((p) => p.name === selected) ??
    (area ? areaCorner(area, selected) : null);
  const entryX = entry.edited
    ? entry.x
    : selectedPoint
      ? String(selectedPoint.x)
      : "";
  const entryY = entry.edited
    ? entry.y
    : selectedPoint
      ? String(selectedPoint.y)
      : "";
  const canStartFresh =
    isActive && online && !pending && !!state?.canStartFresh;
  const rates = state?.speeds?.[speed];
  const zSpeed = speed;
  const zRate = state?.speeds?.[zSpeed]?.z;
  const holdRates =
    state?.speeds?.[activeHold?.speed ?? (fastHold ? "maximum" : speed)];

  useEffect(() => {
    if (
      !isActive ||
      !online ||
      state?.offline ||
      phase !== "teach" ||
      stage !== "teach"
    )
      client.releaseHold();
  }, [isActive, online, state?.offline, phase, stage, client]);
  useEffect(() => () => client.releaseHold(), [client]);
  useEffect(() => {
    if (!state?.nativeJog) setJogMode("step");
    if (!geometryReady) setMappingView("teach");
  }, [state?.nativeJog, geometryReady]);
  useEffect(() => {
    if (!spacingEdited && state?.plan?.grid?.spacing !== undefined)
      setSpacing(String(state.plan.grid.spacing));
  }, [state?.plan?.grid?.spacing, spacingEdited]);
  useEffect(() => {
    latest.current.setDirty("surface-drafts", entry.edited || spacingDirty);
  }, [entry.edited, spacingDirty]);
  useEffect(() => () => latest.current.setDirty("surface-drafts", false), []);
  useEffect(() => {
    if (!active || phase !== "scan") return;
    setClock(Date.now());
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, phase]);

  function showStage(next: MappingView) {
    if (planningLocked || (next === "grid" && !geometryReady)) return;
    if (next === "grid" && entry.edited) {
      client.setError(
        "Save or discard the corner coordinates before choosing a grid.",
      );
      return;
    }
    if (next === "grid" && draft?.error) {
      const option = choices.find((choice) => choice.draft?.grid);
      if (option) {
        setSpacing(String(option.spacing));
        setSpacingEdited(true);
      }
    }
    client.releaseHold();
    setMappingView(next);
    inspector.current?.scrollTo?.({ top: 0 });
  }

  function movement(
    axis: Axis,
    sign: number,
    key: string | null = null,
    boost = false,
  ) {
    if (controlsLocked || (axis === "z" && corners.length > 0)) return;
    // Shift/fast-hold boost XY only. Z keeps the explicitly selected speed.
    const selectedSpeed =
      axis === "z"
        ? zSpeed
        : jogMode === "hold" && (boost || fastHold)
          ? "maximum"
          : speed;
    if (jogMode === "hold" && state?.nativeJog) {
      // Do not await the long-running hold request: release has a separate transport.
      client.startHold(axis, sign, key, selectedSpeed);
    } else {
      void client.jog(axis, sign, Number(distance), selectedSpeed);
    }
  }

  async function capture() {
    if (controlsLocked) return;
    const corner = selected;
    if (await call("capture", { corner })) {
      const fresh = latest.current.state;
      if (fresh?.sessionId !== state.sessionId || fresh.phase !== "teach")
        return;
      const missing = cornerNames.filter(
        (name) =>
          name !== corner &&
          !(fresh.corners ?? []).some((p: MappingCorner) => p.name === name),
      );
      const next = missing.includes(opposites[corner])
        ? opposites[corner]
        : missing[0];
      if (next) setSelected(next);
      setEntry({ x: "", y: "", edited: false });
    }
  }

  function ready() {
    if (readyLocked) return;
    // Reply only to the currently rendered server prompt, including its one-use ID.
    void call("reply", { id: prompt.id, answer: prompt.expected });
  }

  useEffect(() => {
    if (!isActive) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.key === "Escape"
      )
        return;
      const path = event.composedPath();
      if (
        path.some(
          (node) =>
            node instanceof Element && node.closest(interactiveSelector),
        )
      )
        return;
      const focused = document.activeElement;
      if (focused instanceof Element && focused.closest(interactiveSelector))
        return;
      // Blank workspace only. Native controls, menus and the shell keep their own Enter behaviour.
      const target = event.target;
      if (
        target !== document.body &&
        target !== document.documentElement &&
        (!(target instanceof Node) || !root.current?.contains(target))
      )
        return;
      if (event.key !== "Enter" && !jogKeys[event.key]) return;
      if (event.repeat) {
        event.preventDefault();
        return;
      }
      if (event.key === "Enter") {
        if (activeHold) return;
        if (phase === "scan" && !readyLocked) {
          event.preventDefault();
          ready();
        } else if (!controlsLocked) {
          event.preventDefault();
          void capture();
        }
        return;
      }
      const [axis, sign] = jogKeys[event.key];
      if (controlsLocked || (axis === "z" && corners.length > 0)) return;
      event.preventDefault();
      movement(axis, sign, event.key, event.shiftKey);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  });

  async function completeRectangle() {
    if (controlsLocked || !area || corners.length === 4) return;
    if (await call("complete-rectangle", { area })) {
      if (latest.current.state?.sessionId !== state.sessionId) return;
      if (draft?.error) {
        const option = choices.find((choice) => choice.draft?.grid);
        if (option) {
          setSpacing(String(option.spacing));
          setSpacingEdited(true);
        }
      }
      setMappingView("grid");
    }
  }

  function acceptSuggested(name: CornerName) {
    if (controlsLocked || !area) return;
    void call("corner-entry", { corner: name, ...areaCorner(area, name) });
  }

  async function saveCorner() {
    if (controlsLocked) return;
    if (
      !entryX.trim() ||
      !entryY.trim() ||
      !Number.isFinite(Number(entryX)) ||
      !Number.isFinite(Number(entryY))
    ) {
      client.setError("Enter both X and Y as finite machine coordinates.");
      return;
    }
    if (
      await call("corner-entry", {
        corner: selected,
        x: Number(entryX),
        y: Number(entryY),
      })
    )
      setEntry({ x: "", y: "", edited: false });
  }

  function goto(point: XY, fromGrid = false) {
    if ((fromGrid ? planningLocked : controlsLocked) || !area) return;
    // Z is captured and checked by the server. Never derive or send a local clearance height.
    void call("goto", { x: point.x, y: point.y, speed });
  }

  async function preview() {
    if (planningLocked || !geometryReady || !draft?.grid || !draft.startsHere)
      return;
    if (await call("plan", { spacing: Number(spacing) }))
      setSpacingEdited(false);
  }

  function scan() {
    if (
      planningLocked ||
      !geometryReady ||
      !draft?.grid ||
      !currentPlan ||
      entry.edited ||
      !state?.planId
    )
      return;
    // Recheck the draft at activation, not just when the button was rendered.
    if (Number(spacing) !== state.plan.grid.spacing) return;
    setSpacingEdited(false);
    void call("scan", { planId: state.planId });
  }

  const title = placement
    ? returning
      ? "Repeat the starting point"
      : `Place puck · point ${point.index} of ${point.total}`
    : prompt?.expected === "accept observations"
      ? "Review your observations"
      : prompt?.expected === "contact ready"
        ? "Check probe contact"
        : prompt?.expected === "start copper scan"
          ? "Ready for automatic scan"
          : prompt
            ? "Check the setup"
            : "Measuring & moving…";
  const readyLabel = placement
    ? returning
      ? "Ready — check return"
      : "Ready — measure & advance"
    : prompt?.expected === "start copper scan"
      ? "Start automatic copper scan"
      : prompt?.expected === "contact ready"
        ? "Contact checked — continue"
        : prompt?.expected === "accept observations"
          ? "Accept observations & save"
          : "Confirm displayed checks";
  const caption =
    phase === "scan"
      ? "Measured points and next placement"
      : currentPlan
        ? "Scan route · dashed return check"
        : stage === "grid"
          ? "Draft grid · preview the route before measurement"
          : `${corners.length} of 4 inset corners recorded`;

  return (
    <section
      ref={root}
      id="surfaceContent"
      hidden={!active}
      aria-label="Surface mapping"
      data-phase={phase === "teach" ? stage : phase}
      className="surface-workspace page-scroll min-w-0 space-y-4 text-[13px] leading-relaxed"
    >
      <div className="page-heading">
        <div>
          <h1>Surface mapping</h1>
          <p>Define the usable area. Plan the grid. Measure the surface.</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs
          value={phase === "scan" || phase === "complete" ? "measure" : stage}
          onValueChange={(value) => {
            if (value !== "measure") showStage(value as MappingView);
          }}
        >
          <TabsList
            variant="line"
            aria-label="Mapping progress"
            className="max-w-full"
          >
            <TabsTrigger
              id="step1"
              value="teach"
              disabled={phase !== "teach" || planningLocked}
              className="text-[13px]"
            >
              <Crosshair />
              Define area
            </TabsTrigger>
            <TabsTrigger
              id="step2"
              value="grid"
              disabled={planningLocked || !geometryReady}
              className="text-[13px]"
            >
              <Grid2X2 />
              Plan grid
            </TabsTrigger>
            <TabsTrigger
              id="step3"
              value="measure"
              disabled
              className="text-[13px]"
            >
              <ScanLine />
              Measure
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <Badge variant="outline">
          {state?.offline
            ? "Offline preparation"
            : state?.demo
              ? "Demo · simulated coordinates"
              : copper
                ? "Continuous copper"
                : "Movable puck"}
        </Badge>
      </div>

      <div className="surface-layout grid min-w-0 grid-cols-1 items-start gap-4 min-[900px]:grid-cols-[minmax(0,1fr)_300px] xl:grid-cols-[minmax(0,1fr)_318px]">
        <div className="surface-canvas order-2 min-w-0 overflow-hidden rounded-lg border bg-card min-[900px]:order-1">
          {showResults && state && <SurfaceResults state={state} />}
          <Collapsible
            open={!showResults || resultGeometryOpen}
            onOpenChange={setResultGeometryOpen}
          >
            {showResults && (
              <CollapsibleTrigger asChild>
                <Button
                  variant="ghost"
                  className="h-auto w-full justify-between whitespace-normal rounded-none border-t px-4 py-3 text-left"
                >
                  Scan route & machine coordinates
                  <ChevronDown />
                </Button>
              </CollapsibleTrigger>
            )}
            <CollapsibleContent
              forceMount
              hidden={showResults && !resultGeometryOpen}
            >
              <div className="flex items-start justify-between gap-3 px-4 py-4">
                <div>
                  <h2 className="text-base font-semibold">Working area</h2>
                  <p id="areaCaption" className="mt-1 text-muted-foreground">
                    {caption}
                  </p>
                </div>
                <span className="font-mono text-xs text-muted-foreground">
                  mm
                </span>
              </div>
              <div
                id="mapMoveControls"
                hidden={phase !== "teach" || stage !== "teach"}
                className="space-y-2 border-t px-4 py-3"
              >
                <CheckField
                  id="clickMove"
                  label="Click area to move XY"
                  checked={clickMove}
                  disabled={controlsLocked || !area}
                  onCheckedChange={(checked) => setClickMove(checked === true)}
                />
                <p id="mapHint" className="text-xs text-muted-foreground">
                  {area
                    ? corners.length < 4
                      ? "Click a dashed corner to accept it without moving. Enable click positioning to move inside the outline."
                      : "Click inside the rectangle to move at the taught raised Z."
                    : "Record two opposite corners to define the positioning area."}
                </p>
              </div>
              <SurfacePlot
                active={active}
                state={state}
                currentPlan={currentPlan}
                draft={draft}
                showDraft={stage === "grid"}
                canAccept={!controlsLocked}
                canMove={clickMove && !controlsLocked && !!area}
                onAccept={acceptSuggested}
                onMove={goto}
                onError={client.setError}
              />
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-t px-4 py-3 sm:grid-cols-4">
                {(["x", "y", "z"] as const).map((axis) => (
                  <div key={axis}>
                    <dt className="text-xs text-muted-foreground">
                      Machine {axis.toUpperCase()}
                    </dt>
                    <dd
                      id={axis}
                      className="mt-1 font-mono text-[19px] tabular-nums"
                    >
                      {number(position?.[axis])}
                    </dd>
                  </div>
                ))}
                <div>
                  <dt className="text-xs text-muted-foreground">Grid points</dt>
                  <dd
                    id="count"
                    className="mt-1 font-mono text-[19px] tabular-nums"
                  >
                    {draft?.points ?? "—"}
                  </dd>
                </div>
              </dl>
              <div className="border-t px-4 py-3 text-xs text-muted-foreground">
                <span id="supportHint">
                  {copper
                    ? "Every grid point must contact continuous copper on the clipped face."
                    : "Inset every corner far enough for the whole puck to sit on the material."}
                </span>{" "}
                Stock size is not machine travel.
              </div>
              <Disclosure
                title="Corner coordinates · machine XY, mm"
                className="mx-4"
              >
                <Table id="cornerTable">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Corner</TableHead>
                      <TableHead className="text-right">X</TableHead>
                      <TableHead className="text-right">Y</TableHead>
                      <TableHead>Source</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {cornerNames.map((name) => {
                      const p = corners.find((point) => point.name === name);
                      return (
                        <TableRow key={name}>
                          <TableCell className="capitalize">
                            {cornerLabel(name)}
                          </TableCell>
                          <TableCell className="text-right font-mono tabular-nums">
                            {number(p?.x)}
                          </TableCell>
                          <TableCell className="text-right font-mono tabular-nums">
                            {number(p?.y)}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {p ? (p.source ?? "captured") : "Not recorded"}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </Disclosure>
            </CollapsibleContent>
          </Collapsible>
        </div>

        <aside
          ref={inspector}
          aria-label="Surface mapping controls"
          className="surface-inspector order-1 min-w-0 space-y-4 rounded-lg border bg-card p-4 min-[900px]:sticky min-[900px]:top-0 min-[900px]:order-2 min-[900px]:max-h-[calc(100dvh-190px)] min-[900px]:overflow-y-auto"
        >
          <div className="flex items-center justify-between gap-3 border-b pb-3">
            <span className="font-medium">
              {phase === "complete"
                ? "Results & handoff"
                : phase === "scan"
                  ? "Measurement"
                  : phase === "teach" && stage === "grid"
                    ? "Grid planning"
                    : "Machine controls"}
            </span>
            <StopButton size="sm" />
          </div>
          {!online && (
            <p
              role="status"
              className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-destructive"
            >
              {state
                ? "Connection unavailable. Controls are locked."
                : "Waiting for the local connection. Controls are locked."}
            </p>
          )}

          {state?.offline && (
            <div id="surfaceOffline" className="space-y-3" role="status">
              <p>
                Offline preparation cannot enable teaching or measure a surface.
                Open Job preparation to prepare files. Connect a configured
                machine or restart in demo mode to measure.
              </p>
              <Button
                id="surfaceOfflineJob"
                variant="outline"
                className={primaryAction}
                onClick={() => navigate("guide")}
              >
                Open Job preparation
                <ArrowRight />
              </Button>
            </div>
          )}
          <section
            id="setup"
            hidden={phase !== "setup" || !!state?.offline}
            className="space-y-4"
          >
            <h2 className="text-base font-semibold">Prepare the machine</h2>
            <fieldset className="space-y-3">
              <legend className="mb-2 font-medium">Surface contact</legend>
              <RadioGroup
                name="probeMethod"
                value={state?.probeMode ?? "puck"}
                disabled={setupLocked}
                onValueChange={(mode) => {
                  if (!setupLocked) {
                    setAttested(false);
                    void call("probe-mode", { mode });
                  }
                }}
                aria-describedby="probeMethodHelp"
                className="gap-3"
              >
                <div className="flex items-start gap-2">
                  <RadioGroupItem
                    id="probeMethodPuck"
                    value="puck"
                    className="mt-0.5"
                  />
                  <Label
                    htmlFor="probeMethodPuck"
                    className="grid gap-1 text-[13px] leading-relaxed"
                  >
                    Movable puck
                    <span className="font-normal text-muted-foreground">
                      Wood and non-conductive stock. Ready at each point.
                    </span>
                  </Label>
                </div>
                <div className="flex items-start gap-2">
                  <RadioGroupItem
                    id="probeMethodCopper"
                    value="copper"
                    className="mt-0.5"
                  />
                  <Label
                    htmlFor="probeMethodCopper"
                    className="grid gap-1 text-[13px] leading-relaxed"
                  >
                    Continuous copper
                    <span className="font-normal text-muted-foreground">
                      Blank PCB copper. Automatic reviewed grid.
                    </span>
                  </Label>
                </div>
              </RadioGroup>
            </fieldset>
            <p id="probeMethodHelp" className="text-muted-foreground">
              {copper
                ? "Connect one lead to the cutter and the other to the same continuous copper face. Remove the puck. Contact checks precede automatic scanning."
                : `Use the configured ${number(state?.configuration?.puckHeight)} mm puck and clip. Place it at each point, then press Ready.`}
            </p>
            <p className="text-muted-foreground">
              Close UGS AutoLeveler, remove any loaded job and keep the same
              secured stock and cutter. Spindle off; offline keypad
              disconnected.
            </p>
            <p className="text-muted-foreground">
              Put the puck aside. Check the path and Z headroom before jogging.
              Use this page as the only control, with the physical stop in
              reach.
            </p>
            <CheckField
              id="attest"
              label="I’m at the machine and have checked this setup."
              checked={attested}
              disabled={setupLocked}
              onCheckedChange={(checked) => setAttested(checked === true)}
            />
            <Button
              id="arm"
              className={primaryAction}
              disabled={setupLocked || !attested}
              onClick={() => {
                if (!setupLocked && attested)
                  void call("arm", { confirmed: true });
              }}
            >
              Enable teaching
              <ArrowRight />
            </Button>
          </section>

          <section
            id="recovery"
            hidden={phase !== "stopped"}
            className="space-y-4"
            aria-live="polite"
          >
            <h2 id="recoveryTitle" className="text-base font-semibold">
              {state?.fault?.title ?? "Session stopped"}
            </h2>
            <p id="recoveryHelp" className="text-muted-foreground">
              {state?.fault?.nextStep ??
                "Review the machine and clear the cause of the stop. Start a fresh setup when all workers have stopped."}
            </p>
            <Disclosure title="Technical details">
              <pre
                id="recoveryDetail"
                className="whitespace-pre-wrap break-words font-mono text-xs"
              >
                {state?.fault?.detail ??
                  state?.error ??
                  "No further fault details."}
              </pre>
            </Disclosure>
            <Button
              id="fresh"
              className={primaryAction}
              disabled={!canStartFresh}
              onClick={() => {
                if (canStartFresh) void call("new-session");
              }}
            >
              {state?.canStartFresh
                ? "Start fresh setup"
                : "Waiting for workers to stop…"}
            </Button>
            <p className="text-xs text-muted-foreground">
              A fresh setup discards the old machine reference and requires a
              new setup check.
            </p>
          </section>

          <section
            id="teach"
            hidden={phase !== "teach" || stage !== "teach"}
            className="space-y-3"
          >
            <h2 id="cornerTitle" className="sr-only">
              Position & corners · {cornerLabel(selected)}
            </h2>
            <p id="cornerNumber" className="text-xs text-muted-foreground">
              {corners.length} of 4 corners recorded · any order
            </p>
            <p
              id="geometryIssue"
              role="status"
              hidden={!state?.geometryIssue}
              className="rounded-md border border-destructive/30 p-3 text-destructive"
            >
              {state?.geometryIssue}
            </p>
            <SelectField
              id="corner"
              label="Corner to record"
              value={selected}
              disabled={controlsLocked}
              onChange={(event) => {
                setSelected(event.target.value as CornerName);
                setEntry({ x: "", y: "", edited: false });
              }}
              options={cornerNames.map((name) => ({
                value: name,
                label: `${cornerLabel(name)}${corners.some((p) => p.name === name) ? " · recorded" : ""}`,
              }))}
            />
            <div className="grid grid-cols-2 gap-3">
              <SelectField
                id="jogMode"
                label="Jog mode"
                value={jogMode}
                disabled={controlsLocked}
                onChange={(event) =>
                  setJogMode(event.target.value as "step" | "hold")
                }
              >
                <NativeSelectOption value="step">
                  Single step
                </NativeSelectOption>
                <NativeSelectOption value="hold" disabled={!state?.nativeJog}>
                  Hold to move
                </NativeSelectOption>
              </SelectField>
              <SelectField
                id="speed"
                label="Speed"
                value={speed}
                disabled={controlsLocked}
                onChange={(event) => setSpeed(event.target.value)}
                options={[
                  { value: "slow", label: "Slow" },
                  { value: "normal", label: "Normal" },
                  { value: "fast", label: "Fast" },
                  { value: "maximum", label: "Maximum" },
                ]}
              />
            </div>
            <div className="grid grid-cols-[104px_minmax(0,1fr)] items-end gap-3">
              <SelectField
                id="distance"
                label="XY step"
                value={distance}
                disabled={controlsLocked || jogMode === "hold"}
                onChange={(event) => setDistance(event.target.value)}
                options={["0.1", "1", "5", "10", "25", "50"].map((value) => ({
                  value,
                  label: `${value} mm`,
                }))}
              />
              <CheckField
                id="fastHold"
                label="Fast XY hold · maximum"
                checked={fastHold}
                disabled={controlsLocked || jogMode !== "hold"}
                onCheckedChange={(checked) => setFastHold(checked === true)}
              />
            </div>
            <div
              className="jog-grid grid grid-cols-4 grid-rows-3 gap-1.5"
              aria-label="Machine jog controls"
            >
              <span className="col-start-2 row-start-2 flex items-center justify-center text-xs text-muted-foreground">
                XY
              </span>
              <span className="col-start-4 row-start-2 flex items-center justify-center text-xs text-muted-foreground">
                {corners.length ? (
                  <LockKeyhole className="size-3.5" aria-label="Z locked" />
                ) : (
                  "Z"
                )}
              </span>
              {jogButtons.map(
                ({ axis, sign, label, className, icon: Icon }) => {
                  const held =
                    activeHold?.axis === axis && activeHold.sign === sign;
                  return (
                    <Button
                      key={`${axis}:${sign}`}
                      data-axis={axis}
                      data-sign={sign}
                      aria-label={label}
                      aria-pressed={held}
                      variant={held ? "default" : "outline"}
                      className={`h-11 touch-none select-none gap-1 px-1 ${className}`}
                      disabled={
                        !held &&
                        (controlsLocked || (axis === "z" && corners.length > 0))
                      }
                      onClick={() => {
                        if (jogMode === "step") movement(axis, sign);
                      }}
                      onPointerDown={(event) => {
                        if (
                          jogMode !== "hold" ||
                          controlsLocked ||
                          event.button !== 0
                        )
                          return;
                        event.preventDefault();
                        event.currentTarget.setPointerCapture(event.pointerId);
                        movement(axis, sign);
                      }}
                      onPointerUp={() => client.releaseHold()}
                      onPointerCancel={() => client.releaseHold()}
                      onLostPointerCapture={() => client.releaseHold()}
                    >
                      <Icon className="size-3.5" />
                      <span className="text-xs">
                        {axis.toUpperCase()}
                        {sign > 0 ? "+" : "−"}
                      </span>
                    </Button>
                  );
                },
              )}
            </div>
            {corners.length > 0 && (
              <p className="flex items-start gap-2 text-xs text-muted-foreground">
                <LockKeyhole className="mt-0.5 size-3.5 shrink-0" />Z locked at
                the taught height. Clear corners before changing Z.
              </p>
            )}
            <Button
              id="capture"
              className={primaryAction}
              disabled={controlsLocked}
              onClick={() => void capture()}
            >
              <Crosshair />
              {corners.some((p) => p.name === selected)
                ? "Update"
                : "Record"}{" "}
              {selected} corner<span aria-hidden="true">↵</span>
            </Button>
            <Button
              id="gotoCorner"
              variant="outline"
              className={primaryAction}
              disabled={controlsLocked || !area}
              onClick={() => {
                if (area) goto(areaCorner(area, selected));
              }}
            >
              <Move />
              Move to selected corner
            </Button>
            <div
              id="rectangleShortcut"
              hidden={!area || corners.length === 4}
              className="space-y-2 border-b pb-4"
            >
              <h2 className="text-base font-semibold">Rectangle defined</h2>
              <p id="rectangleText" className="text-muted-foreground">
                {area
                  ? `${number(area.x[1] - area.x[0])} × ${number(area.y[1] - area.y[0])} mm. ${4 - corners.length} corners can be inferred from the recorded points.`
                  : ""}
              </p>
              <Button
                id="completeRectangle"
                className={primaryAction}
                disabled={controlsLocked || !area}
                onClick={() => void completeRectangle()}
              >
                <Check />
                Accept {4 - corners.length} remaining corner
                {corners.length === 3 ? "" : "s"} & plan grid
              </Button>
              <p className="text-xs text-muted-foreground">
                Uses the dashed corners without moving. Check all four are
                supported and the whole route is clear.
              </p>
            </div>
            <div
              id="areaReady"
              hidden={!geometryReady}
              className="space-y-2 border-b pb-4"
            >
              <Button
                id="toPlanning"
                className={primaryAction}
                disabled={planningLocked || !geometryReady}
                onClick={() => showStage("grid")}
              >
                Continue to grid planning
                <ArrowRight />
              </Button>
              <p className="text-xs text-muted-foreground">
                All corners recorded. You can still adjust them below.
              </p>
            </div>
            <Button
              id="reset"
              variant="ghost"
              className={primaryAction}
              disabled={controlsLocked}
              onClick={async () => {
                if (!controlsLocked && (await call("reset-corners"))) {
                  setEntry({ x: "", y: "", edited: false });
                  setClickMove(false);
                }
              }}
            >
              Clear taught corners
            </Button>
            <Disclosure
              title="Enter selected corner coordinates"
              className="manual-entry"
            >
              <p className="text-xs text-muted-foreground">
                Machine coordinates, mm. Uses the current raised Z. Saving does
                not move the cutter or verify physical clearance.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <NumberField
                  id="cornerX"
                  label="X (mm)"
                  step="0.001"
                  value={entryX}
                  disabled={controlsLocked}
                  onChange={(event) =>
                    setEntry({ x: event.target.value, y: entryY, edited: true })
                  }
                />
                <NumberField
                  id="cornerY"
                  label="Y (mm)"
                  step="0.001"
                  value={entryY}
                  disabled={controlsLocked}
                  onChange={(event) =>
                    setEntry({ x: entryX, y: event.target.value, edited: true })
                  }
                />
              </div>
              <Button
                id="saveCorner"
                variant="outline"
                className={primaryAction}
                disabled={controlsLocked}
                onClick={() => void saveCorner()}
              >
                Save selected corner — no movement
              </Button>
              {entry.edited && (
                <Button
                  variant="ghost"
                  disabled={controlsLocked}
                  onClick={() => setEntry({ x: "", y: "", edited: false })}
                >
                  Discard corner edits
                </Button>
              )}
              <p className="text-xs text-muted-foreground">
                Dashed markers suggest an axis-aligned rectangle. Accept a
                marker without moving. Two adjacent corners cannot determine the
                missing width or height.
              </p>
            </Disclosure>
            <Disclosure title="Teaching, speeds & shortcuts">
              <p id="jogHint" className="text-muted-foreground">
                {corners.length === 0
                  ? "Choose whichever corner is closest. Set a raised Z that clears the puck and clamps throughout the area."
                  : corners.length === 1
                    ? "Teach the opposite corner next to unlock exact positioning. Keep the same raised Z."
                    : "Match left/right X and front/back Y to form a rectangle. Keep the same raised Z."}
              </p>
              <p id="speedHint" className="text-xs text-muted-foreground">
                {rates
                  ? `X ${rates.x} · Y ${rates.y} · Z ${zRate ?? "—"} mm/min. `
                  : ""}
                {jogMode === "hold" && holdRates
                  ? `XY hold: X ${holdRates.x} · Y ${holdRates.y} mm/min. `
                  : ""}
                {!state?.nativeJog
                  ? "Smooth Hold needs the UGS extension."
                  : "Maximum follows each axis’s controller limit. Allow room to decelerate."}
              </p>

              <p className="text-xs text-muted-foreground">
                Arrows: XY. Page Up/Down: Z. In Hold mode, Shift + arrow starts
                fast XY travel. Z keeps the selected speed, including Maximum;
                Shift and Fast XY hold do not change it.
              </p>
              <p className="text-xs text-muted-foreground">
                Release Hold to cancel and decelerate. Each hold: up to 100 mm
                XY / 5 mm Z. Single Z steps: up to 1 mm. Z locks after the first
                corner. Firmware limits do not verify clearance.
              </p>
            </Disclosure>
          </section>

          <section
            id="gridPanel"
            hidden={phase !== "teach" || stage !== "grid"}
            className="space-y-4"
          >
            <h2 className="text-base font-semibold">
              Choose the measurement grid
            </h2>
            <p id="gridArea" className="text-muted-foreground">
              {area
                ? `${number(area.x[1] - area.x[0])} × ${number(area.y[1] - area.y[0])} mm usable area. Map only the area the job needs.`
                : ""}
            </p>
            <div id="planning" className="space-y-4">
              <div
                id="gridChoices"
                className="grid grid-cols-3 gap-2"
                aria-label="Grid spacing presets"
              >
                {choices.map((choice, index) => (
                  <Button
                    key={choice.label}
                    data-grid-choice={index}
                    variant={
                      choice.spacing === Number(spacing)
                        ? "secondary"
                        : "outline"
                    }
                    aria-pressed={choice.spacing === Number(spacing)}
                    disabled={planningLocked || !choice.draft?.grid}
                    className="h-auto min-w-0 flex-col gap-1 whitespace-normal px-1.5 py-3 text-center text-[13px]"
                    onClick={() => {
                      setSpacing(String(choice.spacing));
                      setSpacingEdited(true);
                    }}
                  >
                    <strong>{choice.label}</strong>
                    <span className="text-xs font-normal">
                      {choice.draft?.grid
                        ? `${choice.draft.placements} ${copper ? "contacts" : "placements"}`
                        : "Unavailable"}
                    </span>
                    <span className="font-mono text-xs font-normal">
                      {choice.spacing} mm
                    </span>
                  </Button>
                ))}
              </div>
              <NumberField
                id="spacing"
                label="Spacing (mm)"
                min="0.1"
                step="0.1"
                value={spacing}
                disabled={planningLocked}
                aria-invalid={!!draft?.error}
                aria-describedby="gridDraft gridTradeoff"
                onChange={(event) => {
                  setSpacing(event.target.value);
                  setSpacingEdited(true);
                }}
              />
              <p
                id="gridDraft"
                role="status"
                className={draft?.error ? "text-destructive" : "font-medium"}
              >
                {draft?.error ??
                  (draft?.grid
                    ? `${draft.grid.x.length} × ${draft.grid.y.length} grid · ${draft.placements} ${copper ? "automatic measurements" : "puck placements"}, including return check.`
                    : "")}
              </p>
              <p id="gridTradeoff" className="text-xs text-muted-foreground">
                {copper
                  ? "Wider spacing means fewer contacts"
                  : "Wider spacing means fewer puck placements"}
                , but can miss variation between points. Choose coverage and
                spacing for the actual cutting job.
              </p>
              <p id="gridStartHelp" className="text-xs text-muted-foreground">
                {draft?.error
                  ? ""
                  : draft?.startsHere
                    ? "The cutter is at a grid point. Measurement will start here."
                    : "The cutter is between grid points. Move to a corner before previewing the route."}
              </p>
              <Button
                id="gridReturn"
                variant="outline"
                hidden={!draft?.grid || draft.startsHere}
                className={primaryAction}
                disabled={planningLocked || !nearest}
                onClick={() => {
                  if (nearest) goto(nearest, true);
                }}
              >
                <Move />
                {nearest
                  ? `Move to ${cornerLabel(nearest.name)} · X ${number(nearest.x)} Y ${number(nearest.y)}`
                  : "Move to nearest corner"}
              </Button>
              <Button
                id="preview"
                hidden={currentPlan}
                className={primaryAction}
                disabled={
                  planningLocked ||
                  !geometryReady ||
                  !draft?.grid ||
                  !draft.startsHere
                }
                onClick={() => void preview()}
              >
                Preview scan route
                <ArrowRight />
              </Button>
              <Button
                id="scan"
                hidden={!plan}
                className={primaryAction}
                disabled={
                  planningLocked ||
                  !geometryReady ||
                  !currentPlan ||
                  entry.edited ||
                  !draft?.grid ||
                  !state?.planId
                }
                onClick={scan}
              >
                Set up measurement
                <ArrowRight />
              </Button>
            </div>
            <div
              id="planSummary"
              hidden={!plan}
              className="space-y-2 border-t pt-4"
            >
              <p id="planText">
                {plan
                  ? !currentPlan
                    ? "Spacing changed. Preview the updated grid before scanning."
                    : `${plan.grid.x.length} × ${plan.grid.y.length} grid · ${plan.grid.x.length * plan.grid.y.length + 1} ${copper ? "automatic measurements" : "puck placements"} including return. ${Math.round(state?.route?.distance ?? 0)} mm XY travel (about ${(((state?.route?.distance ?? 0) / plan.feeds.xy) * 60).toFixed(1)} s at commanded feed). Traverse at machine Z ${number(plan.travelZ)} mm; probe ${plan.feeds.first} then ${plan.feeds.second} mm/min.`
                  : ""}
              </p>
              <p className="text-xs text-muted-foreground">
                Dashed line returns to the first point. XY time excludes
                probing, acceleration and{" "}
                {copper ? "setup checks" : "your puck placements"}. Every route
                must clear {copper ? "leads" : "puck"} and clamps; each contact
                needs a gap below {plan?.probe?.firstSearch ?? 5} mm.
              </p>
            </div>
            <Button
              id="backToArea"
              variant="ghost"
              className={primaryAction}
              disabled={planningLocked}
              onClick={() => showStage("teach")}
            >
              <ArrowLeft />
              Back to area & jogging
            </Button>
          </section>

          <section
            id="measurement"
            hidden={phase !== "scan"}
            className="space-y-4"
          >
            <h2
              id="measureTitle"
              className="text-base font-semibold"
              aria-live="polite"
            >
              {title}
            </h2>
            <div
              id="pointGuide"
              hidden={!point || prompt?.expected === "accept observations"}
              className="space-y-3"
            >
              <p id="pointLocation" className="font-mono text-lg tabular-nums">
                X {number(point?.point?.x)}
                <br />Y {number(point?.point?.y)}{" "}
                <span className="text-xs text-muted-foreground">mm</span>
              </p>
              <p id="pointInstruction">
                {placement
                  ? returning
                    ? "Place the puck where the scan began. This final repeat checks whether the reference drifted."
                    : `Seat the puck flat under the cutter. Tip centred, gap below ${plan?.probe?.firstSearch ?? 5} mm. Clear your hands, then press Ready or Enter.`
                  : copper
                    ? "Automatic copper measurement. Keep clear of the cutter and leads."
                    : "Keep hands clear. Wait for the next placement prompt before moving the puck."}
              </p>
              <p id="nextPoint" className="text-xs text-muted-foreground">
                {nextPoint
                  ? `Next: X ${number(nextPoint.x)} · Y ${number(nextPoint.y)} mm${point.index === point.total - 1 ? " · return check" : ""}. Travel follows the measurement automatically.`
                  : "Final measurement · no further XY travel."}
              </p>
            </div>
            <Progress
              id="scanProgress"
              value={progress}
              aria-label="Completed measurements"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress}
              aria-valuetext={`${measured} of ${total} measurements`}
              className="h-1.5"
            />
            <p id="scanProgressText" className="text-xs text-muted-foreground">
              {state?.demo ? "SIMULATED · " : ""}
              {measured} / {total} measurements
              {lastMeasurement
                ? ` · last repeat spread ${number(lastMeasurement.spread)} mm`
                : ""}
              .
            </p>
            <p id="scanRemaining" className="text-xs text-muted-foreground">
              {Math.max(0, total - measured)} measurements remaining ·{" "}
              {formatDuration(
                state?.scanStarted ? clock / 1000 - state.scanStarted : 0,
              )}{" "}
              elapsed, including setup and waiting.
            </p>
            <p
              id="promptText"
              hidden={placement}
              className="whitespace-pre-wrap break-words"
            >
              {prompt?.prompt ??
                (copper
                  ? "Automatic copper scan in progress. Remain at the physical stop."
                  : "Keep hands clear and leave the puck stationary until the next placement prompt.")}
            </p>
            <Button
              id="ready"
              className={primaryAction}
              disabled={readyLocked}
              onClick={ready}
            >
              {readyLabel}
              {placement && <span aria-hidden="true">↵</span>}
            </Button>
            <p
              id="measurementMethodHelp"
              className="text-xs text-muted-foreground"
            >
              {copper
                ? "The approved copper route runs automatically. Remain at the machine; Stop cancels the entire scan."
                : "After each Ready: two touches, lift, then automatic travel. Leave the puck still and keep hands clear until the next placement prompt."}
            </p>
            <div hidden={!placement}>
              <Disclosure id="probeDetails" title="Full cycle & limits">
                <p
                  id="probeContract"
                  className="whitespace-pre-wrap break-words text-xs text-muted-foreground"
                >
                  {placement ? prompt?.prompt : ""}
                </p>
              </Disclosure>
            </div>
          </section>

          <section
            id="finished"
            hidden={phase !== "complete"}
            className="space-y-4"
          >
            <h2 id="finishedTitle" className="text-base font-semibold">
              {state?.demo
                ? "Demo complete."
                : state?.result
                  ? "Measurements saved."
                  : "Measurement records."}
            </h2>
            <p id="finishedText" className="text-muted-foreground">
              {state?.demo
                ? "Review the simulated measurements and download the report. No machine map was created."
                : state?.result
                  ? "Review the measured range, repeat spread and return drift. Native import and the cutting datum require separate checks."
                  : "The runner completed, but no accepted map is available in this snapshot. Review the recorded evidence."}
            </p>
            <div
              id="ugsHandoff"
              hidden={!state?.result || state?.demo || state?.offline}
              className="space-y-4"
            >
              <SurfaceImportAction active={isActive} />
              <Disclosure title="Map file, datum & cutting checks">
                <p className="text-xs text-muted-foreground">
                  Accepted map file. For a non-flat map, manual fallback:
                  AutoLeveler → Open scanned surface, in millimetres. Exactly
                  flat maps require the verified native import.
                </p>
                <p id="surfaceMapPath" className="break-all font-mono text-xs">
                  {state?.result?.path ?? "No saved map path."}
                </p>
                <Button
                  id="copyMapPath"
                  variant="ghost"
                  className={primaryAction}
                  onClick={async () => {
                    if (!state?.result?.path || state.demo || state.offline)
                      return;
                    try {
                      await navigator.clipboard.writeText(state.result.path);
                      setCopyStatus("File path copied.");
                    } catch {
                      setCopyStatus(
                        "Copy unavailable. Select the file path above and copy it.",
                      );
                    }
                  }}
                >
                  <Copy />
                  Copy map file path
                </Button>
                <p
                  id="copyMapStatus"
                  role="status"
                  className="text-xs text-muted-foreground"
                >
                  {copyStatus}
                </p>
                <p id="handoffDatum" className="text-xs text-muted-foreground">
                  Required material-top G54 Z:{" "}
                  {number(state?.result?.summary?.requiredG54Z)} mm. Verify this
                  reference before cutting; the app has not changed it.
                </p>
                <p className="text-xs text-muted-foreground">
                  Use zero AutoLeveler probe offsets and zero Z surface for this
                  map. Inspect complete toolpath coverage and apply compensation
                  exactly once. Keep the connection, cutter and workholding
                  unchanged. Remove the probe leads before spindle operation. Do
                  not run Scan surface with the puck.
                </p>
                <Button
                  id="openMapHandoff"
                  variant="outline"
                  className={primaryAction}
                  onClick={() => navigate("guide")}
                >
                  Review full job handoff
                  <ArrowRight />
                </Button>
              </Disclosure>
            </div>
            <SurfaceFinishAction active={isActive} />
            <Button
              id="newMap"
              className={primaryAction}
              disabled={!canStartFresh}
              onClick={() => {
                if (canStartFresh) void call("new-session");
              }}
            >
              Set up another map
            </Button>
          </section>
        </aside>
      </div>
    </section>
  );
}
