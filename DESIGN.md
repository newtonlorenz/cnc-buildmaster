---
name: CNC Buildmaster operator workbench
description: A local desktop-style web workspace for CNC surface measurement and PCB preparation.
colors:
  background: "#f7f8fa"
  foreground: "#20252b"
  card: "#ffffff"
  popover: "#ffffff"
  primary: "#176d67"
  primary-foreground: "#ffffff"
  secondary: "#eef1f3"
  secondary-foreground: "#39414b"
  muted-foreground: "#606b77"
  accent: "#e8f2ef"
  accent-foreground: "#165e59"
  destructive: "#b52835"
  border: "#dce2e7"
  input: "#c5cdd5"
  ring: "#298a81"
  sidebar: "#f0f3f5"
  sidebar-foreground: "#3d4752"
  sidebar-accent: "#dfeae7"
  sidebar-accent-foreground: "#175f59"
  sidebar-border: "#d7dfe5"
  canvas: "#f4f7f7"
  stock: "#e6eeec"
  stock-line: "#90aaa5"
  warning: "#8a5a16"
  warning-soft: "#fff5df"
  danger: "#b52835"
  danger-soft: "#fff0f1"
  success: "#176d48"
  success-soft: "#edf7f0"
  isolation: "#227b73"
  drilling: "#94631c"
  outline: "#5877a4"
  background-dark: "#181c21"
  foreground-dark: "#e8edf2"
  card-dark: "#20262d"
  popover-dark: "#252c34"
  primary-dark: "#78c9bb"
  primary-foreground-dark: "#102e2b"
  secondary-dark: "#2a323b"
  secondary-foreground-dark: "#dce3e9"
  muted-foreground-dark: "#a7b2bd"
  accent-dark: "#2b413e"
  accent-foreground-dark: "#a2e0d5"
  destructive-dark: "#b93442"
  border-dark: "#35404b"
  input-dark: "#495766"
  ring-dark: "#78c9bb"
  sidebar-dark: "#1d232a"
  sidebar-foreground-dark: "#c3cdd7"
  sidebar-accent-dark: "#2b413e"
  sidebar-accent-foreground-dark: "#a2e0d5"
  sidebar-border-dark: "#35404b"
  canvas-dark: "#1a2329"
  stock-dark: "#293e3b"
  stock-line-dark: "#63857e"
  warning-dark: "#e6bb74"
  warning-soft-dark: "#3b3020"
  danger-dark: "#f48e98"
  danger-soft-dark: "#40272d"
  success-dark: "#87d5a7"
  success-soft-dark: "#263b30"
  isolation-dark: "#85cfc1"
  drilling-dark: "#e5be7e"
  outline-dark: "#8dadd8"
typography:
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "25px"
    fontWeight: 650
    lineHeight: 1.25
    letterSpacing: "-0.035em"
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "19px"
    fontWeight: 650
    lineHeight: 1.4
    letterSpacing: "-0.02em"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.45
  measurement:
    fontFamily: "\"SFMono-Regular\", Consolas, monospace"
    fontSize: "19px"
    fontWeight: 400
    lineHeight: 1.6
rounded:
  sm: "0.375rem"
  md: "0.5rem"
  lg: "0.625rem"
  xl: "0.875rem"
spacing:
  small: "8px"
  compact: "12px"
  field: "16px"
  panel: "20px"
  section: "24px"
  page: "30px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.md}"
    height: "2.25rem"
    padding: "0.5rem 1rem"
  button-primary-dark:
    backgroundColor: "{colors.primary-dark}"
    textColor: "{colors.primary-foreground-dark}"
    rounded: "{rounded.md}"
    height: "2.25rem"
    padding: "0.5rem 1rem"
  input:
    rounded: "{rounded.md}"
    height: "2.25rem"
    padding: "0.25rem 0.75rem"
  card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.xl}"
    padding: "1.5rem 0"
  sidebar-item-active:
    backgroundColor: "{colors.sidebar-accent}"
    textColor: "{colors.sidebar-accent-foreground}"
    rounded: "{rounded.md}"
    height: "40px"
    padding: "0.5rem 12px"
---

# Design System: CNC Buildmaster

## Overview

The confirmed direction is a desktop operator workbench with system appearance,
light/dark overrides and a shared shadcn foundation across the UI. Task navigation,
working geometry and nearby controls support preparation beside the machine.
This records the current implementation; it does not establish a new brand metaphor.

Tokens below come from `scripts/cnc-map-ui/src/styles.css` and installed source
components. React 19 owns one application tree; shadcn/Radix controls and AI Elements
share its theme. The frontmatter records the implemented palette and reusable
primitives; the prose explains their use.

