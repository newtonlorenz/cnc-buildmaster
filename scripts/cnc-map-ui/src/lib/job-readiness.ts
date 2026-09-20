/** Presentation of preparation evidence. This never authorises a machine action. */
export type PreparationCheck = {
  id: string;
  title: string;
  detail: string;
  complete: boolean;
  view: "pcb" | "surface" | "guide";
  section?: string;
};
export function preparationChecks(job: any, state: any): PreparationCheck[] {
  const operations = job.operations || [];
  const tools = operations.filter((o: any) => !o.tool || o.diameter == null);
  const geometry = operations.filter((o: any) => !o.fits || !o.depthOk);
  const warnings = operations.flatMap((o: any) =>
    (o.warnings || []).filter(
      (w: string) => !w.startsWith("The initial approach"),
    ),
  );
  const aligned = !!job.guide?.steps?.find((s: any) => s.id === "alignment")
    ?.complete;
  const measured = !!job.guide?.measured;
  return [
    {
      id: "files",
      title: "Cutting files",
      complete: operations.length > 0,
      detail: operations.length
        ? `${operations.length} operation${operations.length === 1 ? "" : "s"} loaded. Keep files from one machining face together.`
        : "Open G-code from your CAM software. Gerber files must be converted in CAM first.",
      view: "pcb",
    },
    {
      id: "tools",
      title: "Cutters",
      complete: !!operations.length && !tools.length,
      detail: tools.length
        ? `${tools.length} operation${tools.length === 1 ? " needs" : "s need"} a cutter description and effective cutting diameter.`
        : "Each operation has a cutter and an effective diameter.",
      view: "pcb",
      section: "pcbOperationsSection",
    },
    {
      id: "stock",
      title: "Stock & path checks",
      complete: !!operations.length && !geometry.length && !warnings.length,
      detail: geometry.length
        ? `${geometry.length} operation${geometry.length === 1 ? " exceeds" : "s exceed"} the declared stock or depth limits. Check dimensions and placement.`
        : warnings.length
          ? `${warnings.length} source-file check${warnings.length === 1 ? " needs" : "s need"} review.`
          : "Cutting footprints and depths fit the declared material. Physical clearance still needs review.",
      view: "pcb",
      section: geometry.length ? "pcbSetupSection" : "pcbReviewSection",
    },
    {
      id: "source",
      title: "Height correction in source files",
      complete: job.workflow?.sourceCompensation === "none",
      detail:
        job.workflow?.sourceCompensation === "applied"
          ? "These files already have height correction. Do not apply another map. Return to the original CAM files for a new scan."
          : job.workflow?.sourceCompensation === "none"
            ? "Declared uncompensated. Height correction can be reviewed once in UGS."
            : "Check your CAM export before applying a map. Choose whether height correction is already included.",
      view: "guide",
      section: "processSettings",
    },
    {
      id: "alignment",
      title: "Workpiece alignment",
      complete: aligned,
      detail: aligned
        ? "Two captured references set placement; the independent third reference passed."
        : state?.offline
          ? "You can plan placement here. Capture fresh references in a machine session before exporting an aligned draft."
          : "Capture two reference points to align the files, then a third point to check the fit.",
      view: "pcb",
      section: "pcbAlignmentSection",
    },
    {
      id: "surface",
      title: "Surface measurements",
      complete: measured,
      detail: measured
        ? "An accepted map is linked to this job setup. Import and compensation are separate."
        : state?.phase === "complete" && state?.result
          ? "A map is saved, but it is not linked to this job setup. Review coverage and setup before using it."
          : "Use the cutting area to avoid measuring unused material. A puck waits for you at each point.",
      view: "surface",
    },
  ];
}
const cell = (value: unknown) =>
  String(value ?? "Not recorded")
    .replace(/[\r\n]+/g, " ")
    .replace(/\|/g, "\\|")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
export function setupSheet(
  job: any,
  state: any,
  date = new Date().toISOString(),
): string {
  const checks = preparationChecks(job, state);
  const lines = [
    `# ${cell(job.name)} — preparation record`,
    "",
    `Created: ${date}`,
    "",
    `Mode: ${state?.demo ? "SIMULATION — no machine evidence" : state?.offline ? "Offline preparation — no machine access" : "Machine workspace"}`,
    "",
    "This is a preparation snapshot, not a cutting release. Saved references do not restore machine position or workholding continuity.",
    "",
    "## Workpiece",
    "",
    `Material: ${cell(job.workflow?.material)} · task: ${cell(job.workflow?.intent)}`,
    `Revision: ${cell(job.boardRevision)} · machining face: ${cell(job.face)} · mirrored: ${job.placement?.mirror ? "yes" : "no"}`,
    `Stock: ${cell(job.stock?.width)} × ${cell(job.stock?.height)} × ${cell(job.stock?.thickness)} mm`,
    `Planned machine XY origin: ${cell(job.placement?.x)}, ${cell(job.placement?.y)} mm · rotation: ${cell(job.placement?.angle)}°`,
    "",
    "## Preparation checks",
    "",
    ...checks.map(
      (c) => `- [${c.complete ? "x" : " "}] ${c.title}: ${c.detail}`,
    ),
    "",
    "## Operation order",
    "",
    "| Order | File | Cutter | Effective diameter (mm) | Source SHA-256 |",
    "| --- | --- | --- | --- | --- |",
    ...(job.operations || []).map(
      (o: any, i: number) =>
        `| ${i + 1} | ${cell(o.name)} | ${cell(o.tool)} | ${cell(o.diameter)} | ${cell(o.sha256)} |`,
    ),
    "",
    "## Surface evidence",
    "",
    `Setup fingerprint: ${cell(job.guide?.fingerprint)}`,
    `Map linked to this job: ${job.guide?.mapMatchesJob ? "yes" : "no"}`,
    `Accepted measurements: ${job.guide?.measured ? "yes, for this job" : "not established for this job"}`,
    `Last native import readback: ${state?.handoff?.verified === true ? "verified at import time; current physical continuity is unverified" : "not verified"}`,
    "",
    "## Continue in UGS",
    "",
    "1. Keep the tool, workholding and machine connection consistent with the measurements. A change requires a fresh reference review.",
    "2. Export and inspect the aligned draft operation files. Z values are not height-corrected by Buildmaster.",
    "3. Import an accepted map into the empty AutoLeveler before selecting a cutting file. Check grid coverage and native readback.",
    "4. Use Finish preparation in Buildmaster after export and map import. This ends its reference monitoring. Finish before changing Z or selecting cutting files in UGS.",
    "5. In UGS, establish material-top Z for the fitted cutter. Apply compensation exactly once, only to uncompensated source paths.",
    "6. Review the final toolpath, cutting depths, workholding and clearance. Remove probe clips before spindle operation.",
    "7. Send the reviewed operation from UGS. A tool change requires its own Z reference check.",
    "",
    "Physical clearance, compensation of the selected file and a qualified cut are not established by this report.",
    "",
  ];
  return lines.join("\n");
}
