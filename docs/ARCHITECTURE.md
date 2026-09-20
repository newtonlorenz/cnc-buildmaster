# Architecture

CNC Buildmaster is a local Python-served web application. One React 19 root owns
the complete UI. Python owns validation, job state and machine-session transitions;
UGS remains the sole serial owner. The browser API remains **v7**.

## Browser application

All paths in this table are relative to `scripts/cnc-map-ui/src/`.

| Source | Responsibility |
| --- | --- |
| `app.tsx` | Call `createRoot` once on `#root`; provide the desktop shell, navigation, appearance, utilities, file import and global Stop handling. |
| `workbench-context.tsx` | Share the client snapshot, authenticated actions, navigation, appearance and draft-dirty state through `WorkbenchContext`. |
| `lib/machine-client.ts` | Own browser transport, polling, request state and held-jog cancellation. |
| `components/ui/` | Installed shadcn source primitives using Radix UI and Tailwind 4: buttons, fields, sidebar, dialogs, sheets, tabs, tables, menus and related controls. |
| `components/workbench-controls.tsx` | Compose shared labelled fields, notices, panels and the Stop button from those primitives. |
| `components/ai-elements/` | Installed Plan, Task and Queue source components composed in the same React tree. |
| `job-guide.tsx` | Present preparation stages, stock/path overview, operation queue and next-action inspector. This is the default workspace. |
| `preparation-tools.tsx` | Present offline fixture, tool, recipe, camera-measurement and draft-preparation tools. |
| `views/pcb-workspace.tsx` | Edit stock, placement, operation metadata and alignment drafts; review and export an aligned draft. |
| `views/toolpath-preview.tsx` | Render cached Canvas paths in XY/XZ/YZ, visibility and rapid-travel choices, pan/zoom and design-reference picking. Live machine XY is a separate overlay; machine Z is not overlaid on source work Z. |
| `views/surface-workspace.tsx` | Present setup, bounded jogging, area definition, grid planning, supervised measurement and saved results. |
| `views/surface-plot.tsx` | Render the SVG map, current/draft grid, corners and cutter position; request a guarded move only when click positioning is enabled. Fit/zoom only changes the view. |
| `views/camera-view.tsx` | Own an optional browser camera stream and release it on close, page hide or loss. The preview does not record or upload video. |
| `mapping-plan.js` | Calculate view-only grid previews and spacing choices. Server geometry remains authoritative. |
| `styles.css` | Supply the shared Tailwind theme, light/dark tokens and workbench layout. |

The four workspaces are Job guide, Files & alignment, Jog & surface and Workshop tools. They stay
in the same provider tree, with workspace activity passed to interactive views.
Utilities use Radix portals within that tree. There is no second controller,
global `Buildmaster` bridge, Lit runtime or Shadow DOM application island.

`MachineClient` exposes one snapshot through `useSyncExternalStore`. It polls
`/api/state` and refreshes `/api/pcb` when revisions or measurement evidence change.
Requests carry the bearer token and `X-Client-ID`; action requests include the
current `sessionId`, and job mutations include `pcbRevision`. The server checks
them. A missing connection or API-version mismatch locks ordinary controls.
Stop has a separate path that remains callable while another action is pending.

Held jogging uses an independent release request, so release is not queued behind
the active hold. Workspace changes, utilities, mobile navigation, blur, page hide,
connection failure and Escape release holds. Movement shortcuts are restricted to
the active, enabled surface teaching view. Native form, menu and dialog input
cannot become jogging, corner capture or probe readiness. Enter replies only to
the current measurement prompt when the permitted workspace has focus. Browser
Stop depends on the connection and is not a substitute for the physical stop.

Appearance defaults to System and follows `prefers-color-scheme`; Light and Dark
override it. The theme is stored in localStorage. Workspace, client identity and
the browser bearer token use sessionStorage; the token is removed from the URL
fragment after bootstrap. These values cannot restore an armed machine session.
The sidebar primitive also writes its presentation-state cookie.

