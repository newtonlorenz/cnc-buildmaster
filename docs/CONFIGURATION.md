# Configuration

Machine configuration is a local JSON file. The application reads this file at startup.
Each machine needs its own file. The repository excludes `config/local*.json` and local data.

## Create the file

```sh
cp config/example.json config/local.json
```

1. Enter a name for the machine.
2. Enter the serial device path and baud rate from UGS.
3. Enter the complete GRBL 1.1 settings record in `baseline`.
4. Enter the measured puck height in millimetres.
5. Enter the permitted travel and contact feeds in millimetres per minute.
6. Set `configured` to `true` after you complete the fields.

The baseline must contain the controller settings, not estimated values.
The baseline is compared with the controller before movement.
Changing the file does not change controller settings.

```sh
export CNC_BUILDMASTER_CONFIG="$PWD/config/local.json"
python3 scripts/surface_config.py
./cnc-map start
```

A configuration error prevents machine mode.
The Configuration tool shows the selected name, puck height, UGS port and feeds.
It does not edit the file or change controller settings.

## Fields

| Field | Meaning |
| --- | --- |
| `version` | Schema version. Use `1`. |
| `name` | Machine name shown in the interface. |
| `configured` | `false` rejects machine mode. |
| `ugsPort` | Local UGS port, from 1024 to 65535. The host is always `127.0.0.1`. |
| `ugsApp` | Path to the supported macOS UGS application bundle. |
| `dataDir` | Directory for jobs, plans and measurements. Relative paths use the configuration file directory. |
| `machine.connection.port` | Exact serial device path, including `/dev/`. |
| `machine.connection.baud` | Baud rate selected in UGS. |
| `machine.sender_defaults.firmware` | Controller type. This release supports `GRBL`. |
| `baseline` | Complete GRBL 1.1 setting numbers and values from the controller. |
| `puckHeight` | Measured height, greater than 0 and at most 100 mm. Three decimal places are permitted. |
| `feeds.xy` | Travel feed. Maximum 600 mm/min. |
| `feeds.z` | Z travel feed. Maximum 60 mm/min. |
| `feeds.first` | First contact feed. Maximum 50 mm/min. |
| `feeds.second` | Second contact feed. Maximum 10 mm/min. |

The feed limits are software ceilings. They do not prove that a feed is suitable for the machine.
Jog feeds also remain limited by the recorded axis rates.
The current probe cycle retains a 5 mm initial search, 1 mm retract and 1.2 mm second search.
Repeat and return tolerances remain 0.02 mm.

## Storage and restart

1. Stop the application before you change its configuration.
2. Preserve a copy of the previous configuration.
3. Start the application with the required file selected.
4. Establish a new setup and position reference.

Saved files do not restore a valid physical reference.
Do not add configuration, measurements, session reports or personal G-code to a public commit.
