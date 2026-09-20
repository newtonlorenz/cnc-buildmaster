import { createContext, useContext } from "react";
import type { MachineClient, ClientSnapshot } from "./lib/machine-client";
export type Workspace = "guide" | "surface" | "pcb" | "tools";
export type Utility =
  "connection" | "camera" | "shortcuts" | "log" | "help" | "agents" | null;
export type Appearance = "system" | "light" | "dark";
export type JobPost = (
  action: string,
  body?: Record<string, unknown>,
  receive?: (result: any) => void,
) => Promise<boolean>;
export interface WorkbenchContextValue extends ClientSnapshot {
  client: MachineClient;
  post: JobPost;
  call: JobPost;
  view: Workspace;
  navigate: (view: Workspace, section?: string) => void;
  section: string | null;
  modalOpen: boolean;
  openUtility: (utility: Utility) => void;
  appearance: Appearance;
  setAppearance: (appearance: Appearance) => void;
  dirty: boolean;
  dirtyKeys: Readonly<Record<string, boolean>>;
  setDirty: (key: string, value: boolean) => void;
  importFiles: () => void;
  openPackage: () => void;
  savePackage: () => Promise<boolean>;
}
export const WorkbenchContext = createContext<WorkbenchContextValue | null>(
  null,
);
export function useWorkbench() {
  const value = useContext(WorkbenchContext);
  if (!value) throw new Error("Workbench provider is missing");
  return value;
}
export function downloadFile(
  name: string,
  content: BlobPart,
  type = "application/json",
) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const formatNumber = (value: unknown, digits = 3) =>
  typeof value === "number" && Number.isFinite(value)
    ? value.toFixed(digits)
    : "—";
