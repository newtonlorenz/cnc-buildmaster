import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Maximize, Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CheckField } from "@/components/workbench-controls";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { formatNumber } from "@/workbench-context";

export type Point = [number, number, ...number[]];
export type Placement = {
  x: number;
  y: number;
  angle: number;
  mirror: boolean;
};
export type Bounds = {
  x: [number, number];
  y: [number, number];
  z: [number, number];
};
export type ReferenceLabel = "A" | "B" | "C";
export type PcbReference = {
  design: Point | null;
  machine: Point | null;
  session: string | null;
};
export type PcbOperation = {
  id: string;
  name: string;
  role: string;
  tool: string;
  diameter: number | null;
  paths: { rapid: boolean; points: Point[] }[];
  cutBounds: Bounds;
  bounds: Bounds;
  fits: boolean;
  depthOk: boolean;
  sha256: string;
  warnings: string[];
  feedMinutes: number;
  maxFeed: number;
  maxSpindle: number;
  lineCount: number;
};
export type PcbJob = {
  revision: number;
  name: string;
  boardRevision: string;
  face: string;
  stock: {
    x: number;
    y: number;
    width: number;
    height: number;
    thickness: number;
    margin: number;
    spoilAllowance: number;
  };
  placement: Placement;
  tolerance: number;
  operations: PcbOperation[];
  references: Record<ReferenceLabel, PcbReference>;
  bounds: Bounds | null;
  cutBounds: Bounds | null;
  alignment: {
    status: string;
    session: string | null;
    baselineError: number;
    checkError: number | null;
  } | null;
  canExport: boolean;
  issues: string[];
  note: string;
  lastSaved?: string;
  savedJobs?: { id: string; label: string }[];
};
type Plane = "xy" | "xz" | "yz";
type View = { scale: number; cx: number; cy: number; ox: number; oy: number };
type Geometry = { cut: Path2D; rapid: Path2D; holes: [number, number][] };
type Props = {
  active: boolean;
  job: PcbJob;
  visible: Record<string, boolean>;
  picking: boolean;
  machine: { x: number; y: number; z?: number } | null;
  onPick: (design: [number, number], snapped: boolean) => void;
};

// The server has already mirrored, rotated and translated each path into machine XY.
// Picking reverses that transform, in reverse order. Source work Z is never transformed.
export function machineToDesign(
  point: Point,
  placement: Placement,
): [number, number] {
  const angle = (placement.angle * Math.PI) / 180;
  const x = point[0] - placement.x,
    y = point[1] - placement.y;
  const dx = Math.cos(angle) * x + Math.sin(angle) * y;
  return [
    placement.mirror ? -dx : dx,
    -Math.sin(angle) * x + Math.cos(angle) * y,
  ];
}

function project(point: Point, plane: Plane): [number, number] {
  return plane === "xy"
    ? [point[0], point[1]]
    : [point[plane === "xz" ? 0 : 1], point[2] ?? 0];
}

const roleTokens: Record<string, string> = {
  isolation: "isolation",
  drilling: "drilling",
  outline: "outline",
  clearing: "clearing",
  other: "primary",
};

