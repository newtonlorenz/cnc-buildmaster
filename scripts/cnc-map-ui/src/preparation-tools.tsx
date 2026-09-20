import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Button } from "./components/ui/button";
import { Task, TaskContent, TaskTrigger } from "./components/ai-elements/task";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import { Label } from "./components/ui/label";
import { NativeSelect } from "./components/ui/native-select";
import { Badge } from "./components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./components/ui/tabs";
import { CheckField } from "./components/workbench-controls";

type Values = Record<string, string>;
type RecordValue = Record<string, any>;
type Post = (
  action: string,
  body: RecordValue,
  receive: (result: RecordValue) => void,
) => Promise<boolean>;
type Run = (
  action: string,
  body: RecordValue,
  receive?: (result: RecordValue) => void,
  message?: string,
) => Promise<boolean>;
type NumericField = readonly [
  key: string,
  label: string,
  min?: number,
  max?: number,
];
type Fixture = {
  bounds: { x: number[]; y: number[]; z: number[] };
  clearance: number;
  clamps: {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    baseZ: number;
    heightZ: number;
  }[];
};
export type PreparationJob = {
  name?: string;
  boardRevision?: string;
  face?: string;
  placement?: RecordValue;
  stock?: { x: number; y: number; width: number; height: number };
  operations?: {
    id: string;
    name: string;
    tool?: string;
    diameter?: number | null;
    sha256?: string;
  }[];
  workflow?: {
    fixture?: Fixture | null;
    camera?: RecordValue | null;
    recipes?: RecordValue[];
    toolChecks?: RecordValue;
  };
};
export type PreparationToolsProps = {
  job: PreparationJob | null;
  disabled: boolean;
  post: Post;
  onMessage: (message: string) => void;
};

const TOOL: readonly NumericField[] = [
  ["diameter", "Maximum tool / shaft diameter (mm)", 0.01, 50],
  ["holderDiameter", "Holder diameter (mm)", 0.01, 100],
  ["length", "Exposed tip-to-holder length (mm)", 0.001, 300],
  ["cuttingLength", "Usable cutting length (mm)", 0.001, 300],
];
const PARAMETERS: readonly NumericField[] = [
  ["feed", "Cutting feed (mm/min)", 0.001, 3000],
  ["plungeFeed", "Plunge feed (mm/min)", 0.001, 300],
  ["depth", "Total depth below Z0 (mm)", 0.000001, 3],
  ["passDepth", "Depth per pass (mm)", 0.000001, 1],
  ["clearZ", "Clear Z above the material (mm)", 0.000001, 300],
  ["spindleCommand", "Spindle S command", 1, 1000000],
];
const ENVELOPE: readonly NumericField[] = [
  ["xmin", "Minimum machine X (mm)"],
  ["xmax", "Maximum machine X (mm)"],
  ["ymin", "Minimum machine Y (mm)"],
  ["ymax", "Maximum machine Y (mm)"],
  ["zmin", "Minimum tip Z from material (mm)"],
  ["zmax", "Maximum tip Z from material (mm)"],
  ["clearance", "Additional clearance margin (mm)", 0, 50],
];
const CLAMP: readonly NumericField[] = [
  ["x", "Machine X, left edge (mm)"],
  ["y", "Machine Y, lower edge (mm)"],
  ["width", "Width along X (mm)", 0.001, 1000],
  ["height", "Size along Y (mm)", 0.001, 1000],
  ["baseZ", "Base Z from material (mm)"],
  ["heightZ", "Clamp height (mm)", 0.001, 1000],
];
const REVIEWS = [
  ["machineReviewed", "Machine limits and coordinate directions reviewed"],
  [
    "toolReviewed",
    "Tool dimensions, plunge capability and intended cut reviewed",
  ],
  ["materialReviewed", "Material, depth and cutting parameters reviewed"],
  ["workholdingReviewed", "Workholding, clamps and clearance reviewed"],
  [
    "coordinateFrameReviewed",
    "G54 origin and material Z0 reviewed for this draft",
  ],
  [
    "spindleReviewed",
    "Clockwise spindle operation and S command scale reviewed",
  ],
] as const;
const TABS = ["Fixtures", "Tool changes", "Recipes", "Camera", "Wood"] as const;

