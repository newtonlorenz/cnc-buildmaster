/** Presentation arithmetic only. A preview never authorises a machine action. */
export interface MappingArea { x: [number, number]; y: [number, number] }
export interface MappingGrid { x: number[]; y: number[]; spacing: number }
export type GridPreview = {
  grid: MappingGrid; points: number; placements: number; startsHere: boolean; error?: never;
} | { error: string; grid?: never; points?: never; placements?: never; startsHere?: never };
export function gridAxis(lo: number, hi: number, spacing: number): number[];
export function previewGrid(area: MappingArea | null | undefined, spacing: number, position?: {x: number; y: number} | null): GridPreview | null;
export function gridChoices(area: MappingArea | null | undefined): {label: string; divisions: number; spacing: number; draft: GridPreview | null}[];
export function formatDuration(seconds: number): string;
