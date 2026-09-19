# UGS extension

The machine integration needs UGS Platform 2.1.26 on macOS and GRBL 1.1.
The extension binds the API to `127.0.0.1`, provides finite status values and adds native held-jog cancellation.
Upstream class hashes reject incompatible UGS builds.

## Build

A JDK with Java 17 compilation support is required.
The command uses libraries from the application path in your configuration.
It does not start UGS or change its preferences.

```sh
export CNC_BUILDMASTER_CONFIG="$PWD/config/local.json"
python3 scripts/build_ugs_extension.py --javac /path/to/jdk/bin/javac
python3 scripts/ugs_loopback_setup.py --check
```

The build creates `extensions/ugs/loopback-patch.jar` and `patch-hashes.json`.
These local build files remain outside Git.
If a stock class hash differs, stop and review compatibility before another build.
Do not replace the recorded hashes merely to accept another version.

## Offline held-jog check

```sh
JAVA_HOME=/path/to/jdk python3 tests/test_ugs_held_jog.py -v
```

This compiles the extension against the compatible UGS libraries and exercises a
fake controller in a temporary directory. It does not connect to or start UGS.
Without a suitable JDK or local UGS distribution, the test reports a skip; the
browser and Node tests still run independently. Existing extension installations
need a separately reviewed rebuild and UGS restart to load source changes.

The cancellation logic sends one cancel after acknowledgement. A release that
arrives earlier sends an immediate cancel and one more after acknowledgement,
then waits for a fresh stopped report. It does not repeatedly flood the sender.

## Configure UGS startup

Close UGS before you change its startup configuration.
Preserve the existing UGS preferences and startup file.

The macOS startup file is `~/Library/Application Support/ugsplatform/etc/ugsplatform.conf`.
Add the following block with absolute paths for your installation.
The extension path must not contain whitespace because the UGS launcher splits its option string.

```sh
export CNC_BUILDMASTER_CONFIG='/absolute/path/to/config/local.json'
if ! /absolute/path/to/python3 '/absolute/path/to/cnc-buildmaster/scripts/ugs_loopback_setup.py' --check; then
    echo 'UGS extension compatibility check failed.' >&2
    exit 1
fi
default_options="$default_options -J-Dnetbeans.patches.com.willwinder.ugs.platform.ugslib=/absolute/path/to/cnc-buildmaster/extensions/ugs/loopback-patch.jar"
```

Use the configured `ugsPort` for the UGS pendant port.
Start UGS with this guarded configuration before you enable its pendant service.
Do not enable the unmodified pendant service on a network interface.

The application independently checks the listening address, UGS process identity and extension hashes.
A successful connection check does not establish material Z zero.

## Status

The extension source came from the local UGS integration.
This public extraction has offline tests only. It has no physical movement qualification on another machine.
Windows and Linux machine integration require separate installation and process-identity work.
