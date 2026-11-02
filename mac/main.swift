import Cocoa
import WebKit
import Network

// ThinkSL8 for Mac. The canvas UI is the same code as the website, bundled in the app and served to its own window from a
// local server (HttpServer + Local). Everything is saved to a local database first, so it works offline; Sync keeps that
// database and thinksl8.com in step.
let db = DB(path: Paths.db)
let remote = Remote(db: db)
let sync = Sync(db: db, remote: remote)
let local = Local(db: db, remote: remote, sync: sync)
let server = HttpServer()
server.handler = { r, c in Task { await local.handle(r, c) } }

let navy = NSColor(srgbRed: 10 / 255, green: 43 / 255, blue: 72 / 255, alpha: 1)

let safariUA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15"

/// Delegate for web tiles: free browsing (these are the user's own pages), links stay in the tile, nothing else gets in.
final class TileDelegate: NSObject, WKNavigationDelegate, WKUIDelegate {
    func webView(_ w: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let scheme = action.request.url?.scheme ?? ""
        decisionHandler(["http", "https", "about", "blob", "data"].contains(scheme) && !action.shouldPerformDownload ? .allow : .cancel)
    }
    func webView(_ w: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(response.canShowMIMEType ? .allow : .cancel)
    }
    func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for action: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        if action.request.url != nil { w.load(action.request) }
        return nil
    }
    func webView(_ w: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) { decisionHandler(.deny) }
}

final class App: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, WKScriptMessageHandler {
    var tiles: [String: WKWebView] = [:]
    let tileDelegate = TileDelegate()

