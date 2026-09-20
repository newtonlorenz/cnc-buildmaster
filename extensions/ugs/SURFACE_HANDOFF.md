# Surface handoff protocol 1 (UGS 2.1.26 only)

This is source implementation, not an installed/live-verified extension. No CNC
command, connection, coordinate change, file selection, or compensation apply is
part of this API.

Endpoints below are relative to `/api/v1/surfaceMap`:

- GET `capabilities`: supported protocol and current native dependency state.
- GET `status`: freshly inspect the existing, open native AutoLeveler, settings,
  scanner grid, processor registration, and selected/processed file identities.
- POST `verify`: validate an immutable explicit payload and compare to native state.
- POST `import`: load the map into the existing native scanner with compensation
  disabled, no selected file, no existing measured points, and no active scan.
  Native state is read back before success. Repeating an identical import is safe.

POST body (no extra keys):

```json
{"protocol":1,"mapId":"example-map-01","mode":"relative","units":"MM",
 "x":[0,10],"y":[0,10],"relativeZ":[[0,0.01],[0.02,0.03]],
 "sha256":"<digest>","expectedSelectedFile":null}
```

X/Y are coordinates in the intended work coordinate system, not machine XY.
Transform from the accepted scan reference before hashing; do not infer it from
persisted coordinates. `relativeZ[y][x]` is the material surface delta in millimetres, already corrected
for the measuring puck. A datum sample must be exactly zero. This endpoint sets
native Z surface and native probe offsets to zero; it never sets a work offset.
Use the Python `make_payload` helper to compute the digest. The digest is SHA-256
of ASCII `CNC-BUILDMASTER-SURFACE-V1\0MM\0relative\0`, big-endian uint32 X/Y
lengths, then IEEE-754 big-endian float64 X axis, Y axis, and Z in row-major order.
Negative zero is encoded as positive zero. IDs are labels, never evidence.

Axes must describe UGS's single-resolution grid: increasing regular spacing,
with the same step for both axes (a shorter last interval is accepted). At most
10,000 points; XY absolute value <= 10,000 mm; relative Z absolute value <= 100 mm.
These are input limits, not machine travel or process qualification. The native
scan Z range is preserved and must already be finite with MinZ < MaxZ. Native
floating-point grid construction is matched within 0.0000001 mm and stored with
the exact explicit X/Y values; heights are never resampled. The native resolution
may differ by one floating-point step to avoid an extra endpoint from `ceil`.

A successful verify/import returns `ok`, `available`, `verified`, and `imported`
as true, plus the request `mapId` and a fresh `native` object. Status places all
inspection fields in `native`; it does not retain a Buildmaster map ID. Use
`native.nativeMapSha256`, `mapComplete`, `mode`, `units`, `zSurface`,
`probeOffsets`, `probeOffsetUnits`, `applyToGcode`, `meshProcessorCount`,
`selectedFile`, `processedFile`, `scanning`, and `compensationApplied`.
`meshProcessors` describes the actual registered meshes and Z references, with
no claim that a processed file contains those changes. Complete maps outside this
relative-grid contract are reported with `mapInspection` set to
`outside_relative_handoff_contract` and no handoff hash.

Invalid payloads return HTTP 400; native state conflicts or missing dependencies
return HTTP 409 for import/verify. GET status/capabilities return structured
`available:false` and `missingDependency` on unavailable native inspection.
Missing/old endpoint detection is `extension_missing` in the Python client.
The client requires the existing identity guard, refuses redirects/proxies and
recomputes the readback digest from actual returned grid values.

## Parent integration requirements

The parent owns HTTP/UI wiring and `scripts/ugs_loopback_setup.py`. The startup
guard calls `check_surface_stock(APP)` from `check_stock()` to validate **every**
entry in `surface-stock-hashes.json`; missing pins fail closed. The file includes native/core class hashes and
module manifests. Retain all existing pendant and held-jog checks. The bridge's
`check_surface_stock(app)` provides a read-only checker. A reviewed rebuild and
separately authorised restart are still necessary. Do not alter the installed
extension, UGS preferences, cache, or process as part of this implementation.