function empty(fields: readonly NumericField[]): Values {
  return Object.fromEntries(fields.map(([key]) => [key, ""]));
}
function numeric(
  value: string | undefined,
  label: string,
  min = -100000,
  max = 100000,
): number {
  const n = value?.trim() ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < min || n > max)
    throw new Error(`Enter ${label.toLowerCase()} from ${min} to ${max}.`);
  return n;
}
function numbers(
  values: Values,
  fields: readonly NumericField[],
): Record<string, number> {
  return Object.fromEntries(
    fields.map(([key, label, min, max]) => [
      key,
      numeric(values[key], label, min, max),
    ]),
  );
}
function stringifyFields(
  value: RecordValue,
  fields: readonly NumericField[],
): Values {
  return Object.fromEntries(
    fields.map(([key]) => [key, value[key] == null ? "" : String(value[key])]),
  );
}
function fmt(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString(undefined, { maximumFractionDigits: 6 })
    : "—";
}
function operationIdentity(job: PreparationJob) {
  return job.operations?.map((op) => [op.id, op.sha256, op.tool, op.diameter]);
}
function NumericFields({
  fields,
  value,
  onChange,
}: {
  fields: readonly NumericField[];
  value: Values;
  onChange: (next: Values) => void;
}) {
  return (
    <div className="fields">
      {fields.map(([key, label, min = -100000, max = 100000]) => (
        <Label className="field flex-col items-stretch" key={key}>
          {label}
          <Input
            type="number"
            inputMode="decimal"
            required
            step="any"
            min={min}
            max={max}
            value={value[key] ?? ""}
            onChange={(e) => onChange({ ...value, [key]: e.target.value })}
          />
        </Label>
      ))}
    </div>
  );
}
function TextField({
  label,
  value,
  onChange,
  multiline = false,
  maxLength = 120,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  multiline?: boolean;
  maxLength?: number;
}) {
  return (
    <Label className="field flex-col items-stretch">
      {label}
      {multiline ? (
        <Textarea
          required
          maxLength={maxLength}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <Input
          required
          maxLength={maxLength}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Label>
  );
}
function Help({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Task className="task-disclosure" defaultOpen={false}>
      <TaskTrigger title={title}>
        <Button type="button" variant="ghost">
          {title}
        </Button>
      </TaskTrigger>
      <TaskContent>{children}</TaskContent>
    </Task>
  );
}
function SectionForm({
  locked,
  submit,
  children,
}: {
  locked: boolean;
  submit: () => void | Promise<unknown>;
  children: ReactNode;
}) {
  const [error, setError] = useState("");
  async function handle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked) return;
    setError("");
    try {
      await submit();
    } catch (problem) {
      setError(
        problem instanceof Error
          ? problem.message
          : "Check the entered values and try again.",
      );
    }
  }
  return (
    <form onSubmit={handle} onChange={() => setError("")}>
      <fieldset
        disabled={locked}
        style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
      >
        {children}
      </fieldset>
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
    </form>
  );
}

function fixtureValues(saved?: Fixture | null): Values {
  if (!saved) return empty(ENVELOPE);
  return {
    xmin: String(saved.bounds.x[0]),
    xmax: String(saved.bounds.x[1]),
    ymin: String(saved.bounds.y[0]),
    ymax: String(saved.bounds.y[1]),
    zmin: String(saved.bounds.z[0]),
    zmax: String(saved.bounds.z[1]),
    clearance: String(saved.clearance),
  };
}
function clampValues(saved?: Fixture | null): Values[] {
  return (
    saved?.clamps.map((c) => ({ id: c.id, ...stringifyFields(c, CLAMP) })) ?? []
  );
}

function Inspection({ value }: { value: RecordValue }) {
  const checks: RecordValue[] = Array.isArray(value.checks)
    ? value.checks
    : Array.isArray(value.operations)
      ? value.operations
      : [value];
  return (
    <div className="record-list" aria-live="polite">
      {checks.map((entry, index) => {
        const result = entry.inspection ?? entry.result ?? entry;
        return (
          <div key={entry.id ?? index} style={{ padding: "12px 0" }}>
            <strong>
              {entry.name ? `${entry.name}: ` : ""}
              {result.modelClear === true
                ? "No conflicts found in the model"
                : "Inspection needs review"}
            </strong>
            <p>
              {fmt(result.collisionCount)} clamp intersections ·{" "}
              {fmt(result.outsideCount)} paths outside bounds
            </p>
            {Array.isArray(result.collisions) &&
              result.collisions
                .slice(0, 12)
                .map((hit: RecordValue, i: number) => (
                  <p key={i}>
                    Line {hit.line}: {hit.rapid ? "rapid" : "feed"} path
                    intersects {hit.clampId} ({hit.components?.join(", ")}).
                  </p>
                ))}
            {Array.isArray(result.outsideBounds) &&
              result.outsideBounds
                .slice(0, 12)
                .map((hit: RecordValue, i: number) => (
                  <p key={i}>
                    Line {hit.line}: {hit.rapid ? "rapid" : "feed"} path exceeds
                    the declared bounds.
                  </p>
                ))}
            {(result.findingsTruncated ||
              result.collisions?.length > 12 ||
              result.outsideBounds?.length > 12) && (
              <p>
                Showing the first findings. Resolve these and inspect again.
              </p>
            )}
          </div>
        );
      })}
      <small>
        Initial approach and unmodelled machine parts are not checked. This does
        not qualify physical clearance.
      </small>
    </div>
  );
}

