# CNC Buildmaster desktop UI

The app stays a local Python-served web app. Lit supplies reusable icons and an accessible tool-search dialog; Lucide supplies the icon set. The rest of the app retains its guarded CNC and PCB controller code. This is not an Electron wrapper or a new serial sender.

Build the shipped, offline bundle:

```sh
npm ci --prefix scripts/cnc-map-ui
npm run --prefix scripts/cnc-map-ui build
```

`src/workbench.js` builds to `../cnc-map-web/workbench.js`. The lockfile pins dependencies. No Node process, CDN or package download is needed to run the shipped app. Rebuild after component edits; the Python server explicitly allowlists the bundle.

Appearance defaults to macOS/browser settings; System, Light and Dark can be selected in the title bar. Only this visual preference is saved in localStorage. Workspace choice stays in sessionStorage. Neither storage grants motion authority.

Tool search (Cmd/Ctrl+K) navigates only. The mapping fit/zoom buttons change SVG viewBox only. Opening a utility releases held jogging. Escape always stops motion, including in dialogs; each modal has a visible Stop control. Native Enter on buttons or details summaries must not fall through to probing/capture shortcuts.

Tests run against isolated demo servers with no hardware:

```sh
node tests/smoke_workbench_desktop.mjs
node tests/smoke_mapping_efficiency.mjs
node tests/smoke_cnc_map_web.mjs
node tests/smoke_pcb_workbench.mjs
python3 -m unittest discover -s tests -p 'test_*.py'
node --test tests/test_mapping_plan.mjs
```

See root DESIGN.md for tokens and docs/ARCHITECTURE.md for component responsibilities. Browser screenshots in `output/design-review` show simulated geometry or the explicitly loaded example, never a live machine qualification.

`src/mapping-plan.js` supplies view-only grid arithmetic and spacing choices.
Its axis validation is checked against the Python planner. Final geometry,
reference continuity and scan readiness remain server-owned; UI suggestions never
move or arm the CNC. Screenshots for the faster mapping flow are in
`output/design-review/levelling`.
