# Architecture

| Module | Responsibility |
| --- | --- |
| `cnc_map_server.py` | Own the local web process and its runtime files. |
| `cnc_map_web.py` | Authenticate browser requests and enforce session transitions. |
| `surface_config.py` | Read and validate machine configuration. |
| `surface_config.mjs` | Provide the same configuration to Node.js workers. |
| `pcb_gcode.py` | Parse, transform and inspect supported G-code. No machine access. |
| `pcb_workspace.py` | Manage job files, stock, cutters, references and draft export. |
| `cnc_map_terminal.py` | Derive measurement geometry from recorded corners. |
| `cnc_map_support.py` | Prepare route previews and error descriptions. |
| `ugs_api.py` | Inspect UGS through an explicit read-only endpoint list. |
| `ugs_map_watch.mjs` | Observe reference continuity during an active session. |
| `ugs_map_jog.mjs` | Apply bounded movement and hold cancellation. |
| `ugs_puck_map.mjs` | Control the supervised contact sequence and save measurements. |
| `extensions/ugs` | Supply the loopback API and native held-jog extension. |

The desktop shell has PCB preparation and Surface mapping workspaces, plus Camera,
Connection and Session log utilities. Mapping separates area definition, grid
planning and measurement. Movement keys work only during area definition.
Switching workspaces or opening a utility cancels a held movement. Stop remains
visible, including inside dialogs. Native Enter on inputs, buttons and disclosures
cannot become a capture or readiness shortcut.

Lit and Lucide provide local bundled UI components. Source and a pinned lockfile
are in `scripts/cnc-map-ui`; `npm run build:ui` writes the shipped browser bundle.
No build process or CDN is needed when using the app. `mapping-plan.js` is a
view-only grid preview; server validation remains authoritative.

`complete-rectangle` records only missing inferred corners after checking the
presented bounds, stationary reference and raised Z. It never moves the machine.
A completed scan requires accepted saved evidence and the height-map checksum;
`ugs-handoff.json` records import instructions, not completed UGS import.

The server binds to loopback. Browser requests require a session token and client identity.
UGS also must bind to loopback. Redirects and proxy use are rejected by the read-only client.
Reference changes invalidate captured alignment. A saved package cannot restore a physical reference.

Configuration does not extend support to other firmware or remove compatibility checks.
The UGS extension remains pinned to the supplied upstream class hashes.
