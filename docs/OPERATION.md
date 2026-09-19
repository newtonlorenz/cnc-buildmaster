# Operation

## Job preparation

1. Add existing CAM files for one machining face.
2. Enter the stock dimensions, thickness and usable margin.
3. Assign the actual cutter and effective cutting diameter to each operation.
4. Inspect the orientation with an asymmetric feature.
5. Define two design references and a separate third point.
6. Capture their machine positions in the same uninterrupted session.
7. Inspect the alignment result and export checks.
8. Download the aligned draft.

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
8. Enable teaching in Machine controls.
9. Position the cutter and record the four named corners.

All corners need the same raised Z coordinate.
The full puck must fit on supported material at each measurement point.
Hold movement stops on release. The extension cancels an expired hold independently of the browser.
Movement keys operate only in Machine controls. Escape activates software stop from every tool.

## Surface measurement

1. Open Surface measurement.
2. Enter the grid spacing.
3. Inspect the complete route, including the return to the first point.
4. Select Set up measurement.
5. Obey each contact and placement instruction.

Each accepted placement starts two contacts, a retract and travel to the next point.
Do not touch the puck during movement.
A failed contact, changed reference or rejected repeat measurement stops the procedure.
The application does not retry a failed probe automatically.

Only a complete accepted grid can produce a height map.
A moved workpiece, tool change or new connection invalidates the reference.
Do not apply height compensation twice.

## Camera

1. Open Camera.
2. Select Enable camera.
3. Grant browser access to the required device.

The image stays in the browser. The application does not record or upload it.
The crosshair has no calibrated relation to the cutter.
A change to another tool panel stops the camera stream. A hidden or closed page also stops the stream.
