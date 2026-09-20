# CNC Buildmaster desktop UI

The whole browser application uses React 19 and installed shadcn source primitives
over Radix UI and Tailwind 4. `src/app.tsx` mounts one `createRoot` on `#root`.
The shell, Job guide, Files & alignment, Jog & surface, Workshop tools and utilities share
`WorkbenchContext` and one `MachineClient`. AI Elements Plan, Task and Queue belong
to that same tree. Icons come from `lucide-react`.

The app is served locally by Python. UGS owns the serial connection. No Lit shell,
global `Buildmaster` controller or Shadow DOM island is part of the active app.

## Build

Run from the repository root:

```sh
npm ci --prefix scripts/cnc-map-ui
npm run build:ui
```

The equivalent build command is `npm run --prefix scripts/cnc-map-ui build`.
`build.mjs` runs esbuild for `src/app.tsx` and the Tailwind 4 CLI for
`src/styles.css`. Outputs are `scripts/cnc-map-web/app.bundle.js` and
`scripts/cnc-map-web/app.css`; `index.html` loads them. Rebuild after changing
components or styles. Do not edit generated bundles directly.

`package-lock.json` pins the frontend dependency tree. `components.json` records
the shadcn source configuration and `@/` aliases. The built UI needs no CDN,
frontend development server or runtime package download. Node.js is still used
by the local machine workers.

## Source boundaries

| Source | Purpose |
| --- | --- |
| `src/app.tsx` | Shell, sidebar, appearance, utilities, imports and global Stop. |
| `src/workbench-context.tsx` | Shared snapshot, actions, navigation and dirty-draft reporting. |
| `src/lib/machine-client.ts` | Authenticated API v7 transport, polling, revision-aware job requests and held-jog release. |
| `src/components/ui/` | Shared shadcn primitives. |
| `src/components/workbench-controls.tsx` | Labelled fields, panels, notices and Stop. |
| `src/components/ai-elements/` | Plan, Task and Queue used by `src/job-guide.tsx` and preparation disclosures. |
| `src/views/` | PCB workspace and Canvas preview, surface workspace and SVG plot, browser camera preview. |
| `src/preparation-tools.tsx` | Offline preparation forms and calculations. |
| `src/mapping-plan.js` | View-only geometry; final validation remains server-owned. |
| `src/styles.css` | Shared semantic tokens, appearance and layout. |

Use these components across the application. Add machine actions through the
shared client and guarded server endpoints; a view must not create another
transport, serial connection or source of machine authority.

## Appearance, input and CSP

Appearance defaults to System, with Light and Dark overrides. Only the selected
appearance is saved in localStorage. Session storage holds workspace choice,
client identity and the bearer token used by the shared transport. The sidebar
primitive writes a presentation-state cookie. None of these values grants motion
authority or restores a physical reference.

Cmd/Ctrl+K opens navigation search; Cmd/Ctrl+B toggles the sidebar. Workspace
changes, utilities and loss of focus release held jogging. Escape requests Stop,
including from dialogs. Utility dialogs, search and mobile navigation expose a
Stop control. Native Enter on a control must keep that control's behaviour. Only
the enabled surface view can interpret blank-workspace keys as capture, movement
or a reply to the current probe prompt. View-only fit/zoom never moves the cutter.

The server generates a fresh style nonce for each HTML response. `app.tsx` reads
the `csp-nonce` meta element and calls `setNonce` from `get-nonce` before mounting.
`components/ui/scroll-area.tsx` explicitly passes `getNonce()` to the Radix
viewport. This permits the required library runtime styles under the strict CSP;
do not add `unsafe-inline`, external scripts or external styles.

## Verification

From the repository root, the implementation checks are:

```sh
npm run --prefix scripts/cnc-map-ui typecheck
npm test
npm run test:browser
```

**Verification record — 20 September 2026:** implemented workflow and source
review, with isolated simulation and offline storage.

- 217 Python tests and 113 JavaScript tests passed.
- The pinned Java harnesses passed 20 held-jog cases and 41 native surface-map
  transaction cases, using fake controllers and no machine commands.
- All seven browser suites passed: machine/surface controls, files/alignment,
  desktop interaction, efficient mapping/results, Job guide/copper simulation,
  offline preparation/closed-tab recovery, and agent access/operator review.
- TypeScript checking and the production UI build passed. Generated assets were
  checked for reproducibility. Browser coverage includes strict CSP, native
  keyboard interaction, fixed Stop controls and desktop/compact/mobile layouts.
- Light/dark surface results, task entry, job guidance and offline mobile views
  were inspected. The single design detector pass returned `[]`.
- Production dependency audits for both npm manifests reported zero known
  vulnerabilities at the time of the review.

The slow-preview regressions hold geometry work open while status, hold release
and Stop remain available, and exercise approximately 4.2 MB of real parsed CAM
with over 500,000 vertices. Geometry and complete bounds are computed once per
response, without decimating clearance evidence. Completed-scan tests cover
aligned export, native import guards, explicit finish, setup invalidation and
non-restoration of physical authority after saved-job recovery.

Browser suites use isolated demo servers and intercepted native-import fixtures.
The offline persistence journey uses disposable storage. No live UGS installation,
serial reconnection or physical CNC operation was performed. The pre-existing
local machine server was preserved.

See [DESIGN.md](../../DESIGN.md) for source-derived tokens and layout, and
[Architecture](../../docs/ARCHITECTURE.md) for state and evidence boundaries.
For future layout or theme changes, recheck desktop and narrow viewports, focus,
scrolling, Stop visibility and runtime CSP behaviour. Keep screenshot evidence
matched to the reviewed build. Completed simulation review and successful software
checks do not qualify a real probe, cutting process or physical machine setup.


The agent review covers authenticated companion requests, exclusive preparation
editing, applied replacement generations, explicit one-use approval, rejected and
stale requests, bounded demo jogging, key-repeat rejection and Stop from the modal.
The local CLI/MCP suite also exercises a real disposable offline server. Runtime
credentials stay outside browser responses and are never copied into test reports.