The SurfaceScanner module exports no public packages. UGSLib has a dependency on
`org.openide.windows`, but not SurfaceScanner; adding a reverse dependency would
create a cycle. This implementation discovers an **already open** AutoLeveler via
TopComponent's registry and uses narrowly scoped, pinned reflection on its actual
instances. It does not instantiate a duplicate scanner as an imported map, open
windows, change module dependencies, or claim availability if inspection fails.
The build remains a UGSLib patch, with no new compile-time platform dependency.

The parent must derive payloads from accepted saved measurement evidence. Never
accept a browser-supplied `imported`, `applied`, or hash as proof. Refresh native
status/verify after importing; reject stale/mismatched hash, changed settings,
selected file, or missing dependency. Import requires a separate explicit action.
Keep the existing loopback process/listener/extension identity checks before any
request. This protocol is not authentication for arbitrary local processes.

`compensationApplied` is deliberately null if a native mesh processor is present:
processor registration, checkbox state, and existence of a processed file do not
prove that the current file was successfully compensated. There is no apply
endpoint and no readiness-to-cut claim. Selected files block import and verify.

## Upstream evidence

Inspected upstream revision `ded15ddc4e5aaa1d20f87807aae7fcfc73e71319`
(release `v2.1.26`) and the installed macOS 2.1.26 class files, 19 September 2026:

- [SurfaceScanner](https://github.com/winder/Universal-G-Code-Sender/blob/ded15ddc4e5aaa1d20f87807aae7fcfc73e71319/ugs-platform/ugs-platform-surfacescanner/src/main/java/com/willwinder/ugs/platform/surfacescanner/SurfaceScanner.java): `update/reset/probeEvent`, column-major native grid, zigzag pending points, additive probe offsets, and nonzero Z range required by `update`.
- [AutoLevelerTopComponent](https://github.com/winder/Universal-G-Code-Sender/blob/ded15ddc4e5aaa1d20f87807aae7fcfc73e71319/ugs-platform/ugs-platform-surfacescanner/src/main/java/com/willwinder/ugs/platform/surfacescanner/AutoLevelerTopComponent.java): scanner/manager lifetime and listener-driven processing.
- [MeshLevelManager](https://github.com/winder/Universal-G-Code-Sender/blob/ded15ddc4e5aaa1d20f87807aae7fcfc73e71319/ugs-platform/ugs-platform-surfacescanner/src/main/java/com/willwinder/ugs/platform/surfacescanner/MeshLevelManager.java): update catches errors; no reliable success return.
- [GUIBackend](https://github.com/winder/Universal-G-Code-Sender/blob/ded15ddc4e5aaa1d20f87807aae7fcfc73e71319/ugs-core/src/com/willwinder/universalgcodesender/model/GUIBackend.java): native processor collection, file reprocessing, and processor reset on file selection.
- [AutoLevelSettings](https://github.com/winder/Universal-G-Code-Sender/blob/ded15ddc4e5aaa1d20f87807aae7fcfc73e71319/ugs-core/src/com/willwinder/universalgcodesender/utils/AutoLevelSettings.java): Z surface, probe offsets, settings notifications; `apply` equality excludes applyToGcode.

Offline tests must use the pinned installed classes. No live installation or
hardware is needed. Rollback restores scanner and settings fields; a rollback
failure latches the resource closed for further imports. A later UI preview
refresh may be required after a failed import, but compensation stays disabled.

## Offline verification

`JAVA_HOME=/path/to/jdk17 python3 -m unittest discover -s tests -p 'test_ugs_*.py' -v`
compiles all extension sources against the existing builder's classpath, checks
the stock pins, and tests actual native scanner/manager/mesh classes with a fake
backend. Cases cover numeric/JSON spoofing, NaN/infinity/bounds, hashes, fractional
axes, native setting/grid changes, selected files, missing dependencies, error
rollback, and source/module-manifest mismatch. The existing held-jog regression
also runs. This does not validate discovery in a running NetBeans instance or a
physical reference; an authorised rebuild/restart and read-only runtime check
remain separate gates.