## Build and content security

`scripts/cnc-map-ui/build.mjs` bundles `src/app.tsx` with esbuild into
`scripts/cnc-map-web/app.bundle.js`. Tailwind 4 compiles `src/styles.css` into
`scripts/cnc-map-web/app.css`. `index.html` loads those two local assets and supplies
`#root`. The server explicitly allowlists these assets. The built application
needs no frontend development server, CDN or runtime package download; machine
workers still use Node.js. See the [UI build guide](../scripts/cnc-map-ui/README.md).

Each HTML response gets a fresh style nonce. The server places it in the
`csp-nonce` meta element and the response's `style-src` policy. Before React mounts,
`app.tsx` passes it to `get-nonce` with `setNonce`; Radix runtime styles can then use
that nonce. The shared ScrollArea explicitly passes `getNonce()` to its viewport.

The CSP retains `default-src 'self'`, `script-src 'self'`, nonce-scoped
`style-src 'self'`, `connect-src 'self'`, `media-src 'self' blob:`,
`frame-ancestors 'none'`, `base-uri 'none'` and `form-action 'none'`. It does not use
`unsafe-inline`. Responses use `Cache-Control: no-store`. New runtime style
injection must preserve this path; do not broaden the policy to accommodate it.

## Server and UGS integration

Script paths below are relative to `scripts/` unless stated otherwise.

| Module | Responsibility |
| --- | --- |
| `cnc_map_server.py` | Own the local web process and runtime files. |
| `cnc_map_web.py` | Authenticate browser requests, enforce session transitions and serve the allowlisted UI. |
| `surface_config.py`, `surface_config.mjs` | Validate portable installation configuration and supply it to Python/Node workers. |
| `pcb_gcode.py` | Parse, transform and inspect supported G-code without machine access. |
| `pcb_workspace.py` | Manage job files, stock, cutters, references, planning records and draft export. |
| `job_workflow.py` | Derive preparation status and bind map coverage to the job fingerprint. |
| `job_tools.py`, `job_actions.py` | Provide numeric helpers, offline draft generators and their endpoints. |
| `cnc_map_terminal.py`, `cnc_map_support.py` | Derive measurement geometry and prepare route previews and error descriptions. |
| `ugs_api.py` | Inspect UGS through an explicit read-only endpoint list; reject redirects and proxy use. |
| `ugs_map_watch.mjs` | Observe reference continuity during an active session. |
| `ugs_map_jog.mjs` | Apply bounded movement and held-jog cancellation through UGS. |
| `ugs_puck_map.mjs` | Control the supervised contact sequence and save measurements. |
| `job_handoff.py` | Load only the current session's accepted measurement evidence for native handoff. |
| `ugs_surface_bridge.py` | Import an explicit relative grid and verify native readback; no movement, cutting-file selection or compensation apply. |
| `extensions/ugs/` at repository root | Supply the guarded loopback API, native held jogging and native surface-map integration. |

Both local services bind to loopback. Configuration does not extend firmware
support or remove compatibility checks. The UGS extension and native surface
dependencies remain pinned to their supported upstream hashes. Puck height and
other machine values belong to the installation configuration, not the UI.

## Evidence and qualification

`complete-rectangle` records missing inferred corners after checking the supplied
bounds, stationary reference and raised Z. It does not move the machine. A local
grid preview does not authorise a scan. A completed scan requires accepted saved
evidence and the height-map checksum.

A job-linked map must match both the current setup epoch and valid captured alignment. The epoch changes on setup/reference edits and workspace replacement. Returning to the same geometry does not restore an invalidated map. The job fingerprint includes stock, face, placement, source digests, operation
roles, cutters, fixture, material and source-compensation state. Reopening a job
restores planning records, not camera approvals, fresh tool references or machine
authority. Reference changes invalidate captured alignment. An observation
checkbox cannot establish material-top Z.