function Fixtures({ job, locked, run, tool, setTool }: SharedProps) {
  const saved = job.workflow?.fixture;
  const [envelope, setEnvelope] = useState(() => fixtureValues(saved));
  const [clamps, setClamps] = useState(() => clampValues(saved));
  const [dirty, setDirty] = useState(false);
  const [inspection, setInspection] = useState<{
    key: string;
    result: RecordValue;
  } | null>(null);
  const savedKey = JSON.stringify(saved);
  const checkKey = JSON.stringify([
    saved,
    job.stock,
    job.face,
    job.placement,
    operationIdentity(job),
    tool,
  ]);
  useEffect(() => {
    if (!dirty) {
      setEnvelope(fixtureValues(saved));
      setClamps(clampValues(saved));
    }
    // Keep a user's unsaved edits when the parent refreshes the same workspace.
  }, [savedKey]);
  const changeClamps = (next: Values[]) => {
    setClamps(next);
    setDirty(true);
  };
  async function save() {
    const v = numbers(envelope, ENVELOPE);
    const fixture = {
      bounds: { x: [v.xmin, v.xmax], y: [v.ymin, v.ymax], z: [v.zmin, v.zmax] },
      clearance: v.clearance,
      clamps: clamps.map((c) => ({ id: c.id.trim(), ...numbers(c, CLAMP) })),
    };
    if (clamps.some((c) => !c.id.trim()))
      throw new Error("Give each clamp a name.");
    if (
      await run(
        "pcb-fixture",
        { fixture },
        undefined,
        "Fixture saved as a planning record.",
      )
    )
      setDirty(false);
  }
  return (
    <>
      <h3>Fixture and clamp clearance</h3>
      <p>
        Enter measured bounds in <strong>machine XY</strong> and tip Z relative
        to <strong>material Z0</strong>. Every clamp uses that same frame.
      </p>
      <SectionForm locked={locked} submit={save}>
        <NumericFields
          fields={ENVELOPE}
          value={envelope}
          onChange={(v) => {
            setEnvelope(v);
            setDirty(true);
          }}
        />
        <div
          className="row"
          style={{ justifyContent: "space-between", flexWrap: "wrap" }}
        >
          <h3>
            Clamps <small>({clamps.length}/64)</small>
          </h3>
          <Button
            type="button"
            variant="outline"
            disabled={clamps.length >= 64}
            onClick={() =>
              changeClamps([...clamps, { id: "", ...empty(CLAMP) }])
            }
          >
            Add clamp
          </Button>
        </div>
        {!clamps.length && (
          <p className="notice">
            No clamps recorded. Add each raised obstruction before checking a
            path.
          </p>
        )}
        {clamps.map((clamp, index) => (
          <div key={index} className="record-list" style={{ paddingTop: 14 }}>
            <div className="row" style={{ alignItems: "end" }}>
              <div style={{ flex: 1 }}>
                <TextField
                  label={`Clamp ${index + 1} name`}
                  value={clamp.id}
                  onChange={(id) =>
                    changeClamps(
                      clamps.map((c, i) => (i === index ? { ...c, id } : c)),
                    )
                  }
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                aria-label={`Remove clamp ${clamp.id || index + 1}`}
                onClick={() =>
                  changeClamps(clamps.filter((_, i) => i !== index))
                }
              >
                Remove
              </Button>
            </div>
            <NumericFields
              fields={CLAMP}
              value={clamp}
              onChange={(v) =>
                changeClamps(clamps.map((c, i) => (i === index ? v : c)))
              }
            />
          </div>
        ))}
        <div className="actions">
          <Button type="submit">Save fixture</Button>
          <small>
            {dirty
              ? "Unsaved fixture changes"
              : saved
                ? "Saved planning record"
                : "No fixture saved yet"}
          </small>
        </div>
      </SectionForm>
      <Help title="What the clearance check includes">
        <p>
          The tool and holder are checked along complete path segments,
          including rapid and vertical moves. Clamp rectangles include the
          clearance margin and a 0.02 mm path allowance. XY bounds include the
          holder footprint; Z bounds apply to the tip.
        </p>
      </Help>
      <div className="record-list" style={{ paddingTop: 18 }}>
        <h3>Inspect the current tool paths</h3>
        <p>
          Use the largest exposed tool or shaft diameter. An engraving-width
          estimate is not enough for a clearance check. Repeat for each fitted
          cutter.
        </p>
        <SectionForm
          locked={locked}
          submit={() =>
            run(
              "pcb-fixture-check",
              { tool: numbers(tool, TOOL) },
              (result) =>
                setInspection({
                  key: checkKey,
                  result: result.inspection ?? result,
                }),
              "Fixture inspection complete.",
            )
          }
        >
          <NumericFields fields={TOOL} value={tool} onChange={setTool} />
          <Button
            type="submit"
            disabled={!saved || dirty || !job.operations?.length}
          >
            Inspect tool paths
          </Button>
          {(!saved || dirty || !job.operations?.length) && (
            <p className="inline-status">
              Save this fixture and load cutting files before inspecting paths.
            </p>
          )}
        </SectionForm>
        {inspection &&
          (inspection.key === checkKey && !dirty ? (
            <Inspection value={inspection.result} />
          ) : (
            <p className="notice">
              The fixture, tool or paths changed. Run the inspection again.
            </p>
          ))}
      </div>
    </>
  );
}

function ToolChanges({
  job,
  locked,
  run,
}: Pick<SharedProps, "job" | "locked" | "run">) {
  const operations = job.operations ?? [];
  const [selected, setSelected] = useState("");
  const [note, setNote] = useState("");
  const operationId = operations.some((op) => op.id === selected)
    ? selected
    : (operations[0]?.id ?? "");
  const notes = job.workflow?.toolChecks ?? {};
  return (
    <>
      <h3>Record a tool change</h3>
      <p>
        Record what you observed for a specific operation. A note does not
        establish or restore a valid material Z reference.
      </p>
      {!operations.length ? (
        <p className="notice">
          Load cutting files to attach a tool-change observation to an
          operation.
        </p>
      ) : (
        <SectionForm
          locked={locked}
          submit={async () => {
            if (
              await run(
                "pcb-tool-note",
                { operationId, note: note.trim() },
                undefined,
                "Tool-change observation recorded. Z remains a separate check.",
              )
            )
              setNote("");
          }}
        >
          <div className="fields">
            <Label className="field full flex-col items-stretch">
              Operation
              <NativeSelect
                value={operationId}
                onChange={(e) => {
                  setSelected(e.target.value);
                  setNote("");
                }}
              >
                {operations.map((op) => (
                  <option key={op.id} value={op.id}>
                    {op.name}
                    {op.tool ? ` · ${op.tool}` : ""}
                  </option>
                ))}
              </NativeSelect>
            </Label>
            <div className="full">
              <TextField
                label="Observed setup, measurement or unresolved issue"
                value={note}
                onChange={setNote}
                multiline
                maxLength={2000}
              />
            </div>
          </div>
          <Button type="submit" disabled={!note.trim()}>
            Save observation
          </Button>
        </SectionForm>
      )}
      <Help title="Guide for the next cutter">
        <ol
          style={{
            paddingLeft: 20,
            lineHeight: 1.8,
            color: "var(--muted-foreground)",
          }}
        >
          <li>
            Complete or stop the current operation in UGS and wait for the
            spindle to stop.
          </li>
          <li>
            Fit the cutter named for the next operation; keep the stock fixed.
          </li>
          <li>
            Establish a fresh material-top Z for that cutter using the reviewed
            probing procedure.
          </li>
          <li>
            Review the retained XY alignment, map coverage and compensation in
            UGS.
          </li>
          <li>
            Remove the probe leads and inspect the next operation before
            starting it.
          </li>
        </ol>
      </Help>
      {!!Object.keys(notes).length && (
        <div className="record-list">
          {operations
            .filter((op) => notes[op.id])
            .map((op) => (
              <div key={op.id} className="record-row">
                <div>
                  <strong>{op.name}</strong>
                  <p style={{ whiteSpace: "pre-wrap" }}>
                    {typeof notes[op.id] === "string"
                      ? notes[op.id]
                      : notes[op.id].note}
                  </p>
                </div>
                <Badge variant="secondary">Observation only</Badge>
              </div>
            ))}
        </div>
      )}
      <FlipHelper stock={job.stock} locked={locked} />
    </>
  );
}

