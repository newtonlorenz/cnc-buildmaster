# Operation

## Choose the task

Use **Start surface mapping** for a puck scan without cutting files. Use **Add CAM
files** for a full job. The Job guide shows the next missing preparation check and
links to its editor. Optional calculations and records live in **Workshop tools**.
**Workflow help** explains the routes and CNC terms inside the app.

For file preparation without a machine, start with `./cnc-map start --offline`.
This mode uses a separate planning store and blocks all machine actions. Reopen
its package in a configured machine workspace before capturing references.

## Job preparation

1. Add existing CAM files for one machining face.
2. Enter the stock dimensions, thickness and usable margin.
3. Assign the actual cutter and effective cutting diameter to each operation.
4. Inspect the orientation with an asymmetric feature.
5. Define two design references and a separate third point.
6. Capture their machine positions in the same uninterrupted session.
7. Inspect the alignment result and export checks.
8. Use the proposed cutting area for a surface measurement if needed.
9. Download the aligned draft while the checked teaching or completed scan session
   is still open. Review the setup sheet and native map import.
10. Select **Finish preparation in UGS** before changing Z or selecting cutting files in UGS.

Manual references produce a draft alignment only. They cannot enable a live aligned export.
The export retains source Z coordinates and spindle commands. It does not apply height compensation.
UGS remains the cutting sender. The initial machine approach needs a separate inspection.
The rectangle example is synthetic preview geometry. It is not a released machining job.

## Machine controls

WARNING: Keep the physical stop within reach. Software stop depends on the computer connection.

1. Secure the workpiece and cutter.
2. Close UGS AutoLeveler.
3. Remove the selected cutting file from UGS.
4. Stop the spindle.
5. Disconnect the offline keypad.
6. Put the puck outside the movement path.
7. Make sure that the route and Z clearance are sufficient.
8. Open Surface mapping → Define area and enable teaching.
9. Record two opposite inset corners, check the dashed corners, then select Accept remaining corners & plan grid. You can also record all four individually.

All corners need the same raised Z coordinate.
The full puck must fit on supported material at each measurement point.
Hold movement stops on release. The extension cancels an expired hold independently of the browser.
Movement keys operate only in Define area. Escape activates software stop from every workspace and dialog.

## Surface measurement

1. Select Continue to grid planning after defining the area.
2. Choose Wide, Medium or Close spacing, or enter a custom value. The preview shows all placements, including the return check.
3. Inspect the complete route, including the return to the first point.
4. Select Set up measurement.
5. Obey each contact and placement instruction.

Presets describe spacing, not accuracy for a material. Smaller spacing takes
more placements; wider spacing can miss variation. Invalid geometry stays in
Define area with the correction visible. Invalid spacing blocks preview. A new
spacing hides the previous route until reviewed again.

The current machine position must be a grid point before route preview. If it is
not, use the explicitly labelled corner-positioning button or return to Define
area. Neither corner acceptance nor grid selection moves the machine.

Each accepted placement starts two contacts, a retract and travel to the next point.
The inspector shows current and next XY, remaining measurements and elapsed time.
Ready or Enter consumes one fresh placement prompt. The last point is explicitly
labelled as the return check. Full cycle limits remain available in the disclosure.
On a phone, the placement controls appear above the map.
Do not touch the puck during movement.
A failed contact, changed reference or rejected repeat measurement stops the procedure.
The application does not retry a failed probe automatically.

Only a complete accepted grid can produce a height map.
A moved workpiece, tool change or new connection invalidates the reference.
Do not apply height compensation twice. The finished panel lets you copy the map
file path, then guides separate import, cutting-datum verification and compensation
in UGS. Copying the path does not import it or alter G54.

## Camera

1. Open Camera.
2. Select Enable camera.
3. Grant browser access to the required device.

The image stays in the browser. The application does not record or upload it.
The crosshair has no calibrated relation to the cutter.
Closing the camera utility stops the camera stream. A hidden or closed page also stops the stream.

## Workbench controls

Appearance follows the operating system. Select System, Light or Dark in the title
bar. Cmd/Ctrl+K searches navigation actions only. Map zoom and Fit change the view
without moving the CNC. Connection contains the configured puck height and feeds,
read-only diagnostics and the session report download.

## Direct copper scans

Choose **Continuous copper** before enabling the setup, or use **Use this scan
area** from an aligned PCB job. Remove the puck and connect the probe circuit to
the cutter and the same continuous copper face. The loose contact test piece must
use that circuit. The app requires observed open/contact/open before approval of
the automatic route. Every point must lie within the displayed bounded search
and the full route must clear clamps and leads. Stay at the machine during the
scan. Stop, lost contact, stale status or reference changes end the sequence.

Copper mode has zero puck height. It still uses two touches at every point and a
return-reference check. Puck mode retains its individual placement confirmations.
An exactly flat accepted map retains zero heights; use the native import bridge
for that map because the legacy XYZ loader has a flat-bounds edge case.

## Native handoff

After an accepted real scan, open an empty AutoLeveler in UGS, disable Apply to
G-code and clear any selected cutting file. Use **Import accepted map into UGS** in Surface results or the Job guide. The app checks the same UGS process, configuration and current reference,
then reads back and hashes the actual native grid. Zero native probe offsets and
zero Z surface are required for these already normalised heights. Existing native
scan travel limits are preserved. The app does not start a native scan.

The observer remains active through scan completion, draft export and native
import. Select **Finish preparation in UGS** when these steps are done. This closes
only the observer; no cut or spindle command is sent. Changing the work reference
or selecting a cutting file in UGS before that point invalidates the guarded setup. Software observation does not prove
physical continuity; an import receipt remains evidence of its readback time. Inspect material-top Z and the
final compensated toolpath in UGS; importing a map does not apply compensation.

## Results, saves and recovery

Surface results show actual numbered contacts, relative height range, repeat
spread and a separate return check. Select a contact to inspect it. Incomplete
scans remain labelled incomplete. Download the measurement report for the original
readings and provenance; this JSON report is not an importable map.

Save a job package to preserve files and preparation records. Historical cutter
observations survive reopening, but never establish a Z reference. Replacement
asks before discarding local drafts; the server also keeps a recovery package for
applied preparation records. Saved packages use atomic UTF-8 writes.

If the original browser tab is closed, open the current launcher address and use
Connection → **Recover closed tab & clear references**. Recovery requires the old
tab to have expired and all machine workers to have stopped. It keeps preparation
records, revokes the old tab and starts with no physical references. It does not
resume movement or probing. An expired server token instead requires the new
address printed by `./cnc-map status`.
