import AppKit

struct LaunchConfig: Decodable { let project: String; let python: String; let nodeDirectory: String; let configuration: String; let port: Int? }
let resource = Bundle.main.resourceURL!.appendingPathComponent("launcher.json")
let config = try JSONDecoder().decode(LaunchConfig.self, from: Data(contentsOf: resource))

func invoke(_ action: String) throws -> [String: Any] {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: config.python)
    process.arguments = [config.project + "/scripts/cnc_map_desktop.py", action, "--port", String(config.port ?? 8765)]
    process.currentDirectoryURL = URL(fileURLWithPath: config.project)
    var environment = ProcessInfo.processInfo.environment
    environment["CNC_BUILDMASTER_CONFIG"] = config.configuration
    environment["PATH"] = config.nodeDirectory + ":" + URL(fileURLWithPath: config.python).deletingLastPathComponent().path + ":/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    process.environment = environment
    let output = Pipe(), errors = Pipe()
    process.standardOutput = output; process.standardError = errors
    try process.run()
    let data = output.fileHandleForReading.readDataToEndOfFile()
    let errorData = errors.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    guard let result = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        let detail = String(data: errorData, encoding: .utf8) ?? ""
        throw NSError(domain: "Buildmaster", code: 1, userInfo: [NSLocalizedDescriptionKey: "Cannot run the local launcher. Check the project and Python installation. " + String(detail.prefix(500))])
    }
    if let error = result["error"] as? String { throw NSError(domain: "Buildmaster", code: 1, userInfo: [NSLocalizedDescriptionKey:error]) }
    return result
}

if CommandLine.arguments.contains("--write-icon") {
    let directory=Bundle.main.resourceURL!.appendingPathComponent("AppIcon.iconset")
    try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
    for size in [16,32,128,256,512] {
        for scale in [1,2] {
            let pixels=size*scale
            let bitmap=NSBitmapImageRep(bitmapDataPlanes:nil,pixelsWide:pixels,pixelsHigh:pixels,bitsPerSample:8,samplesPerPixel:4,hasAlpha:true,isPlanar:false,colorSpaceName:.deviceRGB,bytesPerRow:0,bitsPerPixel:0)!
            NSGraphicsContext.saveGraphicsState();NSGraphicsContext.current=NSGraphicsContext(bitmapImageRep:bitmap)
            let length=CGFloat(pixels)
            NSColor(calibratedRed:0.08,green:0.40,blue:0.38,alpha:1).setFill()
            NSBezierPath(roundedRect:NSRect(x:length*0.06,y:length*0.06,width:length*0.88,height:length*0.88),xRadius:length*0.20,yRadius:length*0.20).fill()
            if let symbol=NSImage(systemSymbolName:"square.3.layers.3d",accessibilityDescription:nil)?.withSymbolConfiguration(NSImage.SymbolConfiguration(paletteColors:[.white])) {
                symbol.draw(in:NSRect(x:length*0.22,y:length*0.22,width:length*0.56,height:length*0.56))
            }
            NSGraphicsContext.restoreGraphicsState()
            let name="icon_\(size)x\(size)"+(scale==2 ? "@2x" : "")+".png"
            try bitmap.representation(using:.png,properties:[:])!.write(to:directory.appendingPathComponent(name))
        }
    }
    exit(0)
}

if CommandLine.arguments.contains("--self-test") {
    let result = try invoke("status")
    print(result["message"] as? String ?? "Launcher OK")
    exit(0)
}

class AppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var status = NSTextField(labelWithString: "Checking local server…")
    var buttons: [NSButton] = []
    var busy = false
    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let item = NSMenuItem(); menu.addItem(item)
        let applicationMenu = NSMenu(); item.submenu = applicationMenu
        applicationMenu.addItem(withTitle: "Quit CNC Buildmaster Launcher", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        NSApp.mainMenu = menu
        window = NSWindow(contentRect:NSRect(x:0,y:0,width:570,height:470), styleMask:[.titled,.closable,.miniaturizable], backing:.buffered, defer:false)
        window.title="CNC Buildmaster"; window.center(); window.isReleasedWhenClosed=false
        let stack=NSStackView(); stack.orientation = .vertical; stack.alignment = .leading; stack.spacing=18
        stack.translatesAutoresizingMaskIntoConstraints=false
        window.contentView!.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo:window.contentView!.leadingAnchor,constant:28),stack.trailingAnchor.constraint(equalTo:window.contentView!.trailingAnchor,constant:-28),stack.topAnchor.constraint(equalTo:window.contentView!.topAnchor,constant:28)])
        let title=NSTextField(labelWithString:"CNC Buildmaster");title.font = .systemFont(ofSize:26,weight:.semibold);stack.addArrangedSubview(title)
        status.font = .systemFont(ofSize:14,weight:.medium);stack.addArrangedSubview(status)
        let detail=NSTextField(wrappingLabelWithString:"Open your workbench here. UGS keeps the USB connection. Starting Buildmaster does not enable teaching or move the CNC.");detail.textColor = .secondaryLabelColor;stack.addArrangedSubview(detail)
        stack.addArrangedSubview(row([("Open Buildmaster","open"),("Open UGS","ugs")]))
        stack.addArrangedSubview(row([("Restart server…","restart"),("Stop server…","stop")]))
        stack.addArrangedSubview(row([("Project folder","project"),("Logs","logs"),("Quick start","help")]))
        let footer=NSTextField(wrappingLabelWithString:"Closing this launcher leaves the server running. If another browser tab owns the session, close that tab and use the app’s recovery option.");footer.font = .systemFont(ofSize:12);footer.textColor = .secondaryLabelColor;stack.addArrangedSubview(footer)
        window.makeKeyAndOrderFront(nil);NSApp.activate(ignoringOtherApps:true)
        if CommandLine.arguments.contains("--show-controls") { perform("status") } else { perform("open") }
    }
    func row(_ entries: [(String,String)]) -> NSStackView {
        let row=NSStackView();row.orientation = .horizontal;row.spacing=10
        for (title,action) in entries {
            let button=NSButton(title:title,target:self,action:#selector(clicked(_:)));button.bezelStyle = .rounded;button.identifier = NSUserInterfaceItemIdentifier(action)
            if action == "open" { button.keyEquivalent="\r" }
            buttons.append(button);row.addArrangedSubview(button)
        }
        return row
    }
    @objc func clicked(_ sender:NSButton) {
        let action=sender.identifier!.rawValue
        if action == "stop" || action == "restart" {
            let alert=NSAlert();alert.messageText=action == "restart" ? "Restart Buildmaster?" : "Stop Buildmaster?"
            alert.informativeText="This ends the current teaching or scan session. Inspect the machine first. Saved files remain; UGS stays open. This is not an emergency stop."
            alert.addButton(withTitle:"Cancel");alert.addButton(withTitle:action == "restart" ? "Restart" : "Stop server")
            if alert.runModal() != .alertSecondButtonReturn { return }
        }
        perform(action)
    }
    func perform(_ action:String) {
        if busy { return };busy=true;buttons.forEach{$0.isEnabled=false};status.stringValue="Working…"
        DispatchQueue.global(qos:.userInitiated).async {
            let result=Result { try invoke(action) }
            DispatchQueue.main.async {
                self.busy=false;self.buttons.forEach{$0.isEnabled=true}
                switch result {
                case .success(let value):
                    self.status.stringValue=value["message"] as? String ?? "Done"
                    if action == "restart" { self.perform("open") }
                case .failure(let error):
                    self.status.stringValue="Needs attention"
                    let alert=NSAlert();alert.messageText="Buildmaster could not complete this action";alert.informativeText=error.localizedDescription;alert.runModal()
                }
            }
        }
    }
    func applicationShouldHandleReopen(_ sender:NSApplication,hasVisibleWindows:Bool)->Bool { window.makeKeyAndOrderFront(nil);perform("open");return true }
}
let app=NSApplication.shared
let delegate=AppDelegate();app.delegate=delegate
app.setActivationPolicy(.regular);app.run()