function FlipHelper({
  stock,
  locked,
}: {
  stock?: PreparationJob["stock"];
  locked: boolean;
}) {
  const [axis, setAxis] = useState<"x" | "y">("x");
  const [point, setPoint] = useState<Values>({ x: "", y: "" });
  const validStock =
    stock &&
    [stock.x, stock.y, stock.width, stock.height].every(Number.isFinite) &&
    stock.width > 0 &&
    stock.height > 0;
  const x = point.x.trim() ? Number(point.x) : NaN,
    y = point.y.trim() ? Number(point.y) : NaN;
  const reflected =
    validStock && Number.isFinite(x) && Number.isFinite(y)
      ? [
          axis === "y" ? 2 * stock.x + stock.width - x : x,
          axis === "x" ? 2 * stock.y + stock.height - y : y,
        ]
      : null;
  return (
    <Help title="Visualise a board flip">
      <p>
        Reflect a point about the X or Y axis through the stock centre. This is
        a visual aid in the stock frame. It does not mirror the job or preserve
        alignment.
      </p>
      {!validStock ? (
        <p>Set the stock dimensions before using the flip helper.</p>
      ) : (
        <fieldset
          disabled={locked}
          style={{ border: 0, padding: 0, minWidth: 0 }}
        >
          <Label className="field flex-col items-stretch">
            Flip about
            <NativeSelect
              value={axis}
              onChange={(e) => setAxis(e.target.value as "x" | "y")}
            >
              <option value="x">X axis through stock centre — Y changes</option>
              <option value="y">Y axis through stock centre — X changes</option>
            </NativeSelect>
          </Label>
          <NumericFields
            fields={[
              ["x", "Reference X (mm)"],
              ["y", "Reference Y (mm)"],
            ]}
            value={point}
            onChange={setPoint}
          />
          <svg
            viewBox="0 0 300 150"
            className="diagram"
            role="img"
            aria-label={`Stock-centre ${axis.toUpperCase()} flip axis; diagram is schematic`}
          >
            <rect
              x="55"
              y="25"
              width="190"
              height="95"
              fill="var(--panel)"
              stroke="var(--line-strong)"
            />
            <line
              x1={axis === "x" ? 30 : 150}
              y1={axis === "x" ? 72.5 : 10}
              x2={axis === "x" ? 270 : 150}
              y2={axis === "x" ? 72.5 : 135}
              stroke="var(--primary)"
              strokeDasharray="5 4"
            />
            <text x="62" y="43">
              Stock
            </text>
            <text x="166" y="143">
              {axis.toUpperCase()} axis · centre
            </text>
          </svg>
          <p className="readout" aria-live="polite">
            {reflected
              ? `After flip: X ${fmt(reflected[0])} · Y ${fmt(reflected[1])}`
              : "Enter a reference point"}
          </p>
          <small>
            After a physical flip, check handedness with an asymmetric reference
            and establish fresh alignment.
          </small>
        </fieldset>
      )}
    </Help>
  );
}

type SharedProps = {
  job: PreparationJob;
  locked: boolean;
  run: Run;
  tool: Values;
  setTool: (value: Values) => void;
  parameters: Values;
  setParameters: (value: Values) => void;
};

function VBit({ locked, run }: { locked: boolean; run: Run }) {
  const [value, setValue] = useState<Values>({
    tipDiameter: "",
    angle: "",
    depth: "",
    maxDiameter: "",
  });
  const [diameter, setDiameter] = useState<number | null>(null);
  const fields: readonly NumericField[] = [
    ["tipDiameter", "Flat tip diameter (mm)", 0, 50],
    ["angle", "Included angle (degrees)", 1, 179],
    ["depth", "Depth (mm)", 0, 10],
    ["maxDiameter", "Cutting-head diameter (mm)", 0.01, 50],
  ];
  return (
    <Help title="Estimate a V-bit cutting width">
      <p>
        The geometric estimate excludes runout and material effects. Keep the
        shaft diameter for collision checks.
      </p>
      <SectionForm
        locked={locked}
        submit={() =>
          run("pcb-vbit", numbers(value, fields), (result) => {
            if (
              typeof result.diameter !== "number" ||
              !Number.isFinite(result.diameter)
            )
              throw new Error("The server did not return a finite diameter.");
            setDiameter(result.diameter);
          })
        }
      >
        <NumericFields
          fields={fields}
          value={value}
          onChange={(v) => {
            setValue(v);
            setDiameter(null);
          }}
        />
        <Button type="submit" variant="outline">
          Estimate cutting width
        </Button>
      </SectionForm>
      {diameter !== null && (
        <p className="readout" aria-live="polite">
          Estimated width{" "}
          {diameter.toLocaleString(undefined, { maximumFractionDigits: 4 })} mm
        </p>
      )}
    </Help>
  );
}

