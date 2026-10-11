# Passive UGS run diagnostics

Run on the UGS host with `CNC_BUILDMASTER_CONFIG` set to the existing,
completed machine profile (the same environment used by the configured launcher).
Missing or example configurations are rejected before a connection is opened:

```sh
node scripts/ugs_run_diagnostics.mjs --seconds 10
```

This read-only observer listens to the configured loopback WebSocket. It sends
no machine command and never requests start, stop, reset or resume. It requires
three consecutive fresh HOLD/IDLE controller reports, zero reported feed and
stable machine/work XYZ over at least 500 ms. Cached HTTP snapshots and a
successful pause response are not stop evidence. Connection loss, stale reports,
unknown positions or intervening commands leave the result unverified.

`controllerStationaryVerified` concerns reported translation only.
`spindleReportedOff` is separate: HOLD may leave the spindle running, and a
missing spindle value or direction flag remains unknown. Zero reported speed
can coexist with an active spindle accessory. An off result requires zero speed
and explicit CW/CCW-off reports. UGS 2.1.26 exposes only CW in its accessory
record, so that version cannot establish both directions off through this
interface; the diagnostic conservatively reports unknown. The separate
`spindleSpeedReportedZero`, `spindleCWReported` and `spindleCCWReported` fields
show the available evidence without hiding that limitation. Neither establishes physical stop.
Exit 0 means stationary controller reports and reported spindle off; exit 2
means unverified (including stationary reports with unknown spindle state);
exit 1 means invalid configuration or invocation.

Optionally inspect comment events against an exact, independently selected source:

```sh
node scripts/ugs_run_diagnostics.mjs --seconds 10 --source fixture.nc --sha256 <64-character-sha256>
```

An empty processed command is recognised only when its original text exactly
matches a comment-only line in that hash-checked source. Executable lines,
unknown comments, malformed comments and control characters are rejected.
The observer reports comment counts; it does not establish that UGS currently
has this source selected, validate executable toolpaths or release a cutting job.

The pure exports can be used by a separately authorised run monitor. That caller
must pin the selected source, preserve event continuity and handle its own bounded
stop request. Do not interpret an acknowledgement as completed stopping.

Offline regression check (fake socket; no UGS access):

```sh
node --test tests/test_ugs_run_diagnostics.mjs
```