    func makeTile(_ url: URL) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default() // logins (Spotify and the rest) stay between launches
        cfg.mediaTypesRequiringUserActionForPlayback = []
        let v = WKWebView(frame: .zero, configuration: cfg)
        v.customUserAgent = safariUA
        v.navigationDelegate = tileDelegate
        v.uiDelegate = tileDelegate
        v.allowsBackForwardNavigationGestures = true
        v.wantsLayer = true
        v.layer?.cornerRadius = 12
        v.layer?.masksToBounds = true
        v.load(URLRequest(url: url))
        return v
    }

    func clearTiles() {
        for v in tiles.values { v.removeFromSuperview() }
        tiles = [:]
    }

    /// The page says where each web tile sits, in page pixels, every time it moves.
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        guard m.name == "sl8web", let list = m.body as? [[String: Any]] else { return }
        var keep = Set<String>()
        let z = web.pageZoom
        for t in list {
            guard let id = t["id"] as? String, let s = t["url"] as? String, let url = URL(string: s), url.scheme == "https" else { continue }
            keep.insert(id)
            func n(_ k: String) -> CGFloat { CGFloat((t[k] as? NSNumber)?.doubleValue ?? 0) }
            let w = max(1, n("w") * z), h = max(1, n("h") * z), x = n("x") * z
            let y = web.isFlipped ? n("y") * z : web.bounds.height - n("y") * z - h
            let tile: WKWebView
            if let have = tiles[id] { tile = have } else {
                tile = makeTile(url); tiles[id] = tile; web.addSubview(tile)
            }
            tile.frame = NSRect(x: x, y: y, width: w, height: h)
            tile.isHidden = !(t["show"] as? Bool ?? false)
        }
        for id in Array(tiles.keys) where !keep.contains(id) { tiles[id]?.removeFromSuperview(); tiles[id] = nil }
    }

    func webView(_ w: WKWebView, didStartProvisionalNavigation n: WKNavigation!) { clearTiles() }

    var window: NSWindow!
    var web: WKWebView!
    var lastDownload: URL?
    let monitor = NWPathMonitor()

    func applicationDidFinishLaunching(_ note: Notification) {
        guard server.start(ports: 47818...47838) else {
            let a = NSAlert(); a.messageText = "ThinkSL8 can't start"; a.informativeText = "No local port was free."
            a.runModal(); NSApp.terminate(nil); return
        }
        let cfg = WKWebViewConfiguration()
        cfg.applicationNameForUserAgent = "ThinkSL8-Mac"
        cfg.mediaTypesRequiringUserActionForPlayback = []
        cfg.userContentController.add(self, name: "sl8web")
        cfg.userContentController.addUserScript(WKUserScript(source: "window.SL8_NATIVE = true;", injectionTime: .atDocumentStart, forMainFrameOnly: false))
        web = WKWebView(frame: .zero, configuration: cfg)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = true
        web.underPageBackgroundColor = navy
        let z = UserDefaults.standard.double(forKey: "zoom")
        web.pageZoom = z > 0 ? CGFloat(z) : 1

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "ThinkSL8"
        window.titlebarAppearsTransparent = true
        window.backgroundColor = navy
        window.contentView = web
        window.minSize = NSSize(width: 480, height: 360)
        if !window.setFrameUsingName("main") { window.center() }
        window.setFrameAutosaveName("main")

        sync.onStatus = { [weak self] s in DispatchQueue.main.async { self?.window.subtitle = s } }
        monitor.pathUpdateHandler = { if $0.status == .satisfied { sync.kick(after: 1) } }
        monitor.start(queue: DispatchQueue(label: "sl8.net"))
        Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { _ in sync.kick(after: 0) }
        sync.kick(after: 1)

        buildMenu()
        web.load(URLRequest(url: URL(string: "http://127.0.0.1:\(server.port)/__open?k=\(server.token)")!))
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

    func applicationShouldHandleReopen(_ app: NSApplication, hasVisibleWindows: Bool) -> Bool {
        window?.makeKeyAndOrderFront(nil)
        return true
    }

    // MARK: menu

    func buildMenu() {
        let bar = NSMenu()
        func submenu(_ title: String, _ items: [NSMenuItem]) -> NSMenu {
            let item = NSMenuItem(); bar.addItem(item)
            let m = NSMenu(title: title); items.forEach { m.addItem($0) }
            item.submenu = m
            return m
        }
        func mi(_ t: String, _ a: Selector?, _ k: String = "", _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
            let i = NSMenuItem(title: t, action: a, keyEquivalent: k)
            if !k.isEmpty { i.keyEquivalentModifierMask = mods }
            return i
        }
        let sep = { NSMenuItem.separator() }

        _ = submenu("ThinkSL8", [
            mi("About ThinkSL8", #selector(NSApplication.orderFrontStandardAboutPanel(_:))), sep(),
            mi("Hide ThinkSL8", #selector(NSApplication.hide(_:)), "h"),
            mi("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            mi("Show All", #selector(NSApplication.unhideAllApplications(_:))), sep(),
            mi("Quit ThinkSL8", #selector(NSApplication.terminate(_:)), "q"),
        ])
        _ = submenu("File", [
            mi("Sync Now", #selector(syncNow), "s", [.command, .shift]),
            mi("Close Window", #selector(NSWindow.performClose(_:)), "w"),
        ])
        _ = submenu("Edit", [
            mi("Undo", Selector(("undo:")), "z"),
            mi("Redo", Selector(("redo:")), "z", [.command, .shift]), sep(),
            mi("Cut", #selector(NSText.cut(_:)), "x"),
            mi("Copy", #selector(NSText.copy(_:)), "c"),
            mi("Paste", #selector(NSText.paste(_:)), "v"),
            mi("Select All", #selector(NSText.selectAll(_:)), "a"),
        ])
        _ = submenu("View", [
            mi("Reload", #selector(reloadPage), "r"),
            mi("Back", #selector(navBack), "["),
            mi("Forward", #selector(navForward), "]"), sep(),
            mi("Actual Size", #selector(zoomReset), "0"),
            mi("Zoom In", #selector(zoomIn), "="),
            mi("Zoom Out", #selector(zoomOut), "-"), sep(),
            mi("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
        ])
        let win = submenu("Window", [
            mi("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
            mi("Zoom", #selector(NSWindow.performZoom(_:))),
        ])
        NSApp.mainMenu = bar
        NSApp.windowsMenu = win
    }

    @objc func syncNow() { sync.kick(after: 0) }
    @objc func reloadPage() { web.reload() }
    @objc func navBack() { web.goBack() }
    @objc func navForward() { web.goForward() }
    func setZoom(_ z: CGFloat) {
        web.pageZoom = min(3, max(0.5, z))
        UserDefaults.standard.set(Double(web.pageZoom), forKey: "zoom")
    }
    @objc func zoomIn() { setZoom(web.pageZoom + 0.1) }
    @objc func zoomOut() { setZoom(web.pageZoom - 0.1) }
    @objc func zoomReset() { setZoom(1) }

    // MARK: navigation: the app's own pages stay in the window, everything else opens in the browser

    func webView(_ w: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if !(action.targetFrame?.isMainFrame ?? true) { decisionHandler(.allow); return } // embeds: video, music
        let scheme = url.scheme ?? ""
        let ours = scheme == "http" && url.host == "127.0.0.1" && url.port == Int(server.port)
        let ok = ours || ["about", "blob", "data"].contains(scheme) || (scheme == "https" && url.host == "openrouter.ai") // AI sign-in
        if ok { decisionHandler(action.shouldPerformDownload ? .download : .allow); return }
        if ["http", "https", "mailto"].contains(scheme) { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }

    func webView(_ w: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if !response.canShowMIMEType { decisionHandler(.download); return }
        if response.isForMainFrame, let h = response.response as? HTTPURLResponse,
           (h.value(forHTTPHeaderField: "Content-Disposition") ?? "").lowercased().hasPrefix("attachment") {
            decisionHandler(.download); return
        }
        decisionHandler(.allow)
    }

    func webViewWebContentProcessDidTerminate(_ w: WKWebView) { w.reload() }

    // MARK: UI delegate

    func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for action: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url {
            if url.host == "openrouter.ai" { w.load(action.request) } else { NSWorkspace.shared.open(url) }
        }
        return nil
    }

    func webView(_ w: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(type == .microphone && origin.host == "127.0.0.1" ? .grant : .deny)
    }

    func webView(_ w: WKWebView, runOpenPanelWith p: WKOpenPanelParameters, initiatedByFrame f: WKFrameInfo,
                 completionHandler: @escaping ([URL]?) -> Void) {
        let o = NSOpenPanel()
        o.allowsMultipleSelection = p.allowsMultipleSelection
        o.canChooseDirectories = p.allowsDirectories
        o.begin { completionHandler($0 == .OK ? o.urls : nil) }
    }

    func webView(_ w: WKWebView, runJavaScriptAlertPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo,
                 completionHandler: @escaping () -> Void) {
        let a = NSAlert(); a.messageText = m; a.runModal(); completionHandler()
    }

    func webView(_ w: WKWebView, runJavaScriptConfirmPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo,
                 completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert(); a.messageText = m
        a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
        completionHandler(a.runModal() == .alertFirstButtonReturn)
    }

    func webView(_ w: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame f: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let a = NSAlert(); a.messageText = prompt
        a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
        field.stringValue = defaultText ?? ""
        a.accessoryView = field
        completionHandler(a.runModal() == .alertFirstButtonReturn ? field.stringValue : nil)
    }

    // MARK: downloads (the JSON export) go to ~/Downloads and are shown in Finder

    func webView(_ w: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ w: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }

    func download(_ d: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                  completionHandler: @escaping (URL?) -> Void) {
        let fm = FileManager.default
        let dir = fm.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
        let name = suggestedFilename.isEmpty ? "download" : suggestedFilename
        let base = (name as NSString).deletingPathExtension, ext = (name as NSString).pathExtension
        var dest = dir.appendingPathComponent(name), n = 1
        while fm.fileExists(atPath: dest.path) {
            dest = dir.appendingPathComponent(ext.isEmpty ? "\(base) \(n)" : "\(base) \(n).\(ext)")
            n += 1
        }
        lastDownload = dest
        completionHandler(dest)
    }

    func downloadDidFinish(_ d: WKDownload) {
        if let u = lastDownload { NSWorkspace.shared.activateFileViewerSelecting([u]) }
    }
}

let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