function Recipes({
  job,
  locked,
  run,
  tool,
  setTool,
  parameters,
  setParameters,
}: SharedProps) {
  const [details, setDetails] = useState<Values>({
    name: "",
    material: "",
    date: "",
    source: "",
    scope: "",
    observation: "",
  });
  const [measurements, setMeasurements] = useState<Values[]>([]);
  const records = job.workflow?.recipes ?? [];
  const update = (key: string, value: string) =>
    setDetails({ ...details, [key]: value });
  async function save() {
    const measured: RecordValue = {};
    for (const row of measurements) {
      const label = row.label.trim();
      if (!label || !row.unit.trim() || Object.hasOwn(measured, label))
        throw new Error("Give each measurement a unique label and unit.");
      Object.defineProperty(measured, label, {
        value: { value: numeric(row.value, label, -1e9, 1e9), unit: row.unit },
        enumerable: true,
      });
    }
    await run(
      "pcb-recipe",
      {
        recipe: {
          version: 1,
          name: details.name,
          material: details.material,
          tool: numbers(tool, TOOL),
          parameters: numbers(parameters, PARAMETERS),
          observations: [
            {
              date: details.date,
              source: details.source,
              scope: details.scope,
              observation: details.observation,
              measurements: measured,
            },
          ],
        },
      },
      undefined,
      "Recipe and observed evidence recorded; physical qualification is not assessed.",
    );
  }
  return (
    <>
      <h3>Recipes and observed evidence</h3>
      <p>
        Keep the settings with what actually happened, including failed or
        unmeasured results. A saved record is not a qualified cutting process.
      </p>
      <SectionForm locked={locked} submit={save}>
        <div className="fields">
          <TextField
            label="Recipe name"
            value={details.name}
            onChange={(v) => update("name", v)}
          />
          <TextField
            label="Actual material"
            value={details.material}
            onChange={(v) => update("material", v)}
            maxLength={500}
          />
        </div>
        <h3>Tool dimensions</h3>
        <NumericFields fields={TOOL} value={tool} onChange={setTool} />
        <h3>Recorded parameters</h3>
        <NumericFields
          fields={PARAMETERS}
          value={parameters}
          onChange={setParameters}
        />
        <h3>Observed result</h3>
        <div className="fields">
          <Label className="field flex-col items-stretch">
            Observation date
            <Input
              type="date"
              required
              value={details.date}
              onChange={(e) => update("date", e.target.value)}
            />
          </Label>
          <TextField
            label="Source or observer"
            value={details.source}
            onChange={(v) => update("source", v)}
            maxLength={500}
          />
          <div className="full">
            <TextField
              label="Exact trial, material or revision this covers"
              value={details.scope}
              onChange={(v) => update("scope", v)}
              maxLength={1000}
            />
          </div>
          <div className="full">
            <TextField
              label="What was observed, including unresolved issues"
              value={details.observation}
              onChange={(v) => update("observation", v)}
              multiline
              maxLength={4000}
            />
          </div>
        </div>
        {measurements.map((row, index) => (
          <div key={index} className="fields">
            <TextField
              label={`Measurement ${index + 1} label`}
              value={row.label}
              onChange={(label) =>
                setMeasurements(
                  measurements.map((r, i) =>
                    i === index ? { ...r, label } : r,
                  ),
                )
              }
            />
            <Label className="field flex-col items-stretch">
              Observed value
              <Input
                required
                type="number"
                step="any"
                min={-1e9}
                max={1e9}
                value={row.value}
                onChange={(e) =>
                  setMeasurements(
                    measurements.map((r, i) =>
                      i === index ? { ...r, value: e.target.value } : r,
                    ),
                  )
                }
              />
            </Label>
            <TextField
              label="Measurement unit"
              value={row.unit}
              onChange={(unit) =>
                setMeasurements(
                  measurements.map((r, i) =>
                    i === index ? { ...r, unit } : r,
                  ),
                )
              }
              maxLength={40}
            />
            <Button
              type="button"
              variant="ghost"
              onClick={() =>
                setMeasurements(measurements.filter((_, i) => i !== index))
              }
            >
              Remove measurement {index + 1}
            </Button>
          </div>
        ))}
        <div className="actions">
          <Button type="submit" disabled={records.length >= 100}>
            Save recipe record
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={measurements.length >= 32}
            onClick={() =>
              setMeasurements([
                ...measurements,
                { label: "", value: "", unit: "" },
              ])
            }
          >
            Add measurement
          </Button>
        </div>
      </SectionForm>
      <VBit locked={locked} run={run} />
      <div className="record-list">
        {!records.length ? (
          <p className="notice">
            No recipe records yet. Your first record will appear here with its
            evidence.
          </p>
        ) : (
          records.map((saved, index) => {
            const record = saved.record ?? saved;
            return (
              <Help key={index} title={`${record.name} · ${record.material}`}>
                <p>
                  Depth {fmt(record.parameters?.depth)} mm · feed{" "}
                  {fmt(record.parameters?.feed)} mm/min · qualification not
                  assessed
                </p>
                {record.observations?.map(
                  (observation: RecordValue, i: number) => (
                    <div key={i} style={{ margin: "12px 0" }}>
                      <small>
                        {observation.date} · {observation.source} ·{" "}
                        {observation.scope}
                      </small>
                      <p style={{ whiteSpace: "pre-wrap" }}>
                        {observation.observation}
                      </p>
                      {Object.entries(observation.measurements ?? {}).map(
                        ([name, measurement]) => (
                          <p key={name}>
                            {name}: {fmt((measurement as RecordValue).value)}{" "}
                            {(measurement as RecordValue).unit}
                          </p>
                        ),
                      )}
                    </div>
                  ),
                )}
                <Button
                  type="button"
                  variant="outline"
                  disabled={locked}
                  onClick={() => {
                    setTool(stringifyFields(record.tool ?? {}, TOOL));
                    setParameters(
                      stringifyFields(record.parameters ?? {}, PARAMETERS),
                    );
                  }}
                >
                  Use tool and parameters
                </Button>
              </Help>
            );
          })
        )}
      </div>
    </>
  );
}

