import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Download,
  FileCode,
  FolderOpen,
  FolderPlus,
  Plus,
  Save,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  CheckField,
  Field,
  Notice,
  NumberField,
  SelectField,
} from "@/components/workbench-controls";
import { downloadFile, formatNumber, useWorkbench } from "@/workbench-context";
import {
  ToolpathPreview,
  type PcbJob,
  type PcbOperation,
  type PcbReference,
  type ReferenceLabel,
} from "./toolpath-preview";

type BoardDraft = {
  name: string;
  boardRevision: string;
  face: string;
  stockX: string;
  stockY: string;
  width: string;
  height: string;
  thickness: string;
  margin: string;
  spoil: string;
  placeX: string;
  placeY: string;
  angle: string;
  tolerance: string;
  mirror: boolean;
};
type ReferenceDraft = {
  designX: string;
  designY: string;
  machineX: string;
  machineY: string;
};
type OperationDraft = { role: string; tool: string; diameter: string };
type Inspector = "setup" | "alignment" | "review";
const labels: ReferenceLabel[] = ["A", "B", "C"];
const roles = ["isolation", "drilling", "outline", "clearing", "other"].map(
  (value) => ({ value, label: value[0].toUpperCase() + value.slice(1) }),
);
const numberText = (value: number | null | undefined) =>
  value == null ? "" : String(Number(value.toFixed(6)));

function boardValues(job: PcbJob): BoardDraft {
  const s = job.stock,
    p = job.placement;
  return {
    name: job.name,
    boardRevision: job.boardRevision,
    face: job.face,
    stockX: numberText(s.x),
    stockY: numberText(s.y),
    width: numberText(s.width),
    height: numberText(s.height),
    thickness: numberText(s.thickness),
    margin: numberText(s.margin),
    spoil: numberText(s.spoilAllowance),
    placeX: numberText(p.x),
    placeY: numberText(p.y),
    angle: numberText(p.angle),
    tolerance: numberText(job.tolerance),
    mirror: p.mirror,
  };
}
function referenceValues(reference?: PcbReference): ReferenceDraft {
  return {
    designX: numberText(reference?.design?.[0]),
    designY: numberText(reference?.design?.[1]),
    machineX: numberText(reference?.machine?.[0]),
    machineY: numberText(reference?.machine?.[1]),
  };
}
function operationValues(op: PcbOperation): OperationDraft {
  return {
    role: op.role,
    tool: op.tool,
    diameter: op.diameter == null ? "" : String(op.diameter),
  };
}
function finiteNumber(value: string, name: string) {
  const result = Number(value);
  if (!value.trim() || !Number.isFinite(result) || Math.abs(result) > 100000)
    throw new Error(`${name} must be a number within ±100000.`);
  return result;
}
function validText(value: string, name: string) {
  if (value.length > 120 || /[\x00-\x1f]/.test(value))
    throw new Error(`${name} must be text, up to 120 characters.`);
  return value;
}
function settingsFromDraft(draft: BoardDraft) {
  const stock = {
    x: finiteNumber(draft.stockX, "Stock X"),
    y: finiteNumber(draft.stockY, "Stock Y"),
    width: finiteNumber(draft.width, "Width"),
    height: finiteNumber(draft.height, "Height"),
    thickness: finiteNumber(draft.thickness, "Thickness"),
    margin: finiteNumber(draft.margin, "Edge margin"),
    spoilAllowance: finiteNumber(draft.spoil, "Spoilboard allowance"),
  };
  const placement = {
    x: finiteNumber(draft.placeX, "Placement X"),
    y: finiteNumber(draft.placeY, "Placement Y"),
    angle: finiteNumber(draft.angle, "Rotation"),
    mirror: draft.mirror,
  };
  const tolerance = finiteNumber(draft.tolerance, "Alignment tolerance");
  if (
    stock.width < 0.1 ||
    stock.width > 1000 ||
    stock.height < 0.1 ||
    stock.height > 1000
  )
    throw new Error("Stock width and height must be 0.1–1000 mm.");
  if (stock.thickness < 0.01 || stock.thickness > 100)
    throw new Error("Stock thickness must be 0.01–100 mm.");
  if (
    stock.margin < 0 ||
    stock.margin >= Math.min(stock.width, stock.height) / 2
  )
    throw new Error(
      "Edge margin must be non-negative and less than half the smaller stock dimension.",
    );
  if (stock.spoilAllowance < 0 || stock.spoilAllowance > 3)
    throw new Error("Spoilboard allowance must be 0–3 mm.");
  if (Math.abs(placement.angle) > 360)
    throw new Error("Rotation must be between −360° and 360°.");
  if (tolerance < 0.005 || tolerance > 0.5)
    throw new Error("Alignment check tolerance must be 0.005–0.5 mm.");
  if (!["top", "bottom"].includes(draft.face))
    throw new Error("Choose the machining face.");
  return {
    name: validText(draft.name, "Job name"),
    boardRevision: validText(draft.boardRevision, "Board revision"),
    face: draft.face,
    stock,
    placement,
    tolerance,
  };
}

