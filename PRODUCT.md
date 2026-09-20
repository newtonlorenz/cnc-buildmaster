# Product

<!-- impeccable:product-schema 1 -->

Confirmed context recorded on 20 September 2026 from the operator's brief. Current
implementation details are documented separately in [Architecture](docs/ARCHITECTURE.md)
and [Design](DESIGN.md).

## Platform

web

The application runs in a browser served by a local Python process. The requested
desktop appearance follows the Mac's system appearance, with Light and Dark
overrides.

## Users

The confirmed user is the operator at a Genmitsu 3018-PRO, preparing PCB work and
performing supervised surface measurement. Controls and measurements must be
usable beside the machine while the operator positions a movable probe puck.

## Product Purpose

CNC Buildmaster supports rapid puck-assisted levelling and PCB job preparation.
The operator needs to inspect existing cutting paths, set stock and placement,
check alignment, plan surface measurements and prepare the handoff to UGS.
"Rapid" describes the requested workflow goal; no speed or accuracy benchmark
has been established by this document.

## Operating Context

The workflow complements KiCad for board design, EasyTrace5000 for PCB CAM and
UGS for machine connection, compensation review and cutting-job delivery. UGS
remains the sole serial owner. Buildmaster's supervised positioning and probing
actions use the guarded UGS integration.

The operator's measured puck height is 14 mm. This is installation-specific
context, not a portable default or evidence of a current work zero. Puck height,
feeds, travel constraints and UGS connection details must come from the validated
configuration for the installation.

## Capabilities and Constraints

- Prepare existing CAM files, stock, placement, alignment references and ordered
  operations; retain the distinction between typed drafts and captured references.
- Define a surface area, review a grid and supervise measurement. A movable puck
  requires operator placement; supported continuous-copper measurement has a
  separate contact procedure.
- Keep preparation tools, camera preview and machine controls clearly identified.
- Do not stream cutting jobs or generate PCB isolation CAM from Gerber files.
  Offline draft preparation does not authorise cutting.
- Keep accepted measurement evidence, native UGS import, material-top Z,
  compensation review and physical qualification as separate states.
- Simulation demonstrates software behaviour without machine access. It does not
  establish physical clearance, probing accuracy, cutting quality or unattended
  operation.

## Product Principles

- Let users start surface measurement without creating a cutting job.
- Let users prepare real CAM files offline without a machine configuration.
- Make the next preparation or measurement action clear to the operator.
- Keep optional workshop tools separate from the everyday preparation flow.
- Preserve the existing KiCad → EasyTrace5000 → UGS workflow.
- Make machine-specific values explicit and configurable.
- Keep saved planning records separate from fresh machine references and authority.

## Evidence on Hand

Source and simulation review are verified as of 20 September 2026; see the
[verification record](scripts/cnc-map-ui/README.md#verification) for the reported
browser and automated-check results. This documentation update involved no live
install, restart, machine connection or hardware action. Physical qualification
remains a separate operator-evidenced gate.