function Camera({
  job,
  locked,
  run,
}: Pick<SharedProps, "job" | "locked" | "run">) {
  const [common, setCommon] = useState<Values>({ commonZ: "", tolerance: "" });
  const [pairs, setPairs] = useState<Values[]>(() =>
    Array.from({ length: 3 }, () => ({ sx: "", sy: "", cx: "", cy: "" })),
  );
  const [sameZ, setSameZ] = useState(false);
  const [result, setResult] = useState<RecordValue | null>(null);
  const [edited, setEdited] = useState(false);
  const context = JSON.stringify([
    job.name,
    job.boardRevision,
    job.stock,
    job.placement,
    job.face,
    operationIdentity(job),
    job.workflow?.camera,
  ]);
  useEffect(() => {
    setResult(null);
    setSameZ(false);
  }, [context]);
  const change = () => {
    setResult(null);
    setSameZ(false);
    setEdited(true);
  };
  const current = result ?? (edited ? null : job.workflow?.camera);
  async function calibrate() {
    const values = numbers(common, [
      ["commonZ", "Common captured Z (mm)"],
      ["tolerance", "Maximum residual (mm)", 0.000001, 1],
    ]);
    if (!sameZ)
      throw new Error(
        "Confirm all six captures share this Z and the same setup.",
      );
    const records = pairs.map((pair, i) => ({
      spindle: [
        numeric(pair.sx, `Point ${i + 1} spindle X`),
        numeric(pair.sy, `Point ${i + 1} spindle Y`),
        values.commonZ,
      ],
      camera: [
        numeric(pair.cx, `Point ${i + 1} camera X`),
        numeric(pair.cy, `Point ${i + 1} camera Y`),
        values.commonZ,
      ],
    }));
    await run(
      "pcb-camera",
      { samples: records.slice(0, 2), check: records[2], ...values },
      (response) => {
        setResult(response.camera ?? response);
        setEdited(false);
      },
      "Camera offset checked numerically. No movement was requested.",
    );
  }
  return (
    <>
      <h3>Camera-centre offset</h3>
      <p>
        For each fiducial, enter the carriage XY when the spindle was centred
        over it, then when the camera centre was over that same mark. Use one
        unchanged setup and common Z.
      </p>
      <SectionForm locked={locked} submit={calibrate}>
        <NumericFields
          fields={[
            ["commonZ", "Common captured Z (mm)"],
            ["tolerance", "Maximum residual (mm)", 0.000001, 1],
          ]}
          value={common}
          onChange={(v) => {
            setCommon(v);
            change();
          }}
        />
        {pairs.map((pair, index) => (
          <div key={index} className="record-list" style={{ paddingTop: 16 }}>
            <h3>
              {
                [
                  "A · first fiducial",
                  "B · second fiducial",
                  "C · independent check",
                ][index]
              }
            </h3>
            <p>
              {index === 0
                ? "Use a distinct, repeatable mark."
                : index === 1
                  ? "At least 5 mm from A."
                  : "At least 1 mm off the A–B line. C is excluded from the offset fit."}
            </p>
            <NumericFields
              fields={[
                ["sx", `Point ${"ABC"[index]} spindle-centred machine X (mm)`],
                ["sy", `Point ${"ABC"[index]} spindle-centred machine Y (mm)`],
                ["cx", `Point ${"ABC"[index]} camera-centred machine X (mm)`],
                ["cy", `Point ${"ABC"[index]} camera-centred machine Y (mm)`],
              ]}
              value={pair}
              onChange={(v) => {
                setPairs(pairs.map((p, i) => (i === index ? v : p)));
                change();
              }}
            />
          </div>
        ))}
        <CheckField
          checked={sameZ}
          onCheckedChange={(v) => setSameZ(v === true)}
          label="All six captures were made at the entered common Z with the same setup."
        />
        <Button type="submit" disabled={!sameZ}>
          Check camera offset
        </Button>
      </SectionForm>
      {current?.offsetXY && (
        <div className="notice" aria-live="polite">
          <strong>Numerically checked offset</strong>
          <p className="readout">
            X {fmt(current.offsetXY[0])} · Y {fmt(current.offsetXY[1])} mm
          </p>
          <p>
            Independent C residual: {fmt(current.checkResidual)} mm · common Z:{" "}
            {fmt(current.commonZ)} mm
          </p>
          <p>
            Camera centre = spindle carriage XY + this offset. Changing camera
            mounting or Z invalidates its use.
          </p>
        </div>
      )}
      <p className="inline-status">
        Camera coordinates are estimates. Pixel-to-work affine calibration is
        separate from this centre-offset check. No camera action here controls
        motion.
      </p>
    </>
  );
}

