# Third-party notices

## Universal Gcode Sender

The Java files under `extensions/ugs/src` include modified Universal Gcode Sender source.
Original copyright notices remain in each upstream file.
UGS uses GNU GPL version 3 or later, as stated in those files.

Source: https://github.com/winder/Universal-G-Code-Sender

Local modifications provide loopback binding, bounded status serialization and native held-jog cancellation.
The recorded upstream hashes identify the compatible installed classes.
This repository does not include compiled UGS binaries.

## Node.js dependencies

`ws` uses the MIT licence. Playwright uses the Apache-2.0 licence.
Their distributions contain their licence notices.
`package-lock.json` records the dependency versions.

The desktop UI bundles React, Radix primitives, Lucide and source components from AI Elements and shadcn/ui. Their licence text is retained in
[scripts/cnc-map-ui/THIRD_PARTY_NOTICES.md](scripts/cnc-map-ui/THIRD_PARTY_NOTICES.md)
and the generated bundle.


## Model Context Protocol SDK

The local agent bridge uses the official `@modelcontextprotocol/server` 2.0.0;
protocol tests use `@modelcontextprotocol/client` 2.0.0. The installed packages
retain their upstream notices. Their licence file describes the project's
MIT-to-Apache-2.0 transition; a copy is retained in
[docs/licenses/MCP-SDK-LICENSE.txt](docs/licenses/MCP-SDK-LICENSE.txt).
The lockfile pins these packages and their dependencies. They are not bundled
into the browser application.

Source: https://github.com/modelcontextprotocol/typescript-sdk
