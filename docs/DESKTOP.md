# Open Buildmaster on your Mac

Press **Cmd+Space**, type **CNC Buildmaster**, and press Return. You can also
use the desktop shortcut. The launcher starts the local server if needed and
opens its authenticated page in your default browser. An existing server is reused.

The launcher provides **Open Buildmaster**, **Open UGS**, **Restart server**,
**Stop server**, **Project folder**, **Logs** and this guide. Right-click its Dock
icon and choose Options → Keep in Dock if you prefer.

UGS continues to own the USB connection. Opening the launcher does not connect,
probe or move the machine. Connect and inspect the machine in UGS as usual.
Closing the launcher or browser leaves the server running. Stop and restart ask
for confirmation, end the current session and leave saved files intact. They are
not emergency stops. Re-establish the physical reference after a restart.

If another browser tab owns the session, close that tab and use Buildmaster's
recovery flow. The launcher does not bypass ownership or physical checks.
Session links and runtime files contain credentials; keep them private.

## Install on another Mac

First complete the repository's machine configuration and dependency setup.
With Node.js 22+, Python 3 and Xcode command-line tools available, run from the
repository:

```sh
python3 scripts/install_desktop_launcher.py --config config/local.json --desktop-shortcut
```

If your Buildmaster server uses a different web port, select the same port when
creating the launcher. For example:

```sh
python3 scripts/install_desktop_launcher.py --config config/local.json --port 8877 --desktop-shortcut
```

The default is 8765. The selected port applies to opening, status, stopping and
restarting the server; it must differ from the UGS API port. An existing launcher
without a saved port continues to use 8765.

This creates `~/Applications/CNC Buildmaster.app` and an optional desktop shortcut.
It records the checkout, configuration and resolved Python/Node paths in the
local application bundle; no private paths are added to source control.
It does not replace an existing app or change UGS.

Keep the checkout and runtime installations in place. If you move them or remove
the recorded Python/Node version, preserve the previous app under another name
and run the installer again. Source updates do not require reinstalling unless
the launcher itself or these paths change. Updates are never downloaded automatically.