`job_handoff.py` verifies in-memory acceptance digests for `surface.xyz`,
`config.json`, `result.json` and `ugs-handoff.json`. The handoff file records import
instructions; a separate guarded bridge receipt records verified native map
readback. Neither proves physical reference continuity, correct material-top Z or
verified compensated cutting paths. The preparation guide does not release a
cutting operation.

Source and simulation review are verified as recorded in the
[UI verification record](../scripts/cnc-map-ui/README.md#verification). The browser
layout uses the reviewed standard 16rem sidebar. Simulation and software checks
do not qualify physical clearance, probing, cutting accuracy or unattended
operation. This record does not establish live installation or hardware acceptance.

## Preparation modes and handoff lifecycle

`--offline` loads no machine configuration, starts no watchdog or UGS worker, and
uses a separate `data/offline-preparation` store. Its action allowlist fails closed
for new endpoints. Pure digital calculations and job persistence remain available;
machine-dependent generators and reference/export/import actions are blocked.
`--demo` is still explicit simulation; normal startup still requires validated
configuration.

After an accepted scan, the read-only observer stays active. Completed-session
aligned export requires the same observer, a fresh guarded snapshot and current
alignment/map identity. `handoff-finish` explicitly closes the observer and blocks
further reference-dependent actions while preserving results. `new-session` can
retire an idle completed observer; running motion workers still prevent replacement.

`recover-session` is an explicit token-authenticated exception to owner matching,
not to Host/Origin checks. It requires expired ownership and no active setup or
workers, serialises with actions, revokes the old owner, rotates the setup ID and
clears physical evidence. It preserves preparation work. Old session IDs cannot
mutate the recovered job.

Job saves serialise compact UTF-8 within a shared size limit, fsync a temporary
sibling, and publish the complete file atomically without overwriting another
package. Failed writes cannot appear in recent jobs. Recovery also covers jobs
with only stock, fixture or recipe records.

The Job guide derives readable, actionable checks from server evidence; these
checks never authorise machine actions. Workshop tools mount on first visit and
remain mounted across navigation. Surface result tiles display contacts rather
than interpolated geometry. Setup sheets and measurement reports retain explicit
scope and no-cutting-release statements.


## Preview and heartbeat responsiveness

Machine status polling does not await the job geometry response. A job refresh
has its own single-flight request; job writes still await their fresh revision.
The server's status endpoint reads the revision as a refresh hint without waiting
for the job lock. It cannot grant mutation authority: edits still validate their
revision under that lock.

A job response transforms every vertex once and computes complete bounds in that
pass. Guide and scan-area checks share a detached immutable geometry view from
that same locked read. They independently check current session and map identity;
there is no persistent authority cache or decimation of clearance bounds.


## Agent companion protocol

`scripts/agent_api.py` owns a versioned capability catalogue, separate per-process
credentials, bounded request records and the operator queue. Agent reads never
claim browser ownership or update its heartbeat. Preparation calls use the same
Controller and job revision guards, only while explicit preparation access is
enabled and no machine/reference session is active. The browser workspaces pause
editing during that access; agent edits are visible in the same state.

Machine requests contain an immutable action, arguments, reason, session, job
revision and position/setup snapshot. They expire after two minutes. Only a
normally authenticated browser can approve or reject one, with one-use dispatch
and a fresh check inside the Controller action lock. A dispatch receipt does not
claim motion completion. Probe replies, arbitrary commands, spindle control,
held-jog leases and cutting-file streaming are not agent tools. Software Stop
bypasses the operator queue and normal action lock.

The local CLI/MCP bridge reads a private `agent-PORT.json` discovery file. These
credentials are distinct from the browser token, rotate on server restart, and
are removed on clean shutdown. Host/Origin checks and loopback binding still
apply. This is a capability boundary inside the app, not an operating-system
sandbox for another process running as the same user.