export const ToolpathPreview = memo(function ToolpathPreview({
  active,
  job,
  visible,
  picking,
  machine,
  onPick,
}: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{
    id: number;
    x: number;
    y: number;
    pan: { x: number; y: number };
  } | null>(null);
  const cache = useRef(
    new WeakMap<PcbOperation["paths"], Partial<Record<Plane, Geometry>>>(),
  );
  const [plane, setPlane] = useState<Plane>("xy");
  const [rapids, setRapids] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [themeVersion, setThemeVersion] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const shownPlane = picking ? "xy" : plane;
  const horizontal = shownPlane === "yz" ? "y" : "x";
  const vertical = shownPlane === "xy" ? "y" : "z";
  const view = useMemo<View | null>(() => {
    if (!active || !size.width || !size.height) return null;
    const stock = job.stock,
      sx = stock[horizontal],
      sw = horizontal === "x" ? stock.width : stock.height;
    const sy = shownPlane === "xy" ? stock.y : -stock.thickness,
      sh = shownPlane === "xy" ? stock.height : stock.thickness;
    const xmin = Math.min(sx, job.bounds?.[horizontal][0] ?? sx),
      xmax = Math.max(sx + sw, job.bounds?.[horizontal][1] ?? sx + sw);
    const ymin = Math.min(sy, job.bounds?.[vertical][0] ?? sy),
      ymax = Math.max(sy + sh, job.bounds?.[vertical][1] ?? sy + sh);
    return {
      scale:
        Math.max(
          0.001,
          Math.min(
            Math.max(40, size.width - 80) / (xmax - xmin || 1),
            Math.max(40, size.height - 80) / (ymax - ymin || 1),
          ),
        ) * zoom,
      cx: (xmin + xmax) / 2,
      cy: (ymin + ymax) / 2,
      ox: size.width / 2 + pan.x,
      oy: size.height / 2 + pan.y,
    };
  }, [
    active,
    size,
    job.stock,
    job.bounds,
    horizontal,
    vertical,
    shownPlane,
    zoom,
    pan,
  ]);

  useEffect(() => {
    if (!active || !canvas.current) return;
    const element = canvas.current;
    const measure = () =>
      setSize({ width: element.clientWidth, height: element.clientHeight });
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    const themeObserver = new MutationObserver(() =>
      setThemeVersion((n) => n + 1),
    );
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme"],
    });
    const media = matchMedia("(prefers-color-scheme: dark)");
    const themeChanged = () => setThemeVersion((n) => n + 1);
    media.addEventListener("change", themeChanged);
    return () => {
      observer.disconnect();
      themeObserver.disconnect();
      media.removeEventListener("change", themeChanged);
    };
  }, [active]);

  useEffect(() => {
    if (active) return;
    const held = drag.current;
    if (held && canvas.current?.hasPointerCapture(held.id))
      canvas.current.releasePointerCapture(held.id);
    drag.current = null;
  }, [active]);

  // Cache native path geometry per source array and projection. Pan, zoom, pointer
  // readouts and machine polling do not walk hundreds of thousands of points again.
  const geometry = useMemo(() => {
    if (!active) return [];
    return job.operations.map((op) => {
      let planes = cache.current.get(op.paths);
      if (!planes) {
        planes = {};
        cache.current.set(op.paths, planes);
      }
      let result = planes[shownPlane];
      if (!result) {
        result = { cut: new Path2D(), rapid: new Path2D(), holes: [] };
        for (const path of op.paths) {
          const target = path.rapid ? result.rapid : result.cut;
          path.points.forEach((point, index) => {
            const [x, y] = project(point, shownPlane);
            if (index) target.lineTo(x, y);
            else target.moveTo(x, y);
          });
          const first = path.points[0],
            last = path.points.at(-1);
          if (
            shownPlane === "xy" &&
            !path.rapid &&
            first &&
            last &&
            last[2] < 0 &&
            first[0] === last[0] &&
            first[1] === last[1]
          ) {
            result.holes.push([last[0], last[1]]);
          }
        }
        planes[shownPlane] = result;
      }
      return { op, ...result };
    });
  }, [active, job.operations, shownPlane]);

  const paint = useCallback(() => {
    const element = canvas.current;
    if (!active || !element || !view) return;
    const ctx = element.getContext("2d");
    if (!ctx) return;
    const { width: w, height: h } = size;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    element.width = Math.round(w * ratio);
    element.height = Math.round(h * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const style = getComputedStyle(document.documentElement);
    const colour = (name: string, fallback: string) =>
      style.getPropertyValue("--" + name).trim() ||
      style.getPropertyValue("--" + fallback).trim();
    const ink = colour("foreground", "ink"),
      muted = colour("muted-foreground", "ink");
    const stock = job.stock;
    const sx = stock[horizontal],
      sw = horizontal === "x" ? stock.width : stock.height;
    const sy = shownPlane === "xy" ? stock.y : -stock.thickness;
    const sh = shownPlane === "xy" ? stock.height : stock.thickness;
    const { scale, cx, cy, ox, oy } = view;
    const screen = (x: number, y: number) => [
      ox + (x - cx) * scale,
      oy - (y - cy) * scale,
    ];
    ctx.fillStyle = colour("canvas", "background");
    ctx.fillRect(0, 0, w, h);
    const [left, top] = screen(sx, sy + sh);
    ctx.fillStyle = colour("stock", "muted");
    ctx.fillRect(left, top, sw * scale, sh * scale);
    ctx.strokeStyle = colour("stock-line", "border");
    ctx.lineWidth = 1;
    ctx.strokeRect(left, top, sw * scale, sh * scale);
    if (shownPlane === "xy") {
      ctx.setLineDash([5, 5]);
      ctx.strokeRect(
        left + stock.margin * scale,
        top + stock.margin * scale,
        (sw - 2 * stock.margin) * scale,
        (sh - 2 * stock.margin) * scale,
      );
      ctx.setLineDash([]);
    }
    ctx.font = "12px ui-monospace, monospace";
    ctx.fillStyle = muted;
    ctx.fillText(
      shownPlane === "xy"
        ? `${formatNumber(stock.width, 1)} × ${formatNumber(stock.height, 1)} mm stock`
        : `Source work Z · ${formatNumber(stock.thickness, 2)} mm declared stock`,
      left,
      top - 12,
    );

    ctx.save();
    ctx.translate(ox - cx * scale, oy + cy * scale);
    ctx.scale(scale, -scale);
    for (const { op, cut, rapid } of geometry) {
      if (visible[op.id] === false) continue;
      if (rapids) {
        ctx.strokeStyle = colour("line-strong", "border");
        ctx.lineWidth = 0.8 / scale;
        ctx.setLineDash([3 / scale, 4 / scale]);
        ctx.stroke(rapid);
        ctx.setLineDash([]);
      }
      ctx.strokeStyle = colour(roleTokens[op.role] || "primary", "primary");
      ctx.lineWidth = 1.2 / scale;
      ctx.stroke(cut);
    }
    ctx.restore();
    for (const { op, holes } of geometry) {
      if (visible[op.id] === false) continue;
      ctx.fillStyle = colour(roleTokens[op.role] || "primary", "primary");
      ctx.beginPath();
      for (const [hx, hy] of holes) {
        const [x, y] = screen(hx, hy);
        ctx.moveTo(x + 2, y);
        ctx.arc(x, y, 2, 0, 2 * Math.PI);
      }
      ctx.fill();
    }
    const origin = project([job.placement.x, job.placement.y, 0], shownPlane);
    const [originX, originY] = screen(...origin);
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(originX - 7, originY);
    ctx.lineTo(originX + 7, originY);
    ctx.moveTo(originX, originY - 7);
    ctx.lineTo(originX, originY + 7);
    ctx.stroke();
    if (shownPlane === "xy") {
      for (const [label, point] of Object.entries(job.references)) {
        if (!point.machine) continue;
        const [x, y] = screen(point.machine[0], point.machine[1]);
        ctx.fillStyle = colour(
          point.session ? "primary" : "warning",
          "foreground",
        );
        ctx.beginPath();
        ctx.arc(x, y, 6, 0, 2 * Math.PI);
        ctx.fill();
        ctx.fillStyle = ink;
        ctx.font = "bold 12px system-ui";
        ctx.fillText(label, x + 9, y - 8);
      }
    }
    ctx.fillStyle = muted;
    ctx.font = "12px system-ui";
    ctx.fillText(
      `${horizontal.toUpperCase()} →   ${vertical.toUpperCase()} ↑   mm`,
      14,
      h - 14,
    );
    if (!job.operations.length) {
      ctx.font = "14px system-ui";
      ctx.textAlign = "center";
      ctx.fillText("Add cutting files to preview the PCB", w / 2, h / 2);
    }
  }, [
    active,
    size,
    view,
    job.stock,
    job.placement,
    job.references,
    job.operations.length,
    horizontal,
    vertical,
    shownPlane,
    geometry,
    visible,
    rapids,
    themeVersion,
  ]);

  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(frame);
  }, [paint, active]);

  const changeZoom = useCallback(
    (factor: number) =>
      setZoom((value) => Math.max(0.3, Math.min(30, value * factor))),
    [],
  );
  useEffect(() => {
    const element = canvas.current;
    if (!active || !element) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      changeZoom(event.deltaY < 0 ? 1.15 : 0.87);
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [active, changeZoom]);

  function location(clientX: number, clientY: number): [number, number] | null {
    if (!view || !canvas.current) return null;
    const box = canvas.current.getBoundingClientRect(),
      t = view;
    return [
      (clientX - box.left - t.ox) / t.scale + t.cx,
      (t.oy - (clientY - box.top)) / t.scale + t.cy,
    ];
  }

  function pickPoint(clientX: number, clientY: number) {
    let point = location(clientX, clientY);
    if (!point || !view || shownPlane !== "xy") return;
    let nearest: Point | null = null,
      distance = 12 / view.scale;
    for (const op of job.operations) {
      if (visible[op.id] === false) continue;
      for (const path of op.paths) {
        if (path.rapid && !rapids) continue;
        for (const candidate of path.points) {
          const d = Math.hypot(
            point[0] - candidate[0],
            point[1] - candidate[1],
          );
          if (d < distance) {
            nearest = candidate;
            distance = d;
          }
        }
      }
    }
    if (nearest) point = [nearest[0], nearest[1]];
    onPick(machineToDesign(point, job.placement), nearest !== null);
  }

  // Overlay the live XY marker without redrawing the cached cutting paths on each
  // poll. Machine Z and source work Z have different datums; never overlay them.
  const t = view;
  const marker =
    active &&
    shownPlane === "xy" &&
    machine &&
    t &&
    Number.isFinite(machine.x) &&
    Number.isFinite(machine.y)
      ? {
          x: t.ox + (machine.x - t.cx) * t.scale,
          y: t.oy - (machine.y - t.cy) * t.scale,
        }
      : null;
  const allFit = job.operations.every((op) => op.fits);
  return (
    <section
      className="toolpath-preview flex min-h-[430px] min-w-0 flex-1 flex-col overflow-hidden rounded-lg border bg-card"
      aria-label="Toolpath preview"
    >
      <div className="flex flex-wrap items-start justify-between gap-2 border-b px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">Toolpath preview</h2>
          <p id="pcbSummary" className="mt-1 text-xs text-muted-foreground">
            {job.operations.length} operations · {job.face} face ·{" "}
            {job.placement.mirror ? "X mirrored" : "Original handedness"}
          </p>
        </div>
        <span
          id="pcbFit"
          className={`text-xs font-medium ${!allFit ? "text-[var(--danger)]" : "text-muted-foreground"}`}
        >
          {!job.operations.length
            ? "NO FILES"
            : !allFit
              ? "OUTSIDE STOCK"
              : job.operations.some((op) => op.diameter === null)
                ? "SET CUTTER SIZES"
                : "FITS DECLARED STOCK"}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-3 py-2">
        <NativeSelect
          size="sm"
          aria-label="Preview projection"
          id="pcbProjection"
          value={shownPlane}
          disabled={!active || picking}
          onChange={(e) => {
            setPlane(e.target.value as Plane);
            setZoom(1);
            setPan({ x: 0, y: 0 });
            setCursor(null);
          }}
        >
          <NativeSelectOption value="xy">Top · XY</NativeSelectOption>
          <NativeSelectOption value="xz">Front · XZ</NativeSelectOption>
          <NativeSelectOption value="yz">Side · YZ</NativeSelectOption>
        </NativeSelect>
        <CheckField
          id="pcbRapids"
          className="!my-0"
          label="Rapid travel"
          checked={rapids}
          disabled={!active}
          onCheckedChange={(value) => setRapids(value === true)}
        />
        <div className="ml-auto flex items-center gap-1">
          <Button
            id="pcbZoomOut"
            variant="ghost"
            size="icon-sm"
            disabled={!active}
            aria-label="Zoom out"
            onClick={() => changeZoom(1 / 1.4)}
          >
            <Minus />
          </Button>
          <Button
            id="pcbZoomIn"
            variant="ghost"
            size="icon-sm"
            disabled={!active}
            aria-label="Zoom in"
            onClick={() => changeZoom(1.4)}
          >
            <Plus />
          </Button>
          <Button
            id="pcbZoomFit"
            variant="outline"
            size="sm"
            disabled={!active}
            onClick={() => {
              setZoom(1);
              setPan({ x: 0, y: 0 });
            }}
          >
            <Maximize />
            Fit
          </Button>
        </div>
      </div>
      <div className="relative min-h-[320px] flex-1 overflow-hidden sm:min-h-[380px] lg:min-h-[120px]">
        <canvas
          ref={canvas}
          id="pcbCanvas"
          className={`absolute inset-0 h-full w-full touch-none ${picking ? "cursor-crosshair" : "cursor-grab active:cursor-grabbing"}`}
          role="img"
          aria-label={`PCB toolpaths: ${shownPlane.toUpperCase()} projection. ${picking ? "Select a design reference; no machine movement." : "Drag to pan; Control or Command and scroll to zoom."}`}
          aria-describedby="pcbPreviewHint"
          onPointerDown={(event) => {
            if (!active || event.button !== 0 || !event.isPrimary) return;
            drag.current = {
              id: event.pointerId,
              x: event.clientX,
              y: event.clientY,
              pan: { ...pan },
            };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (!active) return;
            const held = drag.current;
            if (held && held.id === event.pointerId && !picking)
              setPan({
                x: held.pan.x + event.clientX - held.x,
                y: held.pan.y + event.clientY - held.y,
              });
            const point = location(event.clientX, event.clientY);
            if (point)
              setCursor(
                `${horizontal.toUpperCase()} ${point[0].toFixed(3)} · ${vertical.toUpperCase()} ${point[1].toFixed(3)} mm`,
              );
          }}
          onPointerUp={(event) => {
            const held = drag.current;
            drag.current = null;
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
            if (
              active &&
              picking &&
              held?.id === event.pointerId &&
              Math.hypot(event.clientX - held.x, event.clientY - held.y) < 5
            )
              pickPoint(event.clientX, event.clientY);
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
          onLostPointerCapture={() => {
            drag.current = null;
          }}
          onPointerLeave={() => setCursor(null)}
        />
        <svg
          className="pointer-events-none absolute inset-0 h-full w-full overflow-hidden"
          aria-hidden="true"
        >
          {marker && (
            <circle
              cx={marker.x}
              cy={marker.y}
              r="4"
              fill="var(--destructive)"
            />
          )}
        </svg>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-3 py-2 text-xs text-muted-foreground">
        {Object.keys(roleTokens)
          .filter((role) => role !== "other")
          .map((role) => (
            <span key={role} className="capitalize">
              <span
                aria-hidden="true"
                style={{ color: `var(--${roleTokens[role]}, var(--primary))` }}
              >
                ●{" "}
              </span>
              {role}
            </span>
          ))}
        <span>⊕ Job origin</span>
        <span className="ml-auto font-mono tabular-nums" id="pcbCursor">
          {cursor || `${shownPlane.toUpperCase()} · planned placement`}
        </span>
      </div>
      <p
        id="pcbPreviewHint"
        className="border-t px-3 py-2 text-xs leading-relaxed text-muted-foreground"
      >
        {picking
          ? "Click a design reference in the top view. This only fills design X/Y; it never moves the cutter. "
          : "Drag to pan. Ctrl/⌘ + scroll to zoom. "}
        XY uses planned machine coordinates; Z uses the source work datum. Stock
        and margin are declared values. The initial approach is not shown.
      </p>
    </section>
  );
});
