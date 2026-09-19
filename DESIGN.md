---
name: CNC Buildmaster operator workbench
description: A compact desktop-style workspace for CNC surface mapping and PCB preparation.
colors:
  primary: "#07755f"
  primary-dark: "#65d6b5"
  background: "#f1f3f4"
  surface: "#ffffff"
  ink: "#202830"
  muted: "#596875"
  border: "#dce1e5"
  background-dark: "#15191e"
  surface-dark: "#1d2228"
  ink-dark: "#e4eaf0"
  muted-dark: "#acbac6"
  stop: "#bd292f"
  warning: "#805511"
typography:
  title:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "17px"
    fontWeight: 650
    letterSpacing: "-0.02em"
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "13px"
  measurement:
    fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace'
    fontSize: "19px"
    fontWeight: 500
rounded:
  control: "6px"
  panel: "8px"
  dialog: "10px"
spacing:
  small: "8px"
  panel: "16px"
  workspace: "20px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
    height: "35px"
---

# CNC Buildmaster design system

## Overview

Scope: the local CNC Buildmaster web app, not board documentation or hardware markings.
A professional operator workstation: task navigation, central geometry and a compact inspector. Appearance follows the operating system, with light/dark overrides. This is a functional app, with no marketing hero, fabricated job state or decorative dashboard metrics.

## Colors

CSS custom properties in `scripts/cnc-map-web/style.css` are the implementation source. Teal identifies selection and primary actions; red is reserved for Stop/failure, amber for provisional geometry and review. Canvas and toolpath colours adapt to appearance too. Do not use green to imply physical qualification.

## Typography

System UI type for controls; tabular monospace only for coordinates and numeric values. Functional text is at least 11px. Compact heading hierarchy is deliberate in this task-dense app. Instructions belong close to their action or in named help disclosures.

## Layout

58px header, 30px status bar. Desktop: 176px navigation, flexible workspace and 318px independently scrolling inspector. At 721–1150px the navigation becomes a labelled-accessibility icon rail and inspector narrows to 282px. At 720px and below, panels stack and normal document scrolling returns; the fixed status bar grows to 54px to keep XYZ visible beside the jog controls. Stop stays visible. Mapping is the first-run default; the selected workspace persists per browser session.

## Elevation & Depth

Panels use borders and tonal layers. Native dialogs and the command search use restrained shadows. Utilities must provide their own Stop control while modal focus makes the header inert.

## Shapes

6px controls, 8px workspace containers, 10px dialogs. Lucide icons share a 1.7px stroke. Actual geometry, grids and toolpaths provide the graphics; no illustrative machine imagery.

## Components

Lit implements `surface-icon` and `surface-command-menu`; a small bundled shell handles themes, utility dialogs and view-only fit/zoom. The existing guarded controller owns all machine actions. Use native inputs, selects, details and dialogs where appropriate. Theme choice persists locally, defaults to the OS and reacts to OS changes only in System mode. All assets are local.

Mapping uses separate Define area and Plan grid views. Two opposite corners can
explicitly confirm the inferred rectangle in one action. Geometry presets disclose
spacing and placement count without implying material accuracy. Only the current
spacing's route is shown; draft dots do not imply an authorised scan. The placement
inspector emphasises current XY, next point and one fresh Ready action, with full
cycle details available. On mobile, planning and placement controls precede the
map. Saved-map handoff keeps import, datum verification and compensation distinct.

## Do's and Don'ts

- Keep Stop available in every dialog and preserve Escape as Stop.
- Preserve native Enter behaviour on buttons, links, disclosures and inputs. Search keys must not become jog or probe readiness events.
- Keep inserted coordinates distinct from live machine readouts.
- Never restore an armed state, old reference or machine permission from a UI preference.
- Respect reduced-motion settings; no decorative animation or external asset dependency.
