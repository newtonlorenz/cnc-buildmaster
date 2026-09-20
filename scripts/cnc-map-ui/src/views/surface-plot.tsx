import {
  useEffect,
  useId,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { Check, Maximize, Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatNumber } from "@/workbench-context";
import type { GridPreview, MappingArea } from "@/mapping-plan.js";

export const cornerNames = [
  "front-left",
  "front-right",
  "back-right",
  "back-left",
] as const;
export type CornerName = (typeof cornerNames)[number];
export interface XY {
  x: number;
  y: number;
}
export interface MappingCorner extends XY {
  name: CornerName;
  z?: number;
  source?: string;
}
export const cornerLabel = (name: string) => name.replace("-", " ");
export function areaCorner(area: MappingArea, name: CornerName): XY {
  const [frontBack, leftRight] = name.split("-");
  return {
    x: area.x[leftRight === "left" ? 0 : 1],
    y: area.y[frontBack === "front" ? 0 : 1],
  };
}

interface SurfacePlotProps {
  active: boolean;
  state: any;
  currentPlan: boolean;
  draft: GridPreview | null;
  showDraft: boolean;
  canAccept: boolean;
  canMove: boolean;
  onAccept: (name: CornerName) => void;
  onMove: (point: XY) => void;
  onError: (message: string) => void;
}

/** SVG geometry is view-only; explicit actions return through the guarded workspace client. */
export function SurfacePlot({
  active,
  state,
  currentPlan,
  draft,
  showDraft,
  canAccept,
  canMove,
  onAccept,
  onMove,
  onError,
}: SurfacePlotProps) {
  const svg = useRef<SVGSVGElement>(null);
  const patternId = useId();
  const [zoom, setZoom] = useState(1);
  const [pixel, setPixel] = useState(1);
  const [hover, setHover] = useState<XY | null>(null);
  const corners: MappingCorner[] = state?.corners ?? [];
  const area: MappingArea | null = state?.area ?? null;
  const plan = currentPlan ? state?.plan : null;
  const route: XY[] = plan ? (state?.route?.points ?? []) : [];
  const measurements: XY[] = state?.measurements ?? [];
  const position: XY | undefined = state?.status?.machineCoord;
  const currentPoint = state?.currentPoint;
  const nextPoint: XY | undefined = currentPoint
    ? route[currentPoint.index]
    : undefined;
  const minimumX =
    area?.x[0] ?? (corners.length ? Math.min(...corners.map((p) => p.x)) : 0);
  const minimumY =
    area?.y[0] ?? (corners.length ? Math.min(...corners.map((p) => p.y)) : 0);
  const width =
    (area
      ? area.x[1] - minimumX
      : corners.length
        ? Math.max(...corners.map((p) => p.x)) - minimumX
        : 0) || 20;
  const height =
    (area
      ? area.y[1] - minimumY
      : corners.length
        ? Math.max(...corners.map((p) => p.y)) - minimumY
        : 0) || 20;
  const scale = Math.min(440 / width, 240 / height);
  const originX = 320 - (width * scale) / 2;
  const originY = 205 + (height * scale) / 2;
  const xy = (point: XY) => ({
    x: originX + (point.x - minimumX) * scale,
    y: originY - (point.y - minimumY) * scale,
  });
  const points = (list: XY[]) =>
    list
      .map((point) => {
        const p = xy(point);
        return `${p.x},${p.y}`;
      })
      .join(" ");
  const viewWidth = 640 / zoom,
    viewHeight = 410 / zoom;

  useEffect(() => {
    if (!active || !svg.current) return;
    const node = svg.current;
    const resize = () => {
      const screenScale = Math.abs(node.getScreenCTM()?.a ?? 1);
      if (screenScale) setPixel(1 / screenScale);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    return () => observer.disconnect();
  }, [active, zoom]);

  function target(
    event: MouseEvent<SVGSVGElement> | PointerEvent<SVGSVGElement>,
  ) {
    const node = svg.current,
      matrix = node?.getScreenCTM();
    if (!active || !node || !matrix || !area || !corners.length) return null;
    const cursor = node.createSVGPoint();
    cursor.x = event.clientX;
    cursor.y = event.clientY;
    const local = cursor.matrixTransform(matrix.inverse());
    let x = (local.x - originX) / scale + minimumX;
    let y = (originY - local.y) / scale + minimumY;
    const snap = corners.find(
      (point) =>
        Math.hypot((point.x - x) * scale, (point.y - y) * scale) < 14 * pixel,
    );
    if (snap) {
      x = snap.x;
      y = snap.y;
    }
    // Check the raw target before rounding so an outside click cannot become an inside move.
    const inside =
      x >= area.x[0] && x <= area.x[1] && y >= area.y[0] && y <= area.y[1];
    return { x: Number(x.toFixed(3)), y: Number(y.toFixed(3)), inside };
  }

  return (
    <div className="surface-plot min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2">
        <span className="text-[13px] text-muted-foreground">
          Top view <span className="ml-2 font-mono text-xs">XY / mm</span>
        </span>
        <div
          className="flex items-center gap-1"
          aria-label="Surface view controls"
        >
          <Button
            id="surfaceZoomOut"
            variant="ghost"
            size="icon-sm"
            aria-label="Zoom surface out"
            disabled={zoom <= 0.5}
            onClick={() => setZoom((z) => Math.max(0.5, z / 1.25))}
          >
            <Minus />
          </Button>
          <Button
            id="surfaceZoomIn"
            variant="ghost"
            size="icon-sm"
            aria-label="Zoom surface in"
            disabled={zoom >= 4}
            onClick={() => setZoom((z) => Math.min(4, z * 1.25))}
          >
            <Plus />
          </Button>
          <Button
            id="surfaceFit"
            variant="ghost"
            size="sm"
            onClick={() => {
              setZoom(1);
              setHover(null);
            }}
          >
            <Maximize />
            Fit
          </Button>
        </div>
      </div>
      <div className="surface-viewport relative min-w-0 overflow-hidden bg-muted/30">
        {active && (
          <svg
            ref={svg}
            id="plot"
            viewBox={`${320 - viewWidth / 2} ${205 - viewHeight / 2} ${viewWidth} ${viewHeight}`}
            role="group"
            aria-label="Taught corners and scan route, machine XY in millimetres"
            className={`block h-[330px] w-full ${canMove ? "cursor-crosshair" : ""}`}
            onPointerMove={(event) => {
              const p = target(event);
              setHover(p?.inside ? p : null);
            }}
            onPointerLeave={() => setHover(null)}
            onClick={(event) => {
              if (
                !canMove ||
                (event.target instanceof Element &&
                  event.target.closest("button"))
              )
                return;
              const p = target(event);
              if (!p) return;
              if (!p.inside) {
                onError("Choose a point inside the taught rectangle.");
                return;
              }
              onMove({ x: p.x, y: p.y });
            }}
          >
            <defs>
              <pattern
                id={patternId}
                width="25"
                height="25"
                patternUnits="userSpaceOnUse"
              >
                <circle cx="0" cy="0" r="1" className="fill-border" />
              </pattern>
            </defs>
            <rect
              x={320 - viewWidth / 2}
              y={205 - viewHeight / 2}
              width={viewWidth}
              height={viewHeight}
              fill={`url(#${patternId})`}
            />
            {!corners.length ? (
              <g>
                <rect
                  x="100"
                  y="70"
                  width="440"
                  height="270"
                  rx="4"
                  className="fill-muted/40 stroke-border"
                  strokeDasharray="5 6"
                />
                <text
                  x="320"
                  y="195"
                  textAnchor="middle"
                  className="fill-foreground"
                  fontSize={14 * pixel}
                >
                  Your taught area will appear here
                </text>
                <text
                  x="320"
                  y="220"
                  textAnchor="middle"
                  className="fill-muted-foreground"
                  fontSize={13 * pixel}
                >
                  Start at whichever corner is closest
                </text>
              </g>
            ) : (
              <>
                {area && (
                  <polygon
                    points={points(
                      cornerNames.map((name) => areaCorner(area, name)),
                    )}
                    className="fill-primary/5 stroke-primary/40"
                    strokeWidth="1.5"
                    vectorEffect="non-scaling-stroke"
                  />
                )}
                {route.length > 0 && (
                  <g>
                    <polyline
                      data-route="scan"
                      points={points(route.slice(0, -1))}
                      fill="none"
                      className="stroke-primary"
                      strokeWidth="1.5"
                      vectorEffect="non-scaling-stroke"
                    />
                    <polyline
                      data-route="return"
                      points={points(route.slice(-2))}
                      fill="none"
                      stroke="var(--warning, currentColor)"
                      strokeWidth="2"
                      strokeDasharray="5 5"
                      vectorEffect="non-scaling-stroke"
                    />
                    {plan.grid.x.flatMap((x: number) =>
                      plan.grid.y.map((y: number) => {
                        const p = xy({ x, y });
                        return (
                          <circle
                            key={`${x}:${y}`}
                            cx={p.x}
                            cy={p.y}
                            r={3 * pixel}
                            className="fill-primary"
                          />
                        );
                      }),
                    )}
                    <text
                      x={
                        xy(route[0]).x +
                        (route[0].x > minimumX + width / 2 ? -18 : 18) * pixel
                      }
                      y={
                        xy(route[0]).y +
                        (route[0].y > minimumY + height / 2 ? 34 : -28) * pixel
                      }
                      textAnchor={
                        route[0].x > minimumX + width / 2 ? "end" : "start"
                      }
                      fontSize={12 * pixel}
                      className="fill-primary"
                    >
                      Start / return
                    </text>
                  </g>
                )}
                {showDraft &&
                  !plan &&
                  draft?.grid &&
                  draft.grid.x.flatMap((x) =>
                    draft.grid!.y.map((y) => {
                      const p = xy({ x, y });
                      return (
                        <circle
                          key={`${x}:${y}`}
                          data-draft-point="true"
                          cx={p.x}
                          cy={p.y}
                          r={3 * pixel}
                          className="fill-muted-foreground"
                          opacity=".7"
                        />
                      );
                    }),
                  )}
                {measurements.map((point, index) => {
                  const p = xy(point);
                  return (
                    <circle
                      key={index}
                      cx={p.x}
                      cy={p.y}
                      r={6 * pixel}
                      className="fill-primary stroke-background"
                      strokeWidth="1.5"
                      vectorEffect="non-scaling-stroke"
                    />
                  );
                })}
                {currentPoint && (
                  <circle
                    cx={xy(currentPoint.point).x}
                    cy={xy(currentPoint.point).y}
                    r={17 * pixel}
                    fill="none"
                    stroke="var(--warning, currentColor)"
                    strokeWidth="2"
                    vectorEffect="non-scaling-stroke"
                  />
                )}
                {nextPoint && (
                  <g>
                    <circle
                      cx={xy(nextPoint).x}
                      cy={xy(nextPoint).y}
                      r={10 * pixel}
                      fill="none"
                      className="stroke-muted-foreground"
                      strokeDasharray="3 3"
                      vectorEffect="non-scaling-stroke"
                    />
                    <text
                      x={xy(nextPoint).x}
                      y={xy(nextPoint).y - 18 * pixel}
                      textAnchor="middle"
                      fontSize={12 * pixel}
                      className="fill-muted-foreground"
                    >
                      Next
                    </text>
                  </g>
                )}
                {area &&
                  !plan &&
                  cornerNames
                    .filter(
                      (name) => !corners.some((point) => point.name === name),
                    )
                    .map((name) => {
                      const p = xy(areaCorner(area, name));
                      return (
                        <g key={name}>
                          <text
                            x={p.x}
                            y={
                              p.y +
                              (name.startsWith("front") ? 38 : -30) * pixel
                            }
                            textAnchor="middle"
                            fontSize={12 * pixel}
                            className="fill-muted-foreground"
                          >
                            Accept {cornerLabel(name)}
                          </text>
                          <foreignObject
                            x={p.x - 24 * pixel}
                            y={p.y - 24 * pixel}
                            width={48 * pixel}
                            height={48 * pixel}
                            overflow="visible"
                          >
                            <div
                              style={{
                                width: 48,
                                height: 48,
                                transform: `scale(${pixel})`,
                                transformOrigin: "0 0",
                              }}
                              className="flex items-center justify-center"
                            >
                              <Button
                                data-suggested={name}
                                variant="outline"
                                size="icon-lg"
                                className="rounded-full border-2 border-dashed border-[color:var(--warning)] bg-[var(--warning-soft)] text-[var(--warning)]"
                                disabled={!canAccept}
                                aria-label={`Accept suggested ${name} corner without movement`}
                                title={`Accept ${cornerLabel(name)} without moving`}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  if (canAccept) onAccept(name);
                                }}
                              >
                                <Check />
                              </Button>
                            </div>
                          </foreignObject>
                        </g>
                      );
                    })}
                {corners.map((point) => {
                  const p = xy(point);
                  const front = point.name.startsWith("front");
                  return (
                    <g key={point.name}>
                      <circle
                        cx={p.x}
                        cy={p.y}
                        r={13 * pixel}
                        className="fill-background stroke-primary"
                        strokeWidth="2"
                        vectorEffect="non-scaling-stroke"
                      />
                      <text
                        x={p.x}
                        y={p.y + 4 * pixel}
                        textAnchor="middle"
                        fontSize={11 * pixel}
                        className="fill-primary"
                      >
                        {point.name
                          .split("-")
                          .map((part) => part[0].toUpperCase())
                          .join("")}
                      </text>
                      <text
                        x={p.x}
                        y={p.y + (front ? 31 : -25) * pixel}
                        textAnchor="middle"
                        fontSize={12 * pixel}
                        className="fill-muted-foreground"
                      >
                        {point.x.toFixed(1)}, {point.y.toFixed(1)}
                      </text>
                    </g>
                  );
                })}
                {position &&
                  Number.isFinite(position.x) &&
                  Number.isFinite(position.y) && (
                    <circle
                      cx={xy(position).x}
                      cy={xy(position).y}
                      r={5 * pixel}
                      className="fill-destructive stroke-background"
                      strokeWidth="2"
                      vectorEffect="non-scaling-stroke"
                    >
                      <title>Current cutter XY</title>
                    </circle>
                  )}
              </>
            )}
          </svg>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-2">
          <span className="size-2 rounded-full bg-destructive" />
          Cutter position
        </span>
        <span id="targetHint" className="font-mono tabular-nums">
          {hover
            ? `Target X ${formatNumber(hover.x)} · Y ${formatNumber(hover.y)} mm`
            : "Machine coordinates · raised Z"}
        </span>
      </div>
    </div>
  );
}
