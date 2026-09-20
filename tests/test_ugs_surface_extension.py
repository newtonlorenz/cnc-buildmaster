"""Native UGS classes, fake backend, real endpoint transaction; no UGS or hardware."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from test_ugs_held_jog import jdk_tools
from ugs_surface_bridge import check_surface_stock, make_payload


class SurfaceExtensionTests(unittest.TestCase):
    def test_native_scanner_and_endpoint_regressions(self):
        compiler, runtime = jdk_tools()
        from ugs_loopback_setup import APP, STATE, check_stock
        modules = APP / 'Contents/Resources/ugsplatform/ugsplatform/modules'
        if not modules.is_dir():
            self.skipTest('Compatible local UGS 2.1.26 jars required')
        check_stock()
        check_surface_stock(APP)
        # Production compilation uses exactly the existing build classpath.
        cp = os.pathsep.join(str(j) for j in sorted(modules.rglob('*.jar')))
        payload = make_payload('fixture-map-01', [0, 10], [0, 10], [[0, .01], [.02, -.03]])
        import json
        with tempfile.TemporaryDirectory(prefix='ugs-surface-test-') as directory:
            fixture = Path(directory) / 'SurfaceMapTest.java'
            fixture.write_text(JAVA_FIXTURE.replace('PAYLOAD_LITERAL', json.dumps(json.dumps(payload))))
            commands = [
                [str(compiler), '--release', '17', '-cp', cp, '-d', directory,
                 *map(str, (STATE / 'src').rglob('*.java')), str(fixture)],
                [str(runtime), '-Djava.awt.headless=true', '-ea', '-cp', directory + os.pathsep + cp,
                 'com.willwinder.universalgcodesender.pendantui.v1.resources.SurfaceMapTest'],
            ]
            for command in commands:
                result = subprocess.run(command, capture_output=True, text=True, timeout=60)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn('SurfaceMapTest passed', result.stdout)
            print(result.stdout.strip())


JAVA_FIXTURE = r'''
package com.willwinder.universalgcodesender.pendantui.v1.resources;
import com.willwinder.universalgcodesender.model.*;
import com.willwinder.universalgcodesender.model.UnitUtils.Units;
import com.willwinder.universalgcodesender.utils.*;
import com.willwinder.universalgcodesender.gcode.processors.*;
import com.willwinder.ugs.platform.surfacescanner.*;
import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import java.lang.reflect.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;
import jakarta.ws.rs.core.Response;

public class SurfaceMapTest {
    static final String PAYLOAD = PAYLOAD_LITERAL;
    static final ObjectMapper JSON = new ObjectMapper();
    static int tests;
    static void ok(boolean b) { if (!b) throw new AssertionError("check " + tests); }
    static Map<String,Object> body(Response r, int expected) {
        if (r.getStatus() != expected) throw new AssertionError("Expected " + expected + ": " + r.getEntity());
        return (Map<String,Object>)r.getEntity();
    }
    static class Fake {
        final Settings settings = new Settings();
        final BackendAPI backend;
        final SurfaceScanner scanner;
        final MeshLevelManager manager;
        final CommandProcessorList processors = new CommandProcessorList();
        final SurfaceMapResource.Native access;
        final SurfaceMapResource resource;
        java.io.File selected, processed;
        boolean sending, connected, idle = true;
        Fake() throws Exception {
            settings.getAutoLevelSettings().setApplyToGcode(false);
            backend = (BackendAPI)Proxy.newProxyInstance(getClass().getClassLoader(), new Class[]{BackendAPI.class}, (p,m,a)-> {
                switch(m.getName()) {
                    case "getSettings": return settings;
                    case "isConnected": return connected;
                    case "isIdle": return idle;
                    case "isSendingFile": return sending;
                    case "getGcodeFile": return selected;
                    case "getProcessedGcodeFile": return processed;
                    default: throw new AssertionError("Unexpected backend call (including motion): " + m.getName());
                }
            });
            scanner = new SurfaceScanner(backend); manager = new MeshLevelManager(scanner, backend);
            access = new SurfaceMapResource.Native(backend, scanner, manager, processors);
            resource = new SurfaceMapResource(backend, () -> access);
        }
        Map<String,Object> nativeState() throws Exception { return access.read(); }
        void success() { body(resource.importMap(PAYLOAD), 200); }
    }
    public static void main(String[] args) throws Exception {
        // The hash must be identical to Python's binary canonical protocol.
        var grid = SurfaceMapResource.Grid.parse(PAYLOAD);
        ok(grid.hash.equals(JSON.readTree(PAYLOAD).get("sha256").asText())); tests++;
        Fake f = new Fake();
        body(f.resource.verify(PAYLOAD), 409);
        f.success();
        ok(f.scanner.isValid()); ok(f.scanner.getProbePositionGrid()[1][0].getZ() == .01);
        ok(f.scanner.getProbePositionGrid()[0][1].getZ() == .02);
        ok(!f.settings.getAutoLevelSettings().getApplyToGcode());
        ok(f.settings.getAutoLevelSettings().getMinZ() == 0 && f.settings.getAutoLevelSettings().getMaxZ() == 1);
        ok(f.nativeState().get("nativeMapSha256").equals(grid.hash));
        body(f.resource.verify(PAYLOAD), 200); f.success(); tests++;
        // Native grid mutation defeats any remembered import success.
        f.scanner.getProbePositionGrid()[1][1].setZ(.9);
        body(f.resource.verify(PAYLOAD), 409); body(f.resource.importMap(PAYLOAD), 409); tests++;
        for (String fault : List.of("selected", "processed", "sending", "busy", "scanning", "units", "applied", "processor", "existing", "zrange")) {
            Fake a = new Fake();
            switch(fault) {
                case "selected": a.selected = new java.io.File("fixture.nc"); break;
                case "processed": a.processed = new java.io.File("processed.nc"); break;
                case "sending": a.sending = true; break;
                case "busy": a.connected = true; a.idle = false; break;
                case "scanning": ((AtomicBoolean)SurfaceMapResource.field(a.scanner,"isScanning")).set(true); break;
                case "units": a.settings.setPreferredUnits(Units.INCH); break;
                case "applied": a.settings.getAutoLevelSettings().setApplyToGcode(true); break;
                case "processor": a.processors.add(new MeshLeveler(0, f.scanner.getProbePositionGrid())); break;
                case "existing": a.scanner.probeEvent(new Position(0,0,.3,Units.MM)); break;
                case "zrange": a.settings.getAutoLevelSettings().setMinZ(1); break;
            }
            body(a.resource.importMap(PAYLOAD),409); tests++;
        }
        // Test the actual production transaction rollback on synchronous listener failure.
        for (String failure : List.of("point_listener", "settings_listener", "file_race", "listener_error")) {
            Fake a = new Fake();
            AutoLevelSettings settings = a.settings.getAutoLevelSettings();
            settings.setZSurface(5); settings.setAutoLevelProbeOffset(new Position(1,2,3,Units.MM));
            Object oldPoints = a.scanner.getProbePositionGrid();
            Object oldPending = SurfaceMapResource.field(a.scanner,"pendingPositions");
            int[] updates = {0};
            if (failure.equals("settings_listener")) settings.addSettingChangeListener(()->{throw new IllegalStateException("injected settings fault");});
            else a.scanner.addListener(()->{
                if (++updates[0] == 3) {
                    if (failure.equals("file_race")) a.selected = new java.io.File("other.nc");
                    else if (failure.equals("listener_error")) throw new AssertionError("injected fatal listener");
                    else throw new IllegalStateException("injected point fault");
                }
            });
            body(a.resource.importMap(PAYLOAD),409);
            ok(a.scanner.getProbePositionGrid() == oldPoints);
            ok(SurfaceMapResource.field(a.scanner,"pendingPositions") == oldPending);
            ok(settings.getZSurface() == 5); ok(settings.getAutoLevelProbeOffset().getZ() == 3);
            ok(!settings.getApplyToGcode()); tests++;
        }
        // Successful load explicitly removes native probe offset instead of adding it twice.
        Fake offsets = new Fake(); offsets.settings.getAutoLevelSettings().setAutoLevelProbeOffset(new Position(1,2,-14,Units.MM));
        offsets.settings.getAutoLevelSettings().setZSurface(14); offsets.success();
        ok(offsets.scanner.getProbePositionGrid()[1][1].getZ() == -.03);
        ok(offsets.nativeState().get("mode").equals("relative")); tests++;
        // Changes to native settings invalidate an otherwise identical imported grid.
        offsets.settings.getAutoLevelSettings().setZSurface(1);
        body(offsets.resource.verify(PAYLOAD),409); tests++;
        offsets.settings.getAutoLevelSettings().setZSurface(0);
        offsets.settings.getAutoLevelSettings().setAutoLevelProbeOffset(new Position(0,0,-14,Units.MM));
        body(offsets.resource.verify(PAYLOAD),409); tests++;
        offsets.settings.getAutoLevelSettings().setAutoLevelProbeOffset(new Position(0,0,0,Units.MM));
        // A complete native map outside this protocol is visible but not mislabelled imported.
        for (Position[] column : offsets.scanner.getProbePositionGrid()) for (Position p : column) p.setZ(p.getZ()+5);
        ok(offsets.nativeState().get("mapComplete").equals(true));
        ok(offsets.nativeState().get("nativeMapSha256") == null);
        ok(offsets.nativeState().get("mapInspection").equals("outside_relative_handoff_contract")); tests++;
        for (Position[] column : offsets.scanner.getProbePositionGrid()) for (Position p : column) p.setZ(Double.NaN);
        ok(offsets.nativeState().get("mapComplete").equals(false)); tests++;
        offsets = new Fake(); offsets.success();
        // A processor and processed file still cannot prove selected-file compensation.
        offsets.processors.add(new MeshLeveler(0, offsets.scanner.getProbePositionGrid()));
        Map<String,Object> applied = offsets.nativeState();
        ok(applied.get("meshProcessorCount").equals(1)); ok(applied.get("compensationApplied") == null); tests++;
        // Closed/missing native module returns structured failure, never a fake imported checkbox.
        Fake finalOffsets = offsets;
        SurfaceMapResource missing = new SurfaceMapResource(finalOffsets.backend, () -> {throw new ClassNotFoundException("fixture missing native module");});
        ok(missing.status().get("available").equals(false));
        ok(missing.status().get("compensationApplied") == null); tests++;
        // Invalid payloads are rejected before native access.
        int[] nativeAccess = {0};
        SurfaceMapResource strict = new SurfaceMapResource(finalOffsets.backend, () -> {nativeAccess[0]++; return finalOffsets.access;});
        for (String bad : List.of(PAYLOAD.replace("\"protocol\": 1", "\"protocol\": 18446744073709551617"),
                PAYLOAD.replace("\"protocol\": 1", "\"protocol\": true"), PAYLOAD.replace("0.01", "NaN"),
                PAYLOAD.replace("0.01", "1e999"), PAYLOAD.replace("0.01", "true"),
                PAYLOAD.replace("0.01", "101"), PAYLOAD.replace("0.01", "0.02"),
                PAYLOAD.replace("\"MM\"", "\"INCH\""), PAYLOAD.replace("\"relative\"", "\"absolute\""),
                PAYLOAD.replace("\"expectedSelectedFile\": null", "\"expectedSelectedFile\": \"x.nc\""),
                PAYLOAD.replace("{\"protocol\"", "{\"imported\":true,\"protocol\""),
                PAYLOAD.replace("{\"protocol\"", "{\"protocol\":1,\"protocol\""), PAYLOAD+" {}")) {
            body(strict.importMap(bad),400); tests++;
        }
        ok(nativeAccess[0] == 0);
        // Flat maps, short final grid intervals and signed coordinates are valid.
        for (double[][] axes : List.of(new double[][]{{-10,0,10},{0,10,20}},new double[][]{{0,10,15},{0,10,17}},new double[][]{{.1,.2,.3,.4},{-.1,0,.1,.2}},new double[][]{{-5.123,4.877,14.877},{0,10,20}})) {
            double[][] z = new double[axes[1].length][axes[0].length];
            var flat = new SurfaceMapResource.Grid("flat-map-01",axes[0],axes[1],z);
            Fake a = new Fake(); a.access.safe(); a.access.load(flat); ok(flat.matches(a.nativeState())); tests++;
        }
        System.out.println("SurfaceMapTest passed: " + tests + " native scanner/transaction cases, no machine calls");
    }
}
'''


if __name__ == '__main__':
    unittest.main()
