# CNC Buildmaster

CNC Buildmaster is a local web application for CNC job preparation and supervised surface measurement.
UGS owns the serial connection. CNC Buildmaster communicates with the local UGS API.

## Tools

| Tool | Function |
| --- | --- |
| Job preparation | Import G-code, inspect stock placement, assign cutters, align references and export a draft. |
| Machine controls | Read connection status, jog the cutter and record the measurement corners. |
| Surface measurement | Preview the grid and measure each point with a manually placed conductive puck. |
| Camera | Show a local camera view. The view has no position calibration. |
| Configuration | Show the machine configuration in use. |

The application does not generate isolation paths from Gerbers or send cutting jobs.
Automatic copper scanning is not available. Height compensation is not applied to exported G-code.

## Start the simulation

Python 3.11 or later and Node.js 22 or later are required.
The process manager also uses `lsof` and POSIX process tools.
The current machine integration targets macOS, UGS Platform 2.1.26 and GRBL 1.1.
Other operating systems and controllers are not qualified.

```sh
npm ci
./cnc-map start --demo
```

Open the address that appears in the terminal.
The simulation does not access UGS or a physical camera unless you enable the Camera tool.
Simulated measurements cannot become a machine height map.

```sh
./cnc-map status
./cnc-map stop
```

## Configure a machine

1. Read [Configuration](docs/CONFIGURATION.md).
2. Complete a local configuration file from `config/example.json`.
3. Read [UGS extension](docs/UGS.md).
4. Establish the physical setup described in [Operation](docs/OPERATION.md).

The example configuration cannot enable machine mode.
A successful software check does not establish a surface reference or prove physical clearance.

## Development

```sh
npm test
npm run test:browser
```

The browser tests use an installed Google Chrome and simulated machine data.
They use a generated camera image. They do not move a machine.

See [Architecture](docs/ARCHITECTURE.md) for module responsibilities.
See [Contributing](CONTRIBUTING.md) for change requirements.

## Licence

GPL-3.0-or-later. See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).
The UGS extension contains modified UGS source with its original copyright notices.