function DownloadDraft({ draft }: { draft: RecordValue }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const objectUrl = URL.createObjectURL(
      new Blob([draft.source], { type: "text/plain;charset=utf-8" }),
    );
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [draft.source]);
  return (
    <div className="record-list" style={{ paddingTop: 16 }}>
      <div
        className="row"
        style={{ flexWrap: "wrap", justifyContent: "space-between" }}
      >
        <h3>{draft.simulation ? "Simulation draft" : "Unreleased draft"}</h3>
        {url && (
          <Button asChild variant="outline">
            <a href={url} download={draft.filename}>
              Download {draft.filename}
            </a>
          </Button>
        )}
      </div>
      <p>
        This file has not been sent to UGS. Inspect the paths, datum and
        clearance before any separate machine operation.
      </p>
      {Array.isArray(draft.warnings) && (
        <ul
          style={{
            paddingLeft: 20,
            margin: "12px 0",
            color: "var(--muted-foreground)",
          }}
        >
          {draft.warnings.map((warning: string, i: number) => (
            <li key={i}>{warning}</li>
          ))}
        </ul>
      )}
      <Help title="Inspect generated G-code">
        <pre
          tabIndex={0}
          aria-label="Generated draft G-code"
          style={{
            maxHeight: 260,
            overflow: "auto",
            font: "12px var(--mono)",
            padding: 12,
            background: "var(--panel)",
            marginTop: 12,
          }}
        >
          {draft.source}
        </pre>
      </Help>
    </div>
  );
}

function Wood({
  job,
  locked,
  run,
  tool,
  setTool,
  parameters,
  setParameters,
}: SharedProps) {
  const [kind, setKind] = useState<"coupon" | "surfacing">("coupon");
  const [area, setArea] = useState<Values>({
    xmin: "",
    xmax: "",
    ymin: "",
    ymax: "",
    stepover: "",
    originX: "",
    originY: "",
  });
  const [reviews, setReviews] = useState<Record<string, boolean>>({});
  const [reviewedFor, setReviewedFor] = useState("");
  const [draft, setDraft] = useState<{
    key: string;
    value: RecordValue;
  } | null>(null);
  const fixture = job.workflow?.fixture;
  const specificationKey = JSON.stringify([
    kind,
    area,
    fixture,
    tool,
    parameters,
    job.name,
    job.boardRevision,
    job.face,
    job.stock,
    job.placement,
  ]);
  const currentReviews = reviewedFor === specificationKey ? reviews : {};
  useEffect(() => {
    setReviews({});
    setDraft(null);
  }, [specificationKey]);
  async function generate() {
    if (!fixture) throw new Error("Save a fixture before generating a draft.");
    if (!REVIEWS.every(([key]) => currentReviews[key]))
      throw new Error("Review each configuration item for these exact inputs.");
    const v = numbers(area, [
      ["xmin", "Minimum G54 X (mm)"],
      ["xmax", "Maximum G54 X (mm)"],
      ["ymin", "Minimum G54 Y (mm)"],
      ["ymax", "Maximum G54 Y (mm)"],
      ["originX", "G54 origin, machine X (mm)"],
      ["originY", "G54 origin, machine Y (mm)"],
    ]);
    // Explicit coordinate conversion only. Never read a machine offset or silently
    // treat the saved machine-XY fixture as a G54-XY cutting specification.
    const workFixture: Fixture = {
      ...fixture,
      bounds: {
        x: fixture.bounds.x.map((x) => x - v.originX),
        y: fixture.bounds.y.map((y) => y - v.originY),
        z: [...fixture.bounds.z],
      },
      clamps: fixture.clamps.map((clamp) => ({
        ...clamp,
        x: clamp.x - v.originX,
        y: clamp.y - v.originY,
      })),
    };
    await run(
      "pcb-generate",
      {
        kind,
        spec: {
          fixture: workFixture,
          area: { x: [v.xmin, v.xmax], y: [v.ymin, v.ymax] },
          tool: numbers(tool, TOOL),
          parameters: numbers(parameters, PARAMETERS),
        },
        reviewed: currentReviews,
        ...(kind === "surfacing"
          ? {
              stepover: numeric(
                area.stepover,
                "Raster stepover (mm)",
                0.000001,
                25,
              ),
            }
          : {}),
      },
      (result) => {
        const output = result.draft ?? result;
        if (
          typeof output.source !== "string" ||
          typeof output.filename !== "string"
        )
          throw new Error("The server did not return a draft file.");
        setDraft({ key: specificationKey, value: output });
      },
      "Offline draft prepared. No file was sent to a machine.",
    );
  }
  return (
    <>
      <h3>Calibration coupon and surfacing drafts</h3>
      <p>
        Prepare a small witness perimeter or an inset raster. Enter the actual
        tool and material parameters; there are no cutting presets.
      </p>
      {!fixture && (
        <p className="notice">
          Save the machine-XY fixture in Fixtures first. Its bounds and clamps
          will be used for draft inspection.
        </p>
      )}
      <SectionForm locked={locked} submit={generate}>
        <div className="fields">
          <Label className="field full flex-col items-stretch">
            Draft type
            <NativeSelect
              value={kind}
              onChange={(e) =>
                setKind(e.target.value as "coupon" | "surfacing")
              }
            >
              <option value="coupon">
                Calibration coupon · perimeter up to 50 × 50 mm
              </option>
              <option value="surfacing">Surfacing · inset raster</option>
            </NativeSelect>
          </Label>
        </div>
        <h3>Coordinate frame</h3>
        <p>
          Enter the G54 origin in machine coordinates. The fixture will be
          translated by this explicit offset. Z0 remains the material surface.
        </p>
        <NumericFields
          fields={[
            ["originX", "G54 origin, machine X (mm)"],
            ["originY", "G54 origin, machine Y (mm)"],
          ]}
          value={area}
          onChange={setArea}
        />
        <h3>Cutting footprint in G54</h3>
        <NumericFields
          fields={[
            ["xmin", "Minimum G54 X (mm)"],
            ["xmax", "Maximum G54 X (mm)"],
            ["ymin", "Minimum G54 Y (mm)"],
            ["ymax", "Maximum G54 Y (mm)"],
          ]}
          value={area}
          onChange={setArea}
        />
        <h3>Tool dimensions</h3>
        <NumericFields fields={TOOL} value={tool} onChange={setTool} />
        <h3>Cutting parameters</h3>
        <NumericFields
          fields={PARAMETERS}
          value={parameters}
          onChange={setParameters}
        />
        {kind === "surfacing" && (
          <NumericFields
            fields={[["stepover", "Raster stepover (mm)", 0.000001, 25]]}
            value={area}
            onChange={setArea}
          />
        )}
        <p className="inline-status">
          Maximum 100 depth passes. Raster stepover must not exceed half the
          tool diameter. Drafts start paused, use M3 and remain unreleased.
        </p>
        <Help title="Review the configuration for this draft">
          {REVIEWS.map(([key, label]) => (
            <CheckField
              key={key}
              checked={!!currentReviews[key]}
              onCheckedChange={(checked) => {
                setReviewedFor(specificationKey);
                setReviews({ ...currentReviews, [key]: checked === true });
              }}
              label={label}
            />
          ))}
        </Help>
        <div className="actions" style={{ marginTop: 18 }}>
          <Button
            type="submit"
            disabled={
              !fixture || !REVIEWS.every(([key]) => currentReviews[key])
            }
          >
            Prepare {kind === "coupon" ? "coupon" : "surfacing"} draft
          </Button>
          <small>
            {REVIEWS.filter(([key]) => currentReviews[key]).length} of{" "}
            {REVIEWS.length} configuration items reviewed
          </small>
        </div>
      </SectionForm>
      {draft?.key === specificationKey && <DownloadDraft draft={draft.value} />}
    </>
  );
}

