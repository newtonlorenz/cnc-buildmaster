// SPDX-License-Identifier: GPL-3.0-or-later
package com.willwinder.universalgcodesender.pendantui.v1.resources;

import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.databind.*;
import com.willwinder.universalgcodesender.model.*;
import com.willwinder.universalgcodesender.model.UnitUtils.Units;
import com.willwinder.universalgcodesender.utils.AutoLevelSettings;
import jakarta.ws.rs.*;
import jakarta.ws.rs.core.Response;
import java.io.*;
import java.io.File;
import java.lang.reflect.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.Callable;
import java.util.concurrent.atomic.AtomicBoolean;
import javax.swing.SwingUtilities;

/** Pinned UGS 2.1.26 native map readback/import. Never sends machine commands. */
@Path("surfaceMap") @Produces("application/json")
public final class SurfaceMapResource {
    private final BackendAPI backend;
    @FunctionalInterface interface Access { Native get() throws Exception; }
    private final Access access;
    private boolean poisoned;
    private static final String SCANNER = "com.willwinder.ugs.platform.surfacescanner.SurfaceScanner";
    private static final String COMPONENT = "com.willwinder.ugs.platform.surfacescanner.AutoLevelerTopComponent";
    private static final String MESH = "com.willwinder.universalgcodesender.gcode.processors.MeshLeveler";
    private static final ObjectMapper JSON = new ObjectMapper()
            .enable(JsonParser.Feature.STRICT_DUPLICATE_DETECTION)
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS);

    public SurfaceMapResource(BackendAPI backend) { this.backend = backend; this.access = this::discover; }
    SurfaceMapResource(BackendAPI backend, Access access) { this.backend = backend; this.access = access; }
    static void require(boolean ok, String message) { if (!ok) throw new IllegalArgumentException(message); }
    static Object field(Object object, String name) throws Exception { return slot(object, name).get(object); }
    static Field slot(Object object, String name) throws Exception {
        for (Class<?> c = object.getClass(); c != null; c = c.getSuperclass()) {
            try { Field f = c.getDeclaredField(name); f.setAccessible(true); return f; }
            catch (NoSuchFieldException ignored) { }
        }
        throw new NoSuchFieldException(name);
    }
    static Object invoke(Object object, String method, Class<?>[] types, Object... args) throws Exception {
        try { return object.getClass().getMethod(method, types).invoke(object, args); }
        catch (InvocationTargetException e) {
            if (e.getCause() instanceof Exception cause) throw cause;
            throw e;
        }
    }
    private static <T> T edt(Callable<T> action) throws Exception {
        if (SwingUtilities.isEventDispatchThread()) return action.call();
        java.util.concurrent.FutureTask<T> task = new java.util.concurrent.FutureTask<>(action);
        SwingUtilities.invokeAndWait(task);
        return task.get();
    }
    static Map<String,Object> base() {
        Map<String,Object> r = new LinkedHashMap<>();
        r.put("protocol", 1); r.put("supportedVersion", "2.1.26"); return r;
    }
    static Map<String,Object> failure(String code) {
        Map<String,Object> r = base(); r.put("ok", false); r.put("available", false);
        r.put("code", code); r.put("verified", false); r.put("imported", false);
        r.put("compensationApplied", null); return r;
    }

    @GET @Path("capabilities") public Map<String,Object> capabilities() {
        Map<String,Object> r = status();
        r.put("importSupported", true); r.put("applySupported", false); r.put("motionSupported", false);
        r.put("requiresOpenAutoLeveler", true); r.put("requiresNoSelectedFile", true);
        r.put("requiresCompensationDisabled", true); r.put("requiresEmptyNativeMap", true);
        return r;
    }
    @GET @Path("status") public Map<String,Object> status() {
        try {
            return edt(() -> { Native n = access.get(); Map<String,Object> r = base();
                r.put("ok", true); r.put("available", true); r.put("native", n.read());
                r.put("importBlocked", poisoned); return r; });
        } catch (Exception | LinkageError e) {
            Map<String,Object> r = failure("native_dependency_unavailable");
            r.put("missingDependency", rootMessage(e)); return r;
        }
    }
    @POST @Path("verify") @Consumes("application/json") public Response verify(String body) { return operation(body, false); }
    @POST @Path("import") @Consumes("application/json") public Response importMap(String body) { return operation(body, true); }
    private Response operation(String body, boolean write) {
        final Grid grid;
        try { grid = Grid.parse(body); }
        catch (Exception e) { return Response.status(400).entity(failure("invalid_map: " + rootMessage(e))).build(); }
        try {
            Map<String,Object> response = edt(() -> {
                require(!poisoned, "rollback_failed_restart_review_required");
                Native n = access.get();
                n.safe();
                Map<String,Object> verifiedState = n.read();
                if (!grid.matches(verifiedState)) {
                    require(write, "native_map_mismatch");
                    require(!n.hasMeasuredPoints(), "native_map_not_empty");
                    Snapshot backup = new Snapshot(n.scanner, n.settings);
                    try {
                        n.load(grid);
                        n.safe();
                        verifiedState = n.read();
                        require(grid.matches(verifiedState), "native_readback_mismatch");
                    } catch (Throwable failure) {
                        try { backup.restore(); }
                        catch (Throwable restoreFailure) { poisoned = true; failure.addSuppressed(restoreFailure); }
                        if (failure instanceof Exception e) throw e;
                        if (failure instanceof Error e) throw e;
                        throw new IllegalStateException(failure);
                    }
                }
                Map<String,Object> result = base(); result.put("ok", true); result.put("available", true);
                result.put("verified", true); result.put("imported", true);
                result.put("mapId", grid.id); result.put("native", verifiedState);
                return result;
            });
            return Response.ok(response).build();
        } catch (Exception | LinkageError e) {
            Map<String,Object> r = failure("native_handoff_refused"); r.put("reason", rootMessage(e));
            r.put("rollbackFailed", poisoned); return Response.status(409).entity(r).build();
        }
    }
    private static String rootMessage(Throwable e) {
        while (e.getCause() != null) e = e.getCause();
        return e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
    }

    private Native discover() throws Exception {
        // Only existing open instances: no findTopComponent/open/constructor side effects.
        Class<?> tc = Class.forName("org.openide.windows.TopComponent");
        Object registry = tc.getMethod("getRegistry").invoke(null);
        Class<?> registryType = Class.forName("org.openide.windows.TopComponent$Registry");
        Set<?> opened = (Set<?>) registryType.getMethod("getOpened").invoke(registry);
        Object component = null;
        for (Object candidate : opened) if (candidate.getClass().getName().equals(COMPONENT)) {
            require(component == null, "multiple_native_autolevelers"); component = candidate;
        }
        require(component != null, "open_native_AutoLeveler_required");
        SurfacePins.check(component.getClass());
        require(field(component, "backend") == backend, "native_backend_mismatch");
        Object scanner = field(component, "scanner"), manager = field(component, "meshLevelManager");
        require(scanner != null && manager != null, "native_AutoLeveler_not_initialised");
        SurfacePins.check(manager.getClass());
        require(field(manager, "surfaceScanner") == scanner && field(manager, "backend") == backend, "native_manager_mismatch");
        // Pin every private structure read by the bridge, including inherited backend fields.
        Class<?> backendType = backend.getClass();
        while (backendType != null && !backendType.getName().equals("com.willwinder.universalgcodesender.model.GUIBackend")) backendType = backendType.getSuperclass();
        require(backendType != null, "unsupported_native_backend"); SurfacePins.check(backendType);
        SurfacePins.check(AutoLevelSettings.class); SurfacePins.check(Position.class);
        SurfacePins.check(backend.getSettings().getClass());
        Object parser = field(backend, "gcp"); SurfacePins.check(parser.getClass());
        Object processors = field(parser, "processors"); SurfacePins.check(processors.getClass());
        return new Native(backend, scanner, manager, processors);
    }

    static final class Native {
        final BackendAPI backend; final Object scanner, manager, processors; final AutoLevelSettings settings;
        Native(BackendAPI backend, Object scanner, Object manager, Object processors) throws Exception {
            this.backend = backend; this.scanner = scanner; this.manager = manager; this.processors = processors;
            require(scanner.getClass().getName().equals(SCANNER), "wrong_native_scanner"); SurfacePins.check(scanner.getClass());
            settings = backend.getSettings().getAutoLevelSettings();
            require(field(scanner, "backend") == backend && field(scanner, "settings") == settings, "scanner_backend_mismatch");
        }
        Position[][] points() throws Exception { return (Position[][]) invoke(scanner, "getProbePositionGrid", new Class<?>[0]); }
        boolean hasMeasuredPoints() throws Exception {
            for (Position[] column : points()) for (Position p : column) if (Double.isFinite(p.getZ())) return true;
            return false;
        }
        boolean scanning() throws Exception { return ((AtomicBoolean) field(scanner, "isScanning")).get(); }
        List<Object> meshes(Object processor) throws Exception {
            List<Object> result = new ArrayList<>();
            if (processor == null) return result;
            if (processor.getClass().getName().equals(MESH)) { SurfacePins.check(processor.getClass()); result.add(processor); }
            if (processor instanceof Iterable<?> list) for (Object child : list) result.addAll(meshes(child));
            return result;
        }
        void safe() throws Exception {
            require(!backend.isSendingFile(), "file_send_active");
            require(backend.getGcodeFile() == null && backend.getProcessedGcodeFile() == null, "selected_file_must_be_empty");
            require(!backend.isConnected() || backend.isIdle(), "controller_not_idle");
            require(!scanning(), "native_scan_active");
            require(backend.getSettings().getPreferredUnits() == Units.MM, "native_units_must_be_MM");
            require(!settings.getApplyToGcode(), "disable_native_compensation_before_import");
            require(meshes(processors).isEmpty(), "native_mesh_processor_already_registered");
            require(field(manager, "commandProcessorList") == null, "native_manager_still_has_processor");
        }
        Map<String,Object> read() throws Exception {
            Map<String,Object> r = new LinkedHashMap<>();
            r.put("evidence", "native-autoleveler-readback");
            r.put("units", backend.getSettings().getPreferredUnits().name());
            r.put("zSurface", finite(settings.getZSurface()));
            Position offset = settings.getAutoLevelProbeOffset();
            r.put("probeOffsets", Arrays.asList(finite(offset.getX()), finite(offset.getY()), finite(offset.getZ())));
            r.put("probeOffsetUnits", offset.getUnits().name());
            r.put("probeZeroHeight", finite(settings.getAutoLevelProbeZeroHeight()));
            boolean relative = settings.getZSurface() == 0 && offset.getX() == 0 && offset.getY() == 0 && offset.getZ() == 0;
            r.put("mode", relative ? "relative" : "native-offset");
            r.put("applyToGcode", settings.getApplyToGcode()); r.put("scanning", scanning());
            r.put("stepResolution", finite(settings.getStepResolution()));
            Grid grid = null;
            try { grid = Grid.fromNative(points()); } catch (IllegalArgumentException ignored) { }
            boolean valid = (Boolean) invoke(scanner, "isValid", new Class<?>[0]);
            int total = 0, measured = 0;
            for (Position[] column : points()) for (Position point : column) {
                total++; if (Double.isFinite(point.getX()) && Double.isFinite(point.getY()) && Double.isFinite(point.getZ())) measured++;
            }
            boolean complete = valid && total >= 4 && measured == total;
            r.put("nativeScannerValid", valid); r.put("nativePointCount", total); r.put("measuredPointCount", measured);
            r.put("mapComplete", complete); r.put("nativeMapSha256", complete && grid != null ? grid.hash : null);
            r.put("mapInspection", grid != null && complete ? "supported_relative_grid" : complete ? "outside_relative_handoff_contract" : "incomplete");
            r.put("mapId", null); // UGS does not store a Buildmaster identifier.
            if (complete && grid != null) { r.put("x", grid.x); r.put("y", grid.y); r.put("relativeZ", grid.z); }
            List<Object> meshes = meshes(processors);
            Object registered = field(manager, "commandProcessorList");
            boolean managerRegistered = false;
            for (Object p : (Iterable<?>) processors) if (p == registered) managerRegistered = true;
            r.put("meshProcessorCount", meshes.size()); r.put("managerProcessorRegistered", managerRegistered);
            List<Map<String,Object>> meshState = new ArrayList<>();
            for (Object mesh : meshes) {
                Map<String,Object> item = new LinkedHashMap<>();
                item.put("materialSurfaceHeightMM", finite((Double) field(mesh, "materialSurfaceHeightMM")));
                item.put("units", field(mesh, "surfaceMeshUnits").toString());
                String digest = null;
                try { digest = Grid.fromNative((Position[][]) field(mesh, "surfaceMesh")).hash; }
                catch (IllegalArgumentException ignored) { }
                item.put("nativeMapSha256", digest);
                item.put("matchesScanner", digest != null && digest.equals(r.get("nativeMapSha256")));
                meshState.add(item);
            }
            r.put("meshProcessors", meshState);
            r.put("compensationApplied", meshes.isEmpty() ? false : null);
            r.put("applicationState", meshes.isEmpty() ? "not_registered" : "registered_file_application_unverified");
            r.put("selectedFile", fileIdentity(backend.getGcodeFile()));
            r.put("processedFile", fileIdentity(backend.getProcessedGcodeFile()));
            return r;
        }
        void load(Grid grid) throws Exception {
            // The public methods used by upstream OpenScannedSurfaceAction, with
            // explicit bounds/resolution and zero probe offset for relative data.
            AutoLevelSettings next = new AutoLevelSettings(settings);
            double minZ = settings.getMinZ(), maxZ = settings.getMaxZ();
            require(Double.isFinite(minZ) && Double.isFinite(maxZ) && minZ < maxZ, "native_scan_z_range_required");
            next.setMin(new Position(grid.x[0], grid.y[0], minZ, Units.MM));
            next.setMax(new Position(grid.x[grid.x.length-1], grid.y[grid.y.length-1], maxZ, Units.MM));
            // Avoid an extra endpoint from ceil(span / resolution) at floating-point
            // boundaries. All generated coordinates must still match explicit axes.
            double resolution = Math.nextUp(Math.max(grid.step(), Math.max(
                    (grid.x[grid.x.length-1]-grid.x[0])/(grid.x.length-1),
                    (grid.y[grid.y.length-1]-grid.y[0])/(grid.y.length-1))));
            next.setStepResolution(resolution); next.setZSurface(0);
            next.setAutoLevelProbeOffset(new Position(0, 0, 0, Units.MM)); next.setApplyToGcode(false);
            settings.apply(next);
            invoke(scanner, "update", new Class<?>[]{Position.class, Position.class},
                    new Position(grid.x[0], grid.y[0], minZ, Units.MM),
                    new Position(grid.x[grid.x.length-1], grid.y[grid.y.length-1], maxZ, Units.MM));
            int count = 0;
            while (true) {
                Optional<?> nextPoint = (Optional<?>) invoke(scanner, "getNextProbePoint", new Class<?>[0]);
                if (nextPoint.isEmpty()) break;
                require(++count <= grid.x.length * grid.y.length, "unexpected_native_grid_size");
                Position p = (Position) nextPoint.get();
                int x = index(grid.x, p.getX()), y = index(grid.y, p.getY());
                require(x >= 0 && y >= 0, "native_grid_coordinate_mismatch");
                invoke(scanner, "probeEvent", new Class<?>[]{Position.class}, new Position(p.getX(), p.getY(), grid.z[y][x], Units.MM));
                // probeEvent stores its expected Position object in the native grid.
                // Preserve the exact immutable axes instead of binary roundoff from
                // min + index*resolution. No resampling or height adjustment occurs.
                p.setX(grid.x[x]); p.setY(grid.y[y]);
            }
            require(count == grid.x.length * grid.y.length, "native_grid_incomplete");
        }
    }
    static int index(double[] values, double wanted) {
        for (int i=0; i<values.length; i++) if (Math.abs(values[i]-wanted) <= 1e-7) return i;
        return -1;
    }
    static Object finite(double n) { return Double.isFinite(n) ? n : null; }
    static Object fileIdentity(File file) throws Exception {
        if (file == null) return null;
        Map<String,Object> r = new LinkedHashMap<>(); r.put("path", file.getCanonicalPath());
        if (!file.isFile() || Files.size(file.toPath()) > 64L*1024*1024) { r.put("sha256", null); return r; }
        try (InputStream input = Files.newInputStream(file.toPath())) {
            MessageDigest digest = MessageDigest.getInstance("SHA-256"); byte[] buffer = new byte[8192]; int count;
            long total = 0;
            while ((count = input.read(buffer)) != -1) { total += count; require(total <= 64L*1024*1024, "file_changed_during_read"); digest.update(buffer, 0, count); }
            r.put("sha256", HexFormat.of().formatHex(digest.digest()));
        }
        return r;
    }
    /** Restore object state without firing the listeners that caused a failure. */
    static final class Snapshot {
        final Object scanner, settings; final Map<Field,Object> scannerFields = new LinkedHashMap<>(), settingFields = new LinkedHashMap<>();
        final boolean scanning;
        Snapshot(Object scanner, AutoLevelSettings settings) throws Exception {
            this.scanner = scanner; this.settings = settings;
            for (String name : List.of("probePositionGrid", "pendingPositions", "minXYZ", "maxXYZ")) {
                Field f = slot(scanner, name); scannerFields.put(f, f.get(scanner));
            }
            scanning = ((AtomicBoolean) field(scanner, "isScanning")).get();
            for (Field f : AutoLevelSettings.class.getDeclaredFields()) {
                if (Modifier.isFinal(f.getModifiers()) || Modifier.isStatic(f.getModifiers())) continue;
                f.setAccessible(true); settingFields.put(f, f.get(settings));
            }
        }
        void restore() throws Exception {
            for (var entry : settingFields.entrySet()) entry.getKey().set(settings, entry.getValue());
            for (var entry : scannerFields.entrySet()) entry.getKey().set(scanner, entry.getValue());
            ((AtomicBoolean) field(scanner, "isScanning")).set(scanning);
            for (var entry : scannerFields.entrySet()) require(entry.getKey().get(scanner) == entry.getValue(), "rollback_readback_failed");
            for (var entry : settingFields.entrySet()) require(Objects.equals(entry.getKey().get(settings), entry.getValue()), "rollback_settings_readback_failed");
        }
    }

    static final class Grid {
        final String id, hash; final double[] x, y; final double[][] z;
        Grid(String id, double[] x, double[] y, double[][] z) throws Exception {
            this.id = id; this.x = x.clone(); this.y = y.clone(); this.z = Arrays.stream(z).map(double[]::clone).toArray(double[][]::new);
            require(x.length >= 2 && x.length <= 100 && y.length >= 2 && y.length <= 100, "invalid_axis_size");
            double step = step(); require(step >= .001 && step <= 10000, "invalid_resolution");
            for (double[] axis : new double[][]{this.x, this.y}) for (int i=0; i<axis.length; i++) {
                axis[i] = number(axis[i], 10000);
                if (i > 0) { double delta = axis[i]-axis[i-1]; require(delta >= .001 && delta <= step+1e-9 && (i == axis.length-1 || Math.abs(delta-step) <= 1e-9), "non_native_grid"); }
            }
            require(z.length == y.length, "invalid_row_count"); boolean zero = false;
            for (double[] row : this.z) { require(row.length == x.length, "invalid_column_count");
                for (int i=0; i<row.length; i++) { row[i] = number(row[i], 100); zero |= row[i] == 0; } }
            require(zero, "relative_map_needs_zero_datum");
            ByteArrayOutputStream bytes = new ByteArrayOutputStream(); DataOutputStream out = new DataOutputStream(bytes);
            out.write("CNC-BUILDMASTER-SURFACE-V1\0MM\0relative\0".getBytes(StandardCharsets.US_ASCII));
            out.writeInt(x.length); out.writeInt(y.length);
            for (double[] axis : new double[][]{this.x, this.y}) for (double n : axis) out.writeDouble(n);
            for (double[] row : this.z) for (double n : row) out.writeDouble(n);
            hash = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes.toByteArray()));
        }
        double step() { return Math.max(x[1]-x[0], y[1]-y[0]); }
        static double number(double n, double limit) { require(Double.isFinite(n) && Math.abs(n) <= limit, "nonfinite_or_out_of_bounds"); return n == 0 ? 0 : n; }
        static double[] axis(JsonNode value) {
            require(value != null && value.isArray() && value.size() <= 100, "expected_axis_array"); double[] r = new double[value.size()];
            for (int i=0; i<r.length; i++) { require(value.get(i).isNumber(), "expected_number"); r[i] = value.get(i).asDouble(); } return r;
        }
        static Grid parse(String body) throws Exception {
            require(body != null && body.length() <= 1_000_000, "invalid_body_size");
            JsonNode n = JSON.readTree(body); require(n != null && n.isObject(), "expected_object");
            Set<String> names = new HashSet<>(); n.fieldNames().forEachRemaining(names::add);
            require(names.equals(Set.of("protocol","mapId","mode","units","x","y","relativeZ","sha256","expectedSelectedFile")), "missing_or_unknown_fields");
            require(n.get("protocol").isIntegralNumber() && n.get("protocol").canConvertToInt() && n.get("protocol").asInt() == 1, "unsupported_protocol");
            require(n.get("mode").asText().equals("relative") && n.get("units").asText().equals("MM"), "unsupported_mode_units");
            require(n.get("mapId").isTextual() && n.get("mapId").asText().matches("[-A-Za-z0-9_]{8,80}"), "invalid_map_id");
            require(n.get("expectedSelectedFile").isNull(), "selected_file_must_be_empty");
            JsonNode rows = n.get("relativeZ"); require(rows.isArray() && rows.size() <= 100, "expected_rows");
            double[][] z = new double[rows.size()][]; for (int i=0; i<z.length; i++) z[i] = axis(rows.get(i));
            Grid g = new Grid(n.get("mapId").asText(), axis(n.get("x")), axis(n.get("y")), z);
            require(n.get("sha256").isTextual() && g.hash.equals(n.get("sha256").asText()), "map_digest_mismatch"); return g;
        }
        static Grid fromNative(Position[][] points) throws Exception {
            require(points.length >= 2 && points.length <= 100 && points[0].length >= 2 && points[0].length <= 100, "native_grid_incomplete");
            double[] x = new double[points.length], y = new double[points[0].length]; double[][] z = new double[y.length][x.length];
            for (int i=0; i<x.length; i++) { require(points[i].length == y.length, "native_ragged_grid"); x[i] = points[i][0].getX(); }
            for (int j=0; j<y.length; j++) y[j] = points[0][j].getY();
            for (int i=0; i<x.length; i++) for (int j=0; j<y.length; j++) {
                Position p = points[i][j]; require(p.getUnits() == Units.MM && p.getX() == x[i] && p.getY() == y[j], "native_grid_misaligned"); z[j][i] = p.getZ();
            }
            return new Grid("native-map", x, y, z);
        }
        boolean matches(Map<String,Object> n) {
            return Boolean.TRUE.equals(n.get("mapComplete")) && hash.equals(n.get("nativeMapSha256")) && "MM".equals(n.get("units"))
                    && "relative".equals(n.get("mode")) && Boolean.FALSE.equals(n.get("applyToGcode"))
                    && Integer.valueOf(0).equals(n.get("meshProcessorCount")) && n.get("selectedFile") == null;
        }
    }
}