export function PcbWorkspace({ active }: { active: boolean }) {
  const {
    job: rawJob,
    state,
    online,
    pending,
    activeHold,
    client,
    post,
    navigate,
    section,
    modalOpen,
    dirty,
    setDirty,
    importFiles,
    openPackage,
    savePackage,
    jobGeneration,
  } = useWorkbench();
  const job = rawJob as PcbJob | null;
  const root = useRef<HTMLDivElement>(null);
  const generation = useRef(jobGeneration);
  const dirtyReporter = useRef(setDirty);
  dirtyReporter.current = setDirty;
  const [boardDraft, setBoardDraft] = useState<BoardDraft | null>(null);
  const [referenceDrafts, setReferenceDrafts] = useState<
    Partial<Record<ReferenceLabel, ReferenceDraft>>
  >({});
  const [operationDrafts, setOperationDrafts] = useState<
    Record<string, OperationDraft>
  >({});
  const [visible, setVisible] = useState<Record<string, boolean>>({});
  const [label, setLabel] = useState<ReferenceLabel>("A");
  const [picking, setPicking] = useState(false);
  const [inspector, setInspector] = useState<Inspector>("setup");
  const [savedId, setSavedId] = useState("");
  const [reviewedAt, setReviewedAt] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const boardDirty = boardDraft !== null;
  const referenceDirty = Object.keys(referenceDrafts).length > 0;
  const operationsDirty = Object.keys(operationDrafts).length > 0;
  const localDirty = boardDirty || referenceDirty || operationsDirty;
  const edits = dirty || localDirty;
  const stale =
    state?.pcbRevision != null && job?.revision !== state.pcbRevision;
  const locked =
    !active ||
    !online ||
    pending ||
    !!state?.busy ||
    !!activeHold ||
    modalOpen ||
    !job ||
    stale;
  const live = !locked && state?.armed === true && state?.phase === "teach";
  const canDraft =
    !locked &&
    (live ||
      (state?.phase === "complete" &&
        !state?.preparationClosed &&
        state?.continuityActive));
  const reviewKey = JSON.stringify([
    job?.revision,
    state?.sessionId,
    job?.canExport,
    state?.armed,
    state?.phase,
    state?.preparationClosed,
    state?.continuityActive,
  ]);
  const reviewed = reviewedAt === reviewKey && !edits && canDraft;

  // Null means follow the authoritative snapshot. Non-null drafts are never
  // repopulated by polls. Each reference keeps its own draft, including C.
  useEffect(() => {
    dirtyReporter.current("pcb-board", boardDirty);
  }, [boardDirty]);
  useEffect(() => {
    dirtyReporter.current("pcb-reference", referenceDirty);
  }, [referenceDirty]);
  useEffect(() => {
    dirtyReporter.current("pcb-operations", operationsDirty);
  }, [operationsDirty]);
  useEffect(
    () => () => {
      dirtyReporter.current("pcb-board", false);
      dirtyReporter.current("pcb-reference", false);
      dirtyReporter.current("pcb-operations", false);
    },
    [],
  );
  useEffect(() => {
    if (generation.current === jobGeneration) return;
    generation.current = jobGeneration;
    setBoardDraft(null);
    setReferenceDrafts({});
    setOperationDrafts({});
    setVisible({});
    setPicking(false);
    setReviewedAt(null);
    setMessage(null);
    setProblem(null);
    setLabel("A");
  }, [jobGeneration]);
  useEffect(() => {
    if (!job) return;
    const ids = new Set(job.operations.map((op) => op.id));
    setOperationDrafts((current) =>
      Object.keys(current).some((id) => !ids.has(id))
        ? Object.fromEntries(
            Object.entries(current).filter(([id]) => ids.has(id)),
          )
        : current,
    );
    setVisible((current) =>
      Object.keys(current).some((id) => !ids.has(id))
        ? Object.fromEntries(
            Object.entries(current).filter(([id]) => ids.has(id)),
          )
        : current,
    );
  }, [job?.operations]);
  useEffect(() => {
    if (edits || !online || !canDraft) setReviewedAt(null);
  }, [edits, online, canDraft]);
  useEffect(() => {
    if (!active || modalOpen || boardDirty || !online) setPicking(false);
  }, [active, modalOpen, boardDirty, online]);
  useEffect(() => {
    if (!active || !section) return;
    const destination: Record<string, Inspector> = {
      pcbSetupSection: "setup",
      pcbAlignmentSection: "alignment",
      pcbReviewSection: "review",
    };
    if (destination[section]) setInspector(destination[section]);
    // Allow Tabs to mount the requested section before scrolling the independent pane.
    const frame = requestAnimationFrame(() =>
      root.current
        ?.querySelector<HTMLElement>(
          `[id="${section.replace(/[^a-zA-Z0-9_-]/g, "")}"]`,
        )
        ?.scrollIntoView({ block: "nearest" }),
    );
    return () => cancelAnimationFrame(frame);
  }, [active, section]);

  function fail(error: unknown) {
    const text =
      error instanceof Error
        ? error.message
        : "The PCB action could not finish.";
    setProblem(text);
    client.setError(text);
  }
  async function run(
    action: string,
    body: Record<string, unknown> = {},
    receive?: (result: any) => void,
  ) {
    if (locked) return false;
    setProblem(null);
    setMessage(null);
    setReviewedAt(null);
    return post(action, body, receive);
  }
  function editBoard<K extends keyof BoardDraft>(key: K, value: BoardDraft[K]) {
    if (!job || locked) return;
    setBoardDraft((current) => ({
      ...(current ?? boardValues(job)),
      [key]: value,
    }));
    setReviewedAt(null);
  }
  function editReference(key: keyof ReferenceDraft, value: string) {
    if (!job || locked) return;
    setReferenceDrafts((current) => ({
      ...current,
      [label]: {
        ...(current[label] ?? referenceValues(job.references[label])),
        [key]: value,
      },
    }));
    setReviewedAt(null);
  }
  function editOperation(op: PcbOperation, update: Partial<OperationDraft>) {
    if (locked) return;
    setOperationDrafts((current) => ({
      ...current,
      [op.id]: { ...(current[op.id] ?? operationValues(op)), ...update },
    }));
    setReviewedAt(null);
  }
  async function applyBoard(event: FormEvent) {
    event.preventDefault();
    if (!job || locked) return;
    try {
      const submitted = boardDraft;
      if (
        await run("pcb-configure", {
          settings: settingsFromDraft(boardDraft ?? boardValues(job)),
        })
      ) {
        setBoardDraft((current) => (current === submitted ? null : current));
        setMessage(
          "Setup applied. Check the current alignment and preparation issues.",
        );
      }
    } catch (error) {
      fail(error);
    }
  }
  async function saveReference(capture: boolean) {
    if (!job || locked || boardDirty || (capture && !live)) return;
    const submittedLabel = label,
      submitted = referenceDrafts[label];
    const values = submitted ?? referenceValues(job.references[label]);
    try {
      const design = [
        finiteNumber(values.designX, "Design X"),
        finiteNumber(values.designY, "Design Y"),
      ];
      // Capture sends design coordinates only. The server reads stationary machine
      // XY itself and attaches the current session; typed XY can only create a draft.
      const body = capture
        ? { label, design }
        : {
            label,
            design,
            machine: [
              finiteNumber(values.machineX, "Observed machine X"),
              finiteNumber(values.machineY, "Observed machine Y"),
            ],
          };
      if (await run(capture ? "pcb-capture" : "pcb-reference", body)) {
        setReferenceDrafts((current) => {
          if (current[submittedLabel] !== submitted) return current;
          const next = { ...current };
          delete next[submittedLabel];
          return next;
        });
        setMessage(
          capture
            ? `${submittedLabel}: current cutter XY captured. Solve alignment after recording A, B and C.`
            : `${submittedLabel}: manual draft saved. Fresh capture is required for export.`,
        );
      }
    } catch (error) {
      fail(error);
    }
  }
  async function applyOperation(op: PcbOperation) {
    if (locked) return;
    const submitted = operationDrafts[op.id],
      values = submitted ?? operationValues(op);
    try {
      const diameter =
        values.diameter.trim() === ""
          ? null
          : finiteNumber(values.diameter, "Effective cutting diameter");
      if (diameter !== null && (diameter < 0.01 || diameter > 20))
        throw new Error("Effective cutting diameter must be 0.01–20 mm.");
      if (
        await run("pcb-operation", {
          id: op.id,
          role: values.role,
          tool: validText(values.tool, "Cutter description"),
          diameter,
        })
      ) {
        setOperationDrafts((current) => {
          if (current[op.id] !== submitted) return current;
          const next = { ...current };
          delete next[op.id];
          return next;
        });
      }
    } catch (error) {
      fail(error);
    }
  }
  async function exportDraft() {
    if (!job?.canExport || !canDraft || edits || !reviewed) return;
    try {
      await run("pcb-export", { reviewed: true }, (result) => {
        if (
          typeof result?.archive !== "string" ||
          typeof result?.filename !== "string"
        )
          throw new Error("The export response did not contain an archive.");
        const decoded = atob(result.archive),
          bytes = new Uint8Array(decoded.length);
        for (let index = 0; index < decoded.length; index++)
          bytes[index] = decoded.charCodeAt(index);
        downloadFile(result.filename, bytes, "application/zip");
        setMessage(
          "Aligned draft downloaded. Inspect each operation in UGS; Z and height compensation still need review.",
        );
      });
    } catch (error) {
      fail(error);
    }
  }

  if (!job) return <Notice>Loading the PCB workspace…</Notice>;
  const board = boardDraft ?? boardValues(job);
  const reference =
    referenceDrafts[label] ?? referenceValues(job.references[label]);
  const savedJobs = job.savedJobs ?? [];
  const selectedSavedId = savedJobs.some((saved) => saved.id === savedId)
    ? savedId
    : (savedJobs[0]?.id ?? "");
  const fieldNumber = (
    key: Exclude<
      keyof BoardDraft,
      "name" | "boardRevision" | "face" | "mirror"
    >,
    id: string,
    caption: string,
    limits: { min?: number; max?: number } = {},
  ) => (
    <NumberField
      id={id}
      key={id}
      label={caption}
      value={board[key]}
      disabled={locked}
      required
      {...limits}
      onChange={(event) => editBoard(key, event.target.value)}
    />
  );
  const alignmentCurrent =
    job.alignment?.status === "captured" &&
    !!state?.sessionId &&
    job.alignment.session === state.sessionId;
  return (
    <div
      ref={root}
      className="pcb-workspace flex min-h-0 min-w-0 flex-1 flex-col gap-3 p-4 text-[13px] lg:h-full lg:overflow-auto"
    >
      <div className="flex flex-wrap items-center gap-2" aria-label="PCB files">
        <Button
          id="pcbImport"
          size="sm"
          disabled={locked}
          onClick={importFiles}
        >
          <FolderPlus />
          Add cutting files
        </Button>
        <Button
          id="pcbOpen"
          size="sm"
          variant="outline"
          disabled={locked}
          onClick={openPackage}
        >
          <FolderOpen />
          Open package
        </Button>
        <Button
          id="pcbSave"
          size="sm"
          variant="outline"
          disabled={
            locked ||
            edits ||
            !(job as PcbJob & { hasContent?: boolean }).hasContent
          }
          onClick={async () => {
            setProblem(null);
            setReviewedAt(null);
            try {
              if (await savePackage())
                setMessage(
                  "Job package saved. Reopening requires fresh machine references.",
                );
            } catch (error) {
              fail(error);
            }
          }}
        >
          <Save />
          Save job package
        </Button>
        <Button
          id="pcbExample"
          size="sm"
          variant="ghost"
          disabled={locked}
          onClick={() => void run("pcb-example")}
        >
          <FileCode />
          Load rectangle example
        </Button>
        <Button
          id="pcbNew"
          size="sm"
          variant="ghost"
          disabled={locked}
          onClick={() => void run("pcb-new")}
        >
          <Plus />
          New empty job
        </Button>
      </div>
      {savedJobs.length > 0 && (
        <div id="pcbResume" className="flex flex-wrap items-end gap-2">
          <SelectField
            id="pcbSaved"
            label="Saved on this computer"
            value={selectedSavedId}
            disabled={locked}
            options={savedJobs.map((saved) => ({
              value: saved.id,
              label: saved.label,
            }))}
            onChange={(event) => setSavedId(event.target.value)}
          />
          <Button
            id="pcbLoadSaved"
            size="sm"
            variant="outline"
            disabled={locked || !selectedSavedId}
            onClick={() => void run("pcb-load", { savedId: selectedSavedId })}
          >
            Open saved job
          </Button>
        </div>
      )}
      <p
        id="pcbStatus"
        role="status"
        className="break-words text-xs leading-relaxed text-muted-foreground"
      >
        {message ?? job.note}
        {job.lastSaved && (
          <span className="block break-all">Last saved: {job.lastSaved}</span>
        )}
      </p>
      {problem && <Notice tone="error">{problem}</Notice>}
      <div className="grid min-h-0 min-w-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(280px,318px)]">
        <div className="flex min-h-0 min-w-0 flex-col gap-3">
          <ToolpathPreview
            key={jobGeneration}
            active={active && !modalOpen}
            job={job}
            visible={visible}
            machine={online ? (state?.status?.machineCoord ?? null) : null}
            picking={picking && !locked && !boardDirty}
            onPick={(point, snapped) => {
              if (locked || boardDirty) return;
              setReferenceDrafts((current) => ({
                ...current,
                [label]: {
                  ...(current[label] ?? referenceValues(job.references[label])),
                  designX: numberText(point[0]),
                  designY: numberText(point[1]),
                },
              }));
              setReviewedAt(null);
              setPicking(false);
              setInspector("alignment");
              setMessage(
                snapped
                  ? "Selected an actual toolpath point. Match it to the same physical reference."
                  : "Approximate point selected. Enter exact design coordinates before capturing.",
              );
            }}
          />
          <section
            id="pcbOperationsSection"
            className="min-h-[170px] min-w-0 scroll-mt-3 overflow-auto rounded-lg border bg-card p-4 lg:max-h-[min(30vh,300px)]"
            aria-labelledby="pcbOperationsHeading"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="pcbOperationsHeading" className="text-sm font-semibold">
                Operations &amp; cutters
              </h2>
              {operationsDirty && (
                <Badge variant="secondary">Unapplied cutter edits</Badge>
              )}
            </div>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Keep files from one machining face together. Each cutter change
              needs its own Z reference. Show changes the preview only; export
              includes every operation.
            </p>
            <div id="pcbOperations" className="mt-3 divide-y">
              {!job.operations.length && (
                <p className="py-3 text-muted-foreground">
                  No files loaded. Convert Gerber and Excellon files with your
                  CAM tool before import.
                </p>
              )}
              {job.operations.map((op, index) => {
                const draft = operationDrafts[op.id] ?? operationValues(op);
                return (
                  <article
                    key={op.id}
                    className="pcb-operation space-y-3 py-3 first:pt-0"
                    data-operation-id={op.id}
                  >
                    <div className="flex flex-wrap items-start gap-2">
                      <h3 className="min-w-0 flex-1 break-all text-[13px] font-medium">
                        {index + 1}. {op.name}
                      </h3>
                      <CheckField
                        className="!my-0"
                        label="Show"
                        aria-label={`Show ${op.name}`}
                        checked={visible[op.id] !== false}
                        disabled={locked}
                        onCheckedChange={(value) =>
                          setVisible((current) => ({
                            ...current,
                            [op.id]: value === true,
                          }))
                        }
                      />
                    </div>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      Depth {formatNumber(Math.max(0, -op.cutBounds.z[0]))} mm ·{" "}
                      {formatNumber(op.feedMinutes, 1)} min feed motion
                      (excludes rapids, pauses and setup) ·{" "}
                      {op.diameter === null
                        ? "Cutter size needed for footprint check"
                        : op.fits
                          ? "Footprint inside margin"
                          : "Footprint outside margin"}
                    </p>
                    <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-[minmax(100px,1fr)_minmax(130px,2fr)_minmax(90px,1fr)]">
                      <SelectField
                        label="Operation"
                        aria-label={`Operation type for ${op.name}`}
                        value={draft.role}
                        options={roles}
                        disabled={locked}
                        onChange={(event) =>
                          editOperation(op, { role: event.target.value })
                        }
                      />
                      <Field label="Cutter" htmlFor={`pcb-tool-${op.id}`}>
                        <Input
                          id={`pcb-tool-${op.id}`}
                          aria-label={`Cutter for ${op.name}`}
                          placeholder="Cutter description"
                          maxLength={120}
                          value={draft.tool}
                          disabled={locked}
                          onChange={(event) =>
                            editOperation(op, { tool: event.target.value })
                          }
                        />
                      </Field>
                      <NumberField
                        id={`pcb-diameter-${op.id}`}
                        label="Effective Ø (mm)"
                        aria-label={`Cutting diameter for ${op.name}`}
                        placeholder="Not set"
                        value={draft.diameter}
                        min={0.01}
                        max={20}
                        disabled={locked}
                        onChange={(event) =>
                          editOperation(op, { diameter: event.target.value })
                        }
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        variant={operationDrafts[op.id] ? "default" : "outline"}
                        disabled={locked}
                        onClick={() => void applyOperation(op)}
                      >
                        Save cutter
                      </Button>
                      {operationDrafts[op.id] && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={locked}
                          onClick={() =>
                            setOperationDrafts((current) => {
                              const next = { ...current };
                              delete next[op.id];
                              return next;
                            })
                          }
                        >
                          Discard cutter edits
                        </Button>
                      )}
                      <div className="ml-auto flex items-center gap-1">
                        <Button
                          size="icon-sm"
                          variant="outline"
                          aria-label={`up ${op.name}`}
                          title="Move operation up"
                          disabled={locked || index === 0}
                          onClick={() =>
                            void run("pcb-operation", {
                              id: op.id,
                              action: "up",
                            })
                          }
                        >
                          <ArrowUp />
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="outline"
                          aria-label={`down ${op.name}`}
                          title="Move operation down"
                          disabled={
                            locked || index === job.operations.length - 1
                          }
                          onClick={() =>
                            void run("pcb-operation", {
                              id: op.id,
                              action: "down",
                            })
                          }
                        >
                          <ArrowDown />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`remove ${op.name}`}
                          disabled={locked}
                          onClick={() =>
                            void run("pcb-operation", {
                              id: op.id,
                              action: "remove",
                            })
                          }
                        >
                          <Trash2 />
                          Remove
                        </Button>
                      </div>
                    </div>
                    <Collapsible>
                      <CollapsibleTrigger asChild>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-auto px-0 text-xs text-muted-foreground"
                        >
                          Source checks <ChevronDown className="size-3" />
                        </Button>
                      </CollapsibleTrigger>
                      <CollapsibleContent className="space-y-2 pt-2 text-xs leading-relaxed text-muted-foreground">
                        <p className="break-all font-mono">
                          SHA-256 {op.sha256}
                        </p>
                        <p>
                          {op.lineCount} source lines · maximum feed{" "}
                          {formatNumber(op.maxFeed, 1)} mm/min · maximum spindle
                          command {formatNumber(op.maxSpindle, 0)}
                        </p>
                        {op.warnings.map((warning, warningIndex) => (
                          <p key={warningIndex}>{warning}</p>
                        ))}
                      </CollapsibleContent>
                    </Collapsible>
                  </article>
                );
              })}
            </div>
          </section>
        </div>
        <aside
          className="min-h-0 min-w-0 overflow-auto rounded-lg border bg-card"
          aria-label="PCB inspector"
        >
          <Tabs
            value={inspector}
            onValueChange={(value) => setInspector(value as Inspector)}
            className="gap-0"
          >
            <div className="sticky top-0 z-10 border-b bg-card p-2">
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="setup">Stock</TabsTrigger>
                <TabsTrigger value="alignment">Alignment</TabsTrigger>
                <TabsTrigger value="review">UGS draft</TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value="setup" className="p-4">
              <section
                id="pcbSetupSection"
                className="scroll-mt-14 space-y-4"
                aria-labelledby="pcbSetupHeading"
              >
                <div>
                  <h2 id="pcbSetupHeading" className="text-sm font-semibold">
                    Stock &amp; orientation
                  </h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    All dimensions and coordinates are in millimetres.
                  </p>
                </div>
                <form
                  onSubmit={(event) => void applyBoard(event)}
                  className="space-y-4"
                >
                  <Field label="Job name" htmlFor="pcbName">
                    <Input
                      id="pcbName"
                      value={board.name}
                      maxLength={120}
                      disabled={locked}
                      onChange={(event) =>
                        editBoard("name", event.target.value)
                      }
                    />
                  </Field>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Board revision" htmlFor="pcbBoardRevision">
                      <Input
                        id="pcbBoardRevision"
                        value={board.boardRevision}
                        maxLength={120}
                        disabled={locked}
                        onChange={(event) =>
                          editBoard("boardRevision", event.target.value)
                        }
                      />
                    </Field>
                    <SelectField
                      label="Machining face"
                      id="pcbFace"
                      options={[
                        { value: "bottom", label: "Bottom" },
                        { value: "top", label: "Top" },
                      ]}
                      value={board.face}
                      disabled={locked}
                      onChange={(event) =>
                        editBoard("face", event.target.value)
                      }
                    />
                    {fieldNumber("stockX", "pcbStockX", "Stock X")}
                    {fieldNumber("stockY", "pcbStockY", "Stock Y")}
                    {fieldNumber("width", "pcbWidth", "Width (mm)", {
                      min: 0.1,
                      max: 1000,
                    })}
                    {fieldNumber("height", "pcbHeight", "Height (mm)", {
                      min: 0.1,
                      max: 1000,
                    })}
                    {fieldNumber("thickness", "pcbThickness", "Thickness", {
                      min: 0.01,
                      max: 100,
                    })}
                    {fieldNumber("margin", "pcbMargin", "Edge margin", {
                      min: 0,
                    })}
                  </div>
                  {fieldNumber(
                    "spoil",
                    "pcbSpoil",
                    "Allowed cut into spoilboard (mm)",
                    { min: 0, max: 3 },
                  )}
                  <Button
                    type="button"
                    id="pcbUseArea"
                    size="sm"
                    variant="outline"
                    className="h-auto min-h-8 w-full whitespace-normal"
                    disabled={!live || !state?.area || boardDirty}
                    onClick={() => void run("pcb-stock-from-area")}
                  >
                    Use taught usable rectangle
                  </Button>
                  <div className="space-y-3 border-t pt-4">
                    <h3 className="text-[13px] font-medium">Draft placement</h3>
                    <div className="grid grid-cols-2 gap-3">
                      {fieldNumber("placeX", "pcbPlaceX", "Origin machine X")}
                      {fieldNumber("placeY", "pcbPlaceY", "Origin machine Y")}
                      {fieldNumber("angle", "pcbAngle", "Rotation (°)", {
                        min: -360,
                        max: 360,
                      })}
                      {fieldNumber(
                        "tolerance",
                        "pcbTolerance",
                        "Check tolerance (mm)",
                        { min: 0.005, max: 0.5 },
                      )}
                    </div>
                    <CheckField
                      id="pcbMirror"
                      label="Mirror X about the job origin"
                      checked={board.mirror}
                      disabled={locked}
                      onCheckedChange={(value) =>
                        editBoard("mirror", value === true)
                      }
                    />
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      The face selector does not mirror files. Bottom CAM may
                      already be mirrored; use an asymmetric feature to verify
                      handedness.
                    </p>
                  </div>
                  <Button
                    type="submit"
                    id="pcbApply"
                    className="h-auto min-h-9 w-full whitespace-normal"
                    disabled={locked}
                  >
                    Apply setup &amp; placement
                  </Button>
                  <p
                    id="pcbDirty"
                    hidden={!boardDirty}
                    className="text-xs leading-relaxed text-muted-foreground"
                  >
                    Unapplied edits. The preview shows the applied setup. Apply
                    these edits before alignment, saving or export.
                  </p>
                  {boardDirty && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={locked}
                      onClick={() => setBoardDraft(null)}
                    >
                      Discard setup edits
                    </Button>
                  )}
                </form>
              </section>
            </TabsContent>
            <TabsContent value="alignment" className="p-4">
              <section
                id="pcbAlignmentSection"
                className="scroll-mt-14 space-y-4"
                aria-labelledby="pcbAlignmentHeading"
              >
                <div>
                  <h2
                    id="pcbAlignmentHeading"
                    className="text-sm font-semibold"
                  >
                    Teach board alignment
                  </h2>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    A and B set position and rotation without scaling. Choose
                    points at least 5 mm apart. C checks the result
                    independently, at least 1 mm away from the A–B line.
                  </p>
                </div>
                <Table id="pcbReferenceTable" className="text-xs">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Point</TableHead>
                      <TableHead>Design XY</TableHead>
                      <TableHead>Machine XY</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {labels.map((name) => {
                      const saved = job.references[name],
                        current =
                          saved?.session && saved.session === state?.sessionId;
                      return (
                        <TableRow key={name}>
                          <TableCell className="align-top font-medium">
                            {name}
                            {referenceDrafts[name] && (
                              <span className="block text-muted-foreground">
                                Edited
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="align-top font-mono">
                            {saved?.design ? (
                              <>
                                {formatNumber(saved.design[0])}
                                <br />
                                {formatNumber(saved.design[1])}
                              </>
                            ) : (
                              "Not set"
                            )}
                          </TableCell>
                          <TableCell className="align-top">
                            <span className="font-mono">
                              {saved?.machine ? (
                                <>
                                  {formatNumber(saved.machine[0])}
                                  <br />
                                  {formatNumber(saved.machine[1])}
                                </>
                              ) : (
                                "Not captured"
                              )}
                            </span>
                            {saved?.machine && (
                              <span className="block text-muted-foreground">
                                {current
                                  ? "Captured"
                                  : saved.session
                                    ? "Previous session"
                                    : "Draft"}
                              </span>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
                <SelectField
                  id="pcbRefLabel"
                  label="Reference to edit"
                  value={label}
                  options={labels.map((value) => ({
                    value,
                    label: value === "C" ? "C · independent check" : value,
                  }))}
                  disabled={locked}
                  onChange={(event) => {
                    setLabel(event.target.value as ReferenceLabel);
                    setPicking(false);
                  }}
                />
                <div className="grid grid-cols-2 gap-3">
                  <NumberField
                    id="pcbDesignX"
                    label="Design X"
                    value={reference.designX}
                    disabled={locked}
                    onChange={(event) =>
                      editReference("designX", event.target.value)
                    }
                  />
                  <NumberField
                    id="pcbDesignY"
                    label="Design Y"
                    value={reference.designY}
                    disabled={locked}
                    onChange={(event) =>
                      editReference("designY", event.target.value)
                    }
                  />
                </div>
                <Button
                  id="pcbPick"
                  variant={picking ? "secondary" : "outline"}
                  size="sm"
                  className="w-full"
                  aria-pressed={picking}
                  disabled={locked || boardDirty || !job.operations.length}
                  onClick={() => setPicking((value) => !value)}
                >
                  {picking
                    ? "Click a known point… · cancel"
                    : "Pick on preview"}
                </Button>
                <div className="grid grid-cols-2 gap-3">
                  <NumberField
                    id="pcbMachineX"
                    label="Observed machine X"
                    value={reference.machineX}
                    disabled={locked}
                    onChange={(event) =>
                      editReference("machineX", event.target.value)
                    }
                  />
                  <NumberField
                    id="pcbMachineY"
                    label="Observed machine Y"
                    value={reference.machineY}
                    disabled={locked}
                    onChange={(event) =>
                      editReference("machineY", event.target.value)
                    }
                  />
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Entered machine values are a draft. Capture reads the
                  stationary cutter XY from the current machine session and
                  replaces these values.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    id="pcbReference"
                    size="sm"
                    variant="outline"
                    disabled={locked || boardDirty}
                    onClick={() => void saveReference(false)}
                  >
                    Save draft point
                  </Button>
                  <Button
                    id="pcbCapture"
                    size="sm"
                    className="h-auto min-h-8 whitespace-normal"
                    disabled={!live || boardDirty}
                    onClick={() => void saveReference(true)}
                  >
                    Capture current cutter XY
                  </Button>
                  <Button
                    id="pcbOpenJog"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      client.releaseHold();
                      navigate("surface");
                    }}
                  >
                    Open jog controls
                  </Button>
                </div>
                <p
                  id="pcbCaptureHint"
                  className="text-xs leading-relaxed text-muted-foreground"
                >
                  {live
                    ? "Capture reads position; it does not move the machine."
                    : "Enable teaching in Jog & surface mapping to capture live references. Manual coordinates remain a draft."}
                </p>
                {referenceDrafts[label] && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={locked}
                    onClick={() =>
                      setReferenceDrafts((current) => {
                        const next = { ...current };
                        delete next[label];
                        return next;
                      })
                    }
                  >
                    Discard {label} edits
                  </Button>
                )}
                {referenceDirty && (
                  <p className="text-xs text-muted-foreground">
                    Unsaved points:{" "}
                    {labels.filter((name) => referenceDrafts[name]).join(", ")}.
                    Save or capture each point before solving.
                  </p>
                )}
                <Button
                  id="pcbSolve"
                  className="h-auto min-h-9 w-full whitespace-normal"
                  disabled={
                    locked ||
                    edits ||
                    !(job as PcbJob & { hasContent?: boolean }).hasContent
                  }
                  onClick={() => void run("pcb-solve")}
                >
                  Solve &amp; check alignment
                </Button>
                <p
                  id="pcbAlignmentResult"
                  role="status"
                  className="text-xs leading-relaxed text-muted-foreground"
                >
                  {job.alignment ? (
                    <>
                      {alignmentCurrent
                        ? "Captured alignment"
                        : job.alignment.status === "captured"
                          ? "Previous-session alignment"
                          : "Draft alignment"}{" "}
                      · rotation {formatNumber(job.placement.angle, 4)}° · A–B
                      spacing error {formatNumber(job.alignment.baselineError)}{" "}
                      mm · C error{" "}
                      {job.alignment.checkError == null
                        ? "not checked"
                        : `${formatNumber(job.alignment.checkError)} mm`}
                    </>
                  ) : (
                    "Alignment has not been checked."
                  )}
                </p>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  C is an independent check. Camera crosshairs are not
                  calibrated reference points. Reopening a job or reconnecting
                  requires fresh machine references.
                </p>
              </section>
            </TabsContent>
            <TabsContent value="review" className="p-4">
              <section
                id="pcbReviewSection"
                className="scroll-mt-14 space-y-4"
                aria-labelledby="pcbReviewHeading"
              >
                <h2 id="pcbReviewHeading" className="text-sm font-semibold">
                  Before UGS
                </h2>
                <ul
                  id="pcbIssues"
                  className="list-disc space-y-2 pl-4 text-xs leading-relaxed text-muted-foreground"
                >
                  {(job.issues.length
                    ? job.issues
                    : [
                        "Geometry checks passed. Continue with Z, compensation and the physical setup review in UGS.",
                      ]
                  ).map((issue, index) => (
                    <li key={index}>{issue}</li>
                  ))}
                </ul>
                <p
                  id="pcbScanArea"
                  className="text-xs leading-relaxed text-muted-foreground"
                >
                  {job.cutBounds ? (
                    <>
                      Toolpath bounds in machine XY: X{" "}
                      {job.cutBounds.x
                        .map((value) => formatNumber(value))
                        .join(" to ")}
                      ; Y{" "}
                      {job.cutBounds.y
                        .map((value) => formatNumber(value))
                        .join(" to ")}{" "}
                      mm. Cover these paths when planning the copper scan.
                    </>
                  ) : (
                    "Toolpath bounds will appear after files are loaded."
                  )}
                </p>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Copper scanning uses the actual copper face and zero puck
                  thickness. Select the correct contact method in surface
                  mapping.
                </p>
                <CheckField
                  id="pcbReviewed"
                  label="I checked the files, face, stock and cutters. I will verify Z, height compensation and clearance in UGS before cutting."
                  checked={reviewed}
                  disabled={locked || edits || !job.canExport || !canDraft}
                  onCheckedChange={(value) =>
                    setReviewedAt(value === true ? reviewKey : null)
                  }
                />
                <Button
                  id="pcbExport"
                  className="h-auto min-h-9 w-full whitespace-normal"
                  disabled={!canDraft || edits || !job.canExport || !reviewed}
                  onClick={() => void exportDraft()}
                >
                  <Download />
                  Download aligned draft
                </Button>
                {edits && (
                  <p className="text-xs text-muted-foreground">
                    Apply or discard all local edits before saving or exporting.
                  </p>
                )}
                {!canDraft && (
                  <p className="text-xs text-muted-foreground">
                    Export needs fresh alignment in the teaching session, or a
                    completed scan with reference monitoring still active.
                  </p>
                )}
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Exports separate operation files in the current G54 XY frame,
                  with a startup pause. Source Z and height compensation are
                  unchanged. Nothing is loaded or sent to UGS.
                </p>
              </section>
            </TabsContent>
          </Tabs>
        </aside>
      </div>
    </div>
  );
}
