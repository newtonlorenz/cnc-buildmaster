/** Shared connection identity rules for the watcher and every motion worker. */
const ensure = (ok, message) => { if (!ok) throw Error(message); };

export function serialDevicePath(port) {
  ensure(typeof port === 'string', 'Serial port must be a string');
  // UGS omits /dev/ on macOS. Other paths and cu/tty siblings are not aliases.
  ensure(/^(?:\/dev\/)?(?:cu|tty)\.[A-Za-z0-9._-]+$/.test(port), `Invalid macOS serial port: ${port}`);
  return port.startsWith('/dev/') ? port : `/dev/${port}`;
}

export function checkMachineProfile(settings, machine) {
  const differences = [];
  if (serialDevicePath(settings.port) !== serialDevicePath(machine.connection.port))
    differences.push(`port expected ${machine.connection.port}, got ${settings.port}`);
  if (!/^[0-9]+$/.test(String(settings.portRate)) || Number(settings.portRate) !== machine.connection.baud)
    differences.push(`baud expected ${machine.connection.baud}, got ${settings.portRate}`);
  if (settings.firmwareVersion !== machine.sender_defaults.firmware)
    differences.push(`controller expected ${machine.sender_defaults.firmware}, got ${settings.firmwareVersion}`);
  if (settings.preferredUnits !== 'MM') differences.push('units must be MM');
  ensure(differences.length === 0, `UGS connected profile differs from machine record: ${differences.join('; ')}`);
}