**Review status — 20 September 2026:** source and simulation review verified.
The browser layout is reviewed with the standard 16rem sidebar. The recorded
simulation checks include dialogs, camera and mobile coverage with zero CSP
violations; see the [verification record](scripts/cnc-map-ui/README.md#verification).
This review does not qualify hardware or a physical cutting process.

**Key Characteristics:**

- System fonts and local assets.
- Semantic light/dark colours shared by controls and geometry.
- Persistent Stop and machine status, with task-specific inspectors.
- Progressive disclosure of preparation details and evidence.

## Colors

The palette combines teal actions with cool neutral surfaces. Unsuffixed tokens
record light appearance; `-dark` entries record the `.dark` overrides. Names map
to the same CSS custom properties. Use the frontmatter values; do not maintain a
second palette in component code.

### Primary

`primary` and `primary-foreground` identify main actions, selected steps and map
geometry. `accent` and `accent-foreground` provide quieter hover/selection fills.
The dark theme uses pale teal on a deep teal foreground pairing.

### Neutral

`background` frames the workspace; `card` and `popover` separate work and overlay
surfaces. `foreground` and `muted-foreground` distinguish primary text from help.
`secondary` supplies subdued containers. `border`, `input` and `ring` distinguish
structural edges, field edges and keyboard focus. Sidebar colours have their own
roles rather than borrowing text contrast from the canvas.

The stylesheet's `muted` equals `secondary`; card/popover foregrounds equal
`foreground`. Sidebar primary/ring aliases follow their matching action/focus
colours. Compatibility aliases such as `surface`, `panel`, `ink` and `line` resolve
to these same shared tokens and do not define another theme.

### Status and geometry

`destructive` styles Stop and invalid controls; the surface plot also uses it for
the labelled cutter marker. `danger`/`danger-soft` style error notices. These are
separate roles in dark mode. `warning`/`warning-soft` identify review, provisional
corners and the dashed return check. `success`/`success-soft` describe successful
software checks or connection status, not a qualified physical process.

`canvas`, `stock` and `stock-line` frame the workpiece; `isolation`, `drilling` and
`outline` distinguish cutting-path roles. The Canvas preview falls back to primary
for a role without a defined colour. Keep textual labels and geometry states
alongside colour.

## Typography

System sans-serif and monospace stacks are recorded in the frontmatter; no web
fonts are loaded. The title/headline tokens describe base `h1`/`h2`; workspace
components sometimes override them with smaller utility classes. Body text uses
the body role, with paragraph leading increased to 1.6. Field labels use the label
role. The measurement role records `.readout`; other coordinate displays use
monospace with local sizes and tabular numerals where specified.

Section titles use 14px/600, helper text 12px and sidebar group labels 11px with
0.07em tracking and uppercase. Eyebrows use 11px/600 and 0.08em tracking. Keycaps
use 11px monospace. Narrow page headings reduce to 23px. Numeric inputs use the
monospace stack; the Input primitive uses 16px text below the medium breakpoint
and 14px above it. These observed sizes are not an accessibility conformance claim.

## Layout

The shell occupies `100dvh`, with a minimum document width of 320px. The header is
65px and the status bar 36px. Workspace sections scroll inside the fixed shell.
Below 768px the header becomes 60px and the status bar becomes a 58px, two-row
layout that retains XYZ readings; navigation becomes a sheet.

The expanded sidebar uses the standard shadcn `SidebarProvider` width of `16rem`,
confirmed in the reviewed browser layout. The icon rail is `3rem`; the mobile
sheet is `18rem`. The application stylesheet does not override these widths.

| Surface | Current layout rules |
| --- | --- |
| Shared page | Maximum width 1760px; base page padding uses the page token. At widths up to 1200px padding is 24px; up to 767px it is 22px 16px; from 1500px it is 36px 40px. |
| Job guide | Flexible overview plus 320px inspector with a 24px gap; inspector is 350px from 1500px, 285px at or below 1200px. At or below 1050px it moves below the overview in two columns, then one below 768px. |
| Preparation steps | Four columns, switching to two below 768px. The current step uses the accent fill. |
| PCB preparation | Stacked below Tailwind `lg` (64rem); above it, a flexible preview/operations pane and a 280–318px inspector with independent scrolling. |
| Surface mapping | Controls precede the map below 900px. From 900px, map and 300px sticky inspector sit side by side; the inspector becomes 318px at Tailwind `xl` (80rem). |
| Utility dialogs | Width `min(700px, calc(100vw - 32px))`, maximum height `calc(100dvh - 40px)`, scroll area capped at `65dvh`. Footer Stop remains outside the scrolling body. Command search has a 580px maximum. |

The frontmatter spacing values describe reused component gaps/padding, not a
uniform grid imposed on every view. Revalidate breakpoint interactions when
changing layout or theme behaviour.

## Elevation & Depth

Borders and tonal layers separate work areas. The base Card uses Tailwind's small
shadow; workbench panels replace it with `0 1px 2px #00000003`. Next-step Plan and
operation Queue overrides remove shadows. Dialogs and sheets use Tailwind's large
shadow. Active sidebar items use an inset 2px primary edge. Exact shadow values
are recorded in the sidecar, including the installed Tailwind defaults.

Controls use the inherited Tailwind transition defaults; sidebar geometry changes
use 200ms linear transitions. The reduced-motion rule disables animations and
transitions and returns scrolling to auto. Source animation class names alone do
not establish that an animation runs in the built app.

## Shapes

The base radius is `--radius:0.625rem`. The frontmatter records the resolved
small/medium/large/extra-large scale; at a 16px root those are 6/8/10/14px.
Buttons and inputs use medium; dialogs, mapping containers and preparation steps
use large; base Cards and their workbench wrappers retain extra-large. Badges and
coordinate markers use fully rounded shapes. Use the installed Lucide React
components and their local size overrides rather than the removed icon element.

## Components

### Shared foundation

`components/ui/` contains the shadcn source primitives; `components/workbench-controls.tsx`
composes Field, NumberField, SelectField, CheckField, Panel, Notice and StopButton.
The same foundation is used by the shell, all workspaces, utility dialogs and
preparation tools. Details of state and transport belong in [Architecture](docs/ARCHITECTURE.md).

### Buttons

Default Button size and primary colours are in the frontmatter. A direct icon
child reduces horizontal padding to 0.75rem. Sizes include extra-small, small,
large and icon variants. Primary hover uses 90% primary; secondary hover uses 80%
secondary. Outline and ghost variants use accent hover, with explicit dark-mode
input/accent treatments. Link uses primary text and hover underline.

Focus uses a three-pixel half-opacity ring; disabled controls use half opacity and
ignore pointer input. Destructive controls have their own ring colours and a 60%
destructive fill in dark mode. Stop adds a square icon, Esc hint, stronger weight
and minimum width; it remains a request to the shared client.

### Chips

Badge is a fully rounded label with default, secondary, destructive, outline,
ghost and link variants. Operation labels can be more compact than the base Badge.
They describe state or cutter changes and do not release a cutting operation.

### Cards / Containers

The base Card uses the frontmatter radius and padding, border and card surface.
Panel removes the base outer gap/padding, then gives its header 19px 20px and
content 0 20px 20px. The next-action Plan uses the base radius with a secondary
footer; it is not a separate theme.

### Inputs / Fields

Input is a bordered, transparent field in light mode and uses input colour at 30%
opacity in dark mode. Dimensions are in the frontmatter. Focus changes the border
and adds the shared ring; invalid state uses destructive treatment. Labels, help,
checkboxes and native selects are composed through the workbench wrappers.

### Navigation

The collapsible Sidebar groups workspaces and utilities. Expanded rows use the
frontmatter height; active rows use sidebar accent colours and the inset edge.
The mobile Sheet includes its own Stop. Command search navigates only. Radix
Dialog, DropdownMenu, Tabs, Collapsible, Tooltip and ScrollArea provide the shared
interaction structure. Follow System appearance by default.

### Job guide and geometry

AI Elements Plan, Task and Queue are local source components in the same React
root: the next action, supporting disclosures and ordered cutting operations.
Their names do not imply an AI service or generated machine instructions.

SurfacePlot uses SVG for corners, draft points, the accepted route, next placement
and return check. ToolpathPreview uses Canvas for path projections with a separate
live XY overlay. Keep source work Z and machine Z distinct. A suggested rectangle,
preview grid or selected operation is not measurement or cutting authority.

## Do's and Don'ts

### Do:

- Do use the shared shadcn primitives and workbench wrappers across every workspace.
- Do use both theme values for a semantic colour and recheck Canvas/SVG output after appearance changes.
- Do keep Stop visible in modal utilities and mobile navigation, and retain the surface inspector Stop.
- Do preserve native keyboard interaction and visible focus; movement shortcuts belong only to the enabled surface view.
- Do distinguish typed coordinates, current machine readings, accepted measurements and native UGS import receipts.
- Do validate future layout and theme changes in desktop and narrow viewports, including focus, scrolling, Stop visibility and CSP behaviour.

### Don't:

- Don't restore an armed state or physical reference from a presentation preference.
- Don't use selection, success colour or a completed preparation step as proof of physical qualification.
- Don't add another React root, global controller bridge or isolated theme for the Job guide.
- Don't loosen CSP or add remote font, icon or stylesheet dependencies.
- Don't treat source inspection as a browser check or simulation review as physical qualification.

## Task-first workflow refinement — 20 September 2026

The start view now separates surface-only measurement from cutting-job preparation.
It does not show empty operation queues or process forms before the task is chosen.
Offline preparation gives the file route precedence. The loaded Job guide pairs
geometry with actionable checks; process settings are a disclosure. At compact
and mobile widths, the next-action panel precedes the overview.

Workshop tools is a separate workspace, mounted on first use. Surface results use
numbered contact tiles with readable values and a separate return record; colour
is supplementary. Native import and finish controls share one implementation
between the result view and job guide. Errors provide a plain-language recovery
step and disclose technical detail. Workflow help is available from navigation
and command search. System, Light and Dark appearance remain shared throughout.
