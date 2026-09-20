// SPDX-License-Identifier: GPL-3.0-or-later
// Installed UGS 2.1.26 class bytes, checked against pinned upstream API contracts.
package com.willwinder.universalgcodesender.pendantui.v1.resources;

import java.util.Map;
import java.util.HexFormat;
import java.security.MessageDigest;

final class SurfacePins {
    static final Map<String,String> CLASSES = Map.ofEntries(
        Map.entry("com.willwinder.ugs.platform.surfacescanner.AutoLevelerTopComponent", "53f92bb31d6cc15cdd3ac79da5fe04209f5b0362cdb37de6a0186e430dfe8cd8"),
        Map.entry("com.willwinder.ugs.platform.surfacescanner.SurfaceScanner", "e1ac49aa788b45f4665bb61ba8ee26db54bff1883d5eb94a574455e273a52e89"),
        Map.entry("com.willwinder.ugs.platform.surfacescanner.MeshLevelManager", "5a20a3526f2ee78456ef7753e370ac9a0d73eba248c21f50a9407ce54969c4e1"),
        Map.entry("com.willwinder.ugs.platform.surfacescanner.Utils", "dd05ed5784658225809055e97fdff99f4cc97e052d47a5f511af3411fe1d1f33"),
        Map.entry("com.willwinder.universalgcodesender.model.GUIBackend", "6d7aeb373391e8adeb933a999f5214853e4c91998598fac36b721f124fc39f1b"),
        Map.entry("com.willwinder.universalgcodesender.gcode.GcodeParser", "b2df8ca5f8730b98a2d23519acd7cb2b3ff97432c924183ef00c18bc04ed59c6"),
        Map.entry("com.willwinder.universalgcodesender.gcode.processors.CommandProcessorList", "6a6c26d50a2e34648aa2f59774a9682c1fd54e404b1240e1842d60139236f993"),
        Map.entry("com.willwinder.universalgcodesender.gcode.processors.MeshLeveler", "54f16e97a576e0398f7ff3a60bf84830cc752898170c0fb63c31890f171e7a7c"),
        Map.entry("com.willwinder.universalgcodesender.utils.AutoLevelSettings", "cec38bf13686471ba6102ff2a555b63e59ea108e71afab901875aca5a618157a"),
        Map.entry("com.willwinder.universalgcodesender.utils.Settings", "f8bcfc963cf9ffae15638a8e5ebbe16c33f4685594d7a05da085d094731889c0"),
        Map.entry("com.willwinder.universalgcodesender.model.Position", "3e141559185469cb3ad129b1ca05048c25157a776b58cbe0a21f887f10209941"));
    static void check(Class<?> type) throws Exception {
        String expected = CLASSES.get(type.getName());
        if (expected == null) throw new IllegalStateException("Unpinned native dependency: " + type.getName());
        try (var stream = type.getResourceAsStream("/" + type.getName().replace('.', '/') + ".class")) {
            if (stream == null || !expected.equals(HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(stream.readAllBytes()))))
                throw new IllegalStateException("Native dependency hash mismatch: " + type.getName());
        }
    }
}