/** Offline preparation panels. All server mutations go through the supplied
 * revision-aware post function; no machine endpoint or hardware API is called.
 * Blank numeric fields are never coerced into zero. Reviews reset on changed
 * generator inputs. Keep this component mounted to retain unsaved form drafts.
 */
export function PreparationTools({
  job,
  disabled,
  post,
  onMessage,
  section,
}: PreparationToolsProps & { section?: string | null }) {
  const [tab, setTab] = useState(0);
  useEffect(() => {
    const index = ["fixtures", "tools", "recipes", "camera", "wood"].indexOf(
      section || "",
    );
    if (index >= 0) setTab(index);
  }, [section]);
  const [tool, setTool] = useState<Values>(() => empty(TOOL));
  const [parameters, setParameters] = useState<Values>(() => empty(PARAMETERS));
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState({ text: "", error: false });
  const inFlight = useRef(false);
  const run: Run = async (action, body, receive, message) => {
    if (disabled || inFlight.current || !job) return false;
    inFlight.current = true;
    setBusy(true);
    setStatus({ text: "Checking…", error: false });
    try {
      const ok = await post(action, body, (result) => receive?.(result));
      const text = ok
        ? (message ?? "Calculation complete.")
        : "The request was not accepted. Check the reported issue and try again.";
      setStatus({ text, error: !ok });
      if (ok) onMessage(text);
      return ok;
    } catch (error) {
      const text =
        error instanceof Error
          ? error.message
          : "The request failed. Your inputs are still here.";
      setStatus({ text, error: true });
      onMessage(text);
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const locked = disabled || busy || !job;
  const shared: SharedProps = {
    job: job ?? {},
    locked,
    run,
    tool,
    setTool,
    parameters,
    setParameters,
  };
  return (
    <section
      className="panel"
      aria-label="Offline preparation tools"
      aria-busy={busy}
      onKeyDown={(event) => {
        if (event.key !== "Escape") event.stopPropagation();
      }}
    >
      <Tabs
        value={String(tab)}
        onValueChange={(value) => setTab(Number(value))}
      >
        <TabsList className="tool-tabs" aria-label="Preparation tools">
          {TABS.map((label, index) => (
            <TabsTrigger key={label} value={String(index)}>
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
        {!job && (
          <p className="notice" style={{ margin: 16 }}>
            Open a job to save preparation records. No machine connection is
            needed for these forms.
          </p>
        )}
        {[
          <Fixtures {...shared} />,
          <ToolChanges {...shared} />,
          <Recipes {...shared} />,
          <Camera {...shared} />,
          <Wood {...shared} />,
        ].map((panel, index) => (
          <TabsContent
            forceMount
            key={TABS[index]}
            value={String(index)}
            hidden={tab !== index}
            className="tool-content"
            tabIndex={0}
          >
            {panel}
          </TabsContent>
        ))}
      </Tabs>
      <div style={{ padding: "0 20px 16px" }}>
        <p
          role={status.error ? "alert" : "status"}
          aria-live="polite"
          className={status.error ? "notice error" : "inline-status"}
        >
          {status.text}
        </p>
      </div>
    </section>
  );
}
