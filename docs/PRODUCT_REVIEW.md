# Product and workflow review — 20 September 2026

## Intended role

Buildmaster is the preparation workbench between CAM and UGS. Its main advantage
is making supervised surface measurement and workpiece preparation easier to
understand. A user with a movable puck should not need to create a PCB job first.
A user inspecting CAM files should not need a connected machine first.

The intended journeys are:

1. **Measure a surface:** choose a contact method → establish the setup → teach
   the usable area → choose spacing → measure → inspect the result → hand over.
2. **Prepare a PCB or other cutting job:** load CAM → set stock and cutters →
   inspect orientation and placement → capture and check references → measure the
   cutting area → export aligned drafts and import the map → continue in UGS.
3. **Prepare away from the machine:** open real files → inspect and save planning
   records → reopen in a configured machine workspace with fresh references.
4. **Use an optional workshop tool:** choose the relevant calculation or record
   without putting every advanced form in the everyday workflow.

## Division of responsibility

UGS already supplies controller connections, machine actions, job sending,
visualisation, overrides, editing and coordinate transforms. These are described
in the [official usage guide](https://github.com/winder/Universal-G-Code-Sender/wiki/Usage)
and [official feature overview](https://winder.github.io/ugs_website/), checked
20 September 2026. The pinned native AutoLeveler integration is documented in
[the extension contract](../extensions/ugs/SURFACE_HANDOFF.md).

Buildmaster therefore keeps UGS as the sole serial owner and cutting sender.
The implementation concentrates on supervised puck placement, a linked job setup,
clear measurement evidence, and explicit handoff. It does not add a competing
serial console, Gerber isolation CAM, arbitrary machine-command entry, or an
automatic start-cut control.

## Review and implemented changes

| Area | Problem found | Implemented response |
| --- | --- | --- |
| First use | The initial view expected files and exposed technical process fields before the user chose a task. | Separate surface-only and cutting-job entry routes; recent jobs; a visible explanation of where UGS fits. |
| Disconnected preparation | Real file preparation required a machine configuration or simulation. | Explicit `--offline` mode with a separate planning store, real job packages and no machine access. |
| Main job workflow | Missing checks were spread across panels; many disabled actions needed explanation. | Actionable preparation checklist, a next-action panel and contextual explanations. Compact layouts place the next action first. |
| Advanced tools | Fixture, tool-change, recipe, camera and wood forms crowded the main guide. | A separate Workshop tools workspace, mounted on first use and retained across navigation. |
| Surface results | A point list and file path did not make the measured shape easy to understand. | Numbered contact heatmap, relative range, repeat spread, separate return drift, point inspection and an evidence report. Missing readings are not interpolated. |
| Surface-only handoff | Native import required navigating to the job guide. | Shared explicit import and finish controls in the surface result and job guide. |
| Completed-job export | A completed scan disabled the teaching-only draft export. | The observer stays active through completion. A guarded completed-session export precedes explicit handoff closure. |
| Stale map authority | Returning to identical geometry or reopening a package could match an old fingerprint. | Monotonic setup epochs, alignment validity and irreversible invalidation of the previous linked plan/map. Geometry equality cannot restore authority. |
| Export limits | Fixed feed/spindle ceilings ignored the configured machine and vertical/mixed-axis movement. | Server-sourced limits checked against emitted paths, including transformed axis rates and arc/helix peaks. |
| Clamp inspection | A supplied tool envelope could be smaller than a recorded cutter. | Reject undersized envelopes and allow explicit per-operation envelopes for differing cutters. |
| Job replacement | Local drafts could disappear when a job or example replaced them. | Explicit replacement confirmation and unload protection; applied preparation-only records receive recovery saves too. |
| Save/reopen | Unicode packages could exceed their own loader limit; failed writes left selectable corrupt files. | Compact UTF-8, a consistent package limit and atomic publication of complete files. |
| Recorded observations | Clearing physical references also erased historical tool notes. | Notes survive by validated source identity while retaining an explicitly historical, non-authoritative status. |
| Draft generation | High machine capabilities rejected otherwise conservative requested feeds. | Validate machine capabilities separately and apply conservative ceilings to requested parameters. |
| Lost browser ownership | Closing the original tab could permanently lock a valid local token out. | Explicit recovery after expiry and worker shutdown, with old-owner revocation, a new session and cleared physical references. No automatic takeover. |
| Errors and help | Raw connection errors and unexplained CNC terms made recovery difficult. | Plain-language guidance, technical disclosures, workflow help and coordinate explanations. Errors remain visible within utility dialogs. |
| Heartbeat responsiveness | A large geometry preview could delay the browser heartbeat and contend with the server status lock. | Independent status polling and a lock-independent revision snapshot keep the machine lease separate from job preview work. |
| Surface draft state | Editing spacing and returning to the approved value left an inaccessible dirty draft after measurement. | Dirty state compares the actual spacing to the accepted plan; unapplied corner edits have an explicit discard action and cannot enter measurement. |
| Handoff evidence | Preparation, native import, Z zero and compensation could be confused. | Ordered export → import → Finish preparation → set Z/load files instructions and a downloadable setup sheet; actual native receipts remain distinct from physical continuity, Z and selected-file compensation. |

## What a result means

- A **planning record** is editable saved information, not a physical reference.
- **Captured alignment** is tied to the current setup and independent check point.
- **Accepted measurements** include the completed contact and return procedure.
- **Native import readback** establishes that the imported grid matched at that
  moment. It does not verify material Z or compensation of a cutting file.
- **Finish preparation in UGS** closes Buildmaster's reference observer so file
  selection and compensation review can continue in UGS. It does not start a
  spindle, send a file, or declare a cut ready.
- **Set up another map** retires the completed observer and discards the current
  reference state. Saved files remain on disk.

## Verification and release boundary

The review uses source inspection, isolated simulation/offline browser journeys,
Python/JavaScript checks, and the pinned Java native-scanner/fake-controller
harnesses. See the [verification record](../scripts/cnc-map-ui/README.md#verification)
for the completed run. Offline browser persistence uses disposable storage.
No real machine was moved, no serial connection changed and no live UGS extension
was installed during this review.

This is a more complete tested software workflow, not a claim of a mass-market
hardware-qualified release. The remaining release gates are concrete:

- Verify the extension's live NetBeans instance discovery and readback on the
  supported UGS build in an authorised commissioning session.
- Exercise the complete supervised puck and copper workflows on the actual
  machine, then inspect and qualify a physical coupon and tool-change procedure.
- Package and test installation/update/recovery on clean supported machines.
  Windows/Linux process identity and installation support remain separate work.
- Conduct observed first-use sessions with hobbyists and experienced operators;
  current usability evidence is browser inspection, not user research.

A larger catalogue of machine controls or calculators would not close these
release gates. The documented workflow and explicit evidence boundaries should
remain the basis for future features.


## Agent companion follow-up — 20 September 2026

The structured agent interface and CLI/MCP guide are in [docs/AGENTS.md](AGENTS.md).
Digital editing requires an explicit preparation grant and pauses local editors.
Machine actions stay in an expiring operator-review queue with session, revision
and position checks. Agent polling neither owns nor renews the browser lease.
Stop revokes access, rejects queued requests and marks in-flight outcomes as
interrupted. Deterministic tests cover Stop versus access, stale session changes,
concurrent approval and subprocess timeouts. CLI and both MCP protocol generations
are tested, including a complete import/save against a disposable offline app.
