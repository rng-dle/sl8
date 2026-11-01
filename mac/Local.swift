import Foundation

func jr(_ o: Any, _ status: Int = 200) -> Resp {
    Resp(status: status, headers: ["Content-Type": "application/json", "Cache-Control": "no-store"], body: jsonData(o))
}
func raw(_ s: String, _ status: Int = 200) -> Resp {
    Resp(status: status, headers: ["Content-Type": "application/json", "Cache-Control": "no-store"], body: Data(s.utf8))
}
func fail(_ status: Int, _ message: String) -> Resp { jr(["error": message], status) }

private let offlineMsg = "Can't reach ThinkSL8. Check your connection and try again."
private let day = 86_400_000
private let fileId = "^[0-9a-f-]{36}$"

/// What the web app's own pages talk to. Notes, search and files are answered from the local database (so they work offline);
/// accounts, sharing, AI, the marketplace and the rest go straight through to thinksl8.com.
final class Local {
    let db: DB
    let remote: Remote
    let sync: Sync

    init(db: DB, remote: Remote, sync: Sync) { self.db = db; self.remote = remote; self.sync = sync }

    func handle(_ r: Req, _ c: Conn) async {
        guard r.path.hasPrefix("/api/") else { return c.send(staticFile(r)) }
        if r.method == "GET" && r.path == "/api/config" { return c.send(jr(["botCheck": NSNull()])) }
        if let resp = await localRoute(r) { return c.send(resp) }
        await proxy(r, c)
    }

    // MARK: local routes

    private func localRoute(_ r: Req) async -> Resp? {
        let p = r.path, m = r.method
        let noteRoute = match(p, "^/api/notes/([\\w-]{1,64})(/ops)?$")
        let isLocal = (m == "GET" && ["/api/me", "/api/notes", "/api/search"].contains(p))
            || (m == "POST" && ["/api/notes", "/api/files"].contains(p))
            || noteRoute != nil
            || (m == "GET" && match(p, "^/api/files/([0-9a-f-]{36})$") != nil)
        guard isLocal else { return nil }
        guard remote.sid != nil else { return fail(401, "Log in first.") }
        let body = parse(r.body)
        if p == "/api/me" { return await me() }
        if p == "/api/notes" { return m == "GET" ? listNotes() : await createNote(body) }
        if p == "/api/files" { return await uploadFile(r) }
        if p == "/api/search" { return search(r.query["q"] ?? "") }
        if let nr = noteRoute {
            let id = nr[0], ops = nr[1] == "/ops"
            if ops { return m == "POST" ? noteOps(id, body) : fail(404, "Not found.") }
            switch m {
            case "GET": return noteGet(id, since: Int(r.query["since"] ?? ""))
            case "PATCH": return notePatch(id, body)
            case "DELETE": return noteDelete(id)
            default: return nil
            }
        }
        if let f = match(p, "^/api/files/([0-9a-f-]{36})$") { return await fileGet(r, f[0]) }
        return nil
    }

    private func me() async -> Resp {
        var obj: [String: Any] = [:]
        if let res = try? await remote.request("GET", "/api/me", timeout: 3) {
            if res.status == 200 { obj = parse(res.data); db.setMeta("me", ser(obj)) }
            else if res.status == 401 { remote.setSid(nil); return fail(401, "Log in again.") }
        }
        if obj.isEmpty { obj = parse(db.meta("me") ?? "{}") }
        if obj.isEmpty { obj = ["email": db.meta("email") ?? "", "onboarded": true, "verified": true] }
        obj["lastNoteId"] = db.one("SELECT id FROM notes ORDER BY updated_at DESC LIMIT 1")?.s("id") ?? NSNull()
        return jr(obj)
    }

    private func listNotes() -> Resp {
        jr(["notes": db.rows("SELECT id, title, updated_at FROM notes ORDER BY updated_at DESC")])
    }

    private func createNote(_ b: [String: Any]) async -> Resp {
        let now = nowMs()
        if b["sample"] as? Bool == true, // the sample canvas lives on the server; use it when we can reach it
           let res = try? await remote.request("POST", "/api/notes", body: jsonData(["sample": true]), timeout: 8), res.status == 201,
           let n = parse(res.data)["note"] as? [String: Any], let id = n["id"] as? String {
            let title = n["title"] as? String ?? "Start here"
            db.run("INSERT OR IGNORE INTO notes (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)", [id, title, now, now])
            try? await sync.pullNote(id, remoteUpdated: (n["updated_at"] as? NSNumber)?.intValue ?? 0)
            return jr(["note": ["id": id, "title": title, "updated_at": now]], 201)
        }
        var id = UUID().uuidString.lowercased()
        if let w = b["id"] as? String, match(w, fileId) != nil { id = w }
        if let had = db.one("SELECT id, title, updated_at FROM notes WHERE id = ?", [id]) { return jr(["note": had]) }
        var title = b["sample"] as? Bool == true ? "Start here" : String(((b["title"] as? String) ?? "").prefix(200))
        if title.isEmpty { title = "Untitled" }
        let style = b["style"] as? [String: Any] ?? [:]
        db.run("INSERT INTO notes (id, title, style, created_at, updated_at, state) VALUES (?, ?, ?, ?, ?, 1)", [id, title, ser(style), now, now])
        sync.kick()
        return jr(["note": ["id": id, "title": title, "updated_at": now]], 201)
    }

    private func noteGet(_ id: String, since: Int?) -> Resp {
        guard let n = db.one("SELECT id, title, style, updated_at FROM notes WHERE id = ?", [id]) else { return fail(404, "Note not found.") }
        let now = nowMs()
        if let since = since, since > 0 {
            if now - since > day { return jr(["now": now, "reload": true]) }
            let after = since - 5000
            let items = db.rows("SELECT data FROM items WHERE note_id = ? AND updated_at > ? AND src = 1", [id, after])
            let gone = db.rows("SELECT id FROM tomb WHERE note_id = ? AND at > ? AND src = 1 AND id NOT IN (SELECT id FROM items WHERE note_id = ?)", [id, after, id])
            return raw("{\"now\":\(now),\"gone\":\(ser(gone.map { $0.s("id") })),\"items\":[\(items.map { $0.s("data") }.joined(separator: ","))]}")
        }
        let items = db.rows("SELECT data FROM items WHERE note_id = ? ORDER BY t, id", [id])
        let note: [String: Any] = ["id": id, "title": n.s("title"), "updated_at": n.i("updated_at"), "style": parse(n.s("style"))]
        return raw("{\"now\":\(now),\"note\":\(ser(note)),\"items\":[\(items.map { $0.s("data") }.joined(separator: ","))]}")
    }

    private func noteOps(_ id: String, _ b: [String: Any]) -> Resp {
        guard db.one("SELECT 1 FROM notes WHERE id = ?", [id]) != nil else { return fail(404, "Note not found.") }
        guard let ops = b["ops"] as? [[String: Any]], ops.count <= 40 else { return fail(400, "Send between 0 and 40 changes at a time.") }
        let now = nowMs()
        var bad = false
        db.tx {
            for op in ops {
                if let d = op["del"] as? String {
                    db.run("DELETE FROM items WHERE note_id = ? AND id = ?", [id, d])
                    db.run("INSERT OR REPLACE INTO tomb (note_id, id, at, src) VALUES (?, ?, ?, 0)", [id, d, now])
                    db.run("INSERT OR IGNORE INTO pending_del (note_id, id) VALUES (?, ?)", [id, d])
                } else if let it = op["put"] as? [String: Any], let iid = it["id"] as? String, let t = (it["t"] as? NSNumber)?.doubleValue {
                    db.run("""
                        INSERT INTO items (note_id, id, t, data, updated_at, dirty, src) VALUES (?, ?, ?, ?, ?, 1, 0)
                        ON CONFLICT (note_id, id) DO UPDATE SET t = excluded.t, data = excluded.data, updated_at = excluded.updated_at, dirty = 1, src = 0
                        """, [id, iid, Int(t), ser(it), now])
                    db.run("DELETE FROM tomb WHERE note_id = ? AND id = ?", [id, iid])
                    db.run("DELETE FROM pending_del WHERE note_id = ? AND id = ?", [id, iid])
                } else { bad = true }
            }
            db.run("UPDATE notes SET updated_at = ? WHERE id = ?", [now, id])
        }
        if bad { return fail(400, "One of the changes was malformed.") }
        sync.kick()
        return jr(["ok": true])
    }

    private func notePatch(_ id: String, _ b: [String: Any]) -> Resp {
        guard db.one("SELECT 1 FROM notes WHERE id = ?", [id]) != nil else { return fail(404, "Note not found.") }
        var out: [String: Any] = [:]
        let now = nowMs()
        if let t = b["title"] {
            var title = String("\(t)".trimmingCharacters(in: .whitespacesAndNewlines).prefix(200))
            if title.isEmpty { title = "Untitled" }
            out["title"] = title
            db.run("UPDATE notes SET title = ?, updated_at = ? WHERE id = ?", [title, now, id])
        }
        if let s = b["style"] as? [String: Any] {
            out["style"] = s
            db.run("UPDATE notes SET style = ?, updated_at = ? WHERE id = ?", [ser(s), now, id])
        }
        db.run("UPDATE notes SET state = 2 WHERE id = ? AND state = 0", [id])
        sync.kick()
        return jr(out)
    }

    private func noteDelete(_ id: String) -> Resp {
        guard let n = db.one("SELECT state FROM notes WHERE id = ?", [id]) else { return fail(404, "Note not found.") }
        if n.i("state") != 1 { db.run("INSERT OR IGNORE INTO pending_note_del (id) VALUES (?)", [id]) }
        db.dropNote(id)
        sync.kick()
        return jr(["ok": true])
    }

    private func search(_ q: String) -> Resp {
        let term = String(q.prefix(200)).trimmingCharacters(in: .whitespaces)
        if term.isEmpty { return jr(["results": [], "canvases": []]) }
        let like = "%" + term.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "%", with: "\\%").replacingOccurrences(of: "_", with: "\\_") + "%"
        let hits = db.rows("""
            SELECT i.id AS id, i.note_id AS noteId, n.title AS title, i.updated_at AS updated, json_extract(i.data, '$.text') AS text
            FROM items i JOIN notes n ON n.id = i.note_id
            WHERE json_extract(i.data, '$.text') LIKE ? ESCAPE '\\' ORDER BY i.updated_at DESC LIMIT 30
            """, [like])
        let results: [[String: Any]] = hits.map { h in
            ["id": h.s("id"), "noteId": h.s("noteId"), "title": h.s("title"), "updated": h.i("updated"), "snippet": snippet(h.s("text"), term)]
        }
        let canvases = db.rows("SELECT id, title, updated_at FROM notes WHERE title LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT 10", [like])
        return jr(["results": results, "canvases": canvases])
    }

    private func snippet(_ text: String, _ q: String) -> String {
        guard let r = text.range(of: q, options: [.caseInsensitive, .diacriticInsensitive]) else { return String(text.prefix(80)) }
        let lo = text.index(r.lowerBound, offsetBy: -40, limitedBy: text.startIndex) ?? text.startIndex
        let hi = text.index(r.upperBound, offsetBy: 40, limitedBy: text.endIndex) ?? text.endIndex
        let head = lo > text.startIndex ? "…" : "", tail = hi < text.endIndex ? "…" : ""
        return "\(head)\(text[lo..<r.lowerBound])\u{01}\(text[r.lowerBound..<r.upperBound])\u{02}\(text[r.upperBound..<hi])\(tail)"
    }

    // MARK: files

    private func sniff(_ d: Data, _ clientType: String) -> (type: String, image: Bool)? {
        let b = [UInt8](d.prefix(16))
        func at(_ i: Int, _ s: String) -> Bool { b.count >= i + s.utf8.count && Array(b[i..<(i + s.utf8.count)]) == Array(s.utf8) }
        if b.starts(with: [0xFF, 0xD8, 0xFF]) { return ("image/jpeg", true) }
        if b.starts(with: [0x89, 0x50, 0x4E, 0x47]) { return ("image/png", true) }
        if at(0, "GIF8") { return ("image/gif", true) }
        if at(0, "RIFF") && at(8, "WEBP") { return ("image/webp", true) }
        if at(0, "RIFF") && at(8, "WAVE") { return ("audio/wav", false) }
        if at(4, "ftyp") { return (at(8, "M4A ") ? "audio/mp4" : at(8, "qt  ") ? "video/quicktime" : "video/mp4", false) }
        if b.starts(with: [0x1A, 0x45, 0xDF, 0xA3]) { return (clientType.hasPrefix("audio/") ? "audio/webm" : "video/webm", false) }
        if at(0, "OggS") { return ("audio/ogg", false) }
        if at(0, "ID3") || b.starts(with: [0xFF, 0xFB]) || b.starts(with: [0xFF, 0xF3]) || b.starts(with: [0xFF, 0xF2]) { return ("audio/mpeg", false) }
        return nil
    }

    private func uploadFile(_ r: Req) async -> Resp {
        guard let (type, image) = sniff(r.body, r.headers["content-type"] ?? "") else {
            return fail(415, "Use a photo (JPEG, PNG, WebP or GIF), a video (MP4, MOV or WebM) or a voice recording.")
        }
        if image && r.body.count > 3_000_000 { return fail(413, "That image is over 3 MB. Try a smaller one.") }
        if !image && r.body.count > 25_000_000 { return fail(413, "Videos can be up to 25 MB for now, about 20 to 30 seconds from a phone.") }
        let id = UUID().uuidString.lowercased()
        guard (try? r.body.write(to: Paths.files.appendingPathComponent(id))) != nil else { return fail(500, "Couldn't save that file on this Mac.") }
        db.run("INSERT INTO files (id, type, size, pending) VALUES (?, ?, ?, 1)", [id, type, r.body.count])
        sync.kick()
        return jr(["id": id], 201)
    }

    private func fileGet(_ r: Req, _ id: String) async -> Resp {
        var row = db.one("SELECT type, size, pending FROM files WHERE id = ?", [id])
        if row == nil, await sync.fetchFile(id) { row = db.one("SELECT type, size, pending FROM files WHERE id = ?", [id]) }
        guard let f = row, f.i("pending") != 2, let data = try? Data(contentsOf: Paths.files.appendingPathComponent(id)) else {
            return fail(404, "File not found.")
        }
        var h = ["Content-Type": f.s("type"), "Cache-Control": "private, max-age=31536000, immutable",
                 "Content-Security-Policy": "default-src 'none'", "Accept-Ranges": "bytes"]
        let size = data.count
        if let rg = r.headers["range"], rg.hasPrefix("bytes=") {
            let parts = rg.dropFirst(6).split(separator: "-", omittingEmptySubsequences: false).map(String.init)
            if parts.count == 2, !(parts[0].isEmpty && parts[1].isEmpty) {
                let start = parts[0].isEmpty ? max(0, size - (Int(parts[1]) ?? 0)) : (Int(parts[0]) ?? 0)
                let end = (!parts[0].isEmpty && !parts[1].isEmpty) ? min(Int(parts[1]) ?? 0, size - 1) : size - 1
                if start >= size || start > end { return Resp(status: 416, headers: ["Content-Range": "bytes */\(size)"]) }
                h["Content-Range"] = "bytes \(start)-\(end)/\(size)"
                return Resp(status: 206, headers: h, body: Data(data[start...end]))
            }
        }
        return Resp(status: 200, headers: h, body: data)
    }

    // MARK: static pages, bundled in the app

    private func mime(_ ext: String) -> String {
        switch ext.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json"
        case "webmanifest": return "application/manifest+json"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "ico": return "image/x-icon"
        case "txt": return "text/plain; charset=utf-8"
        case "mp3": return "audio/mpeg"
        case "woff2": return "font/woff2"
        default: return "application/octet-stream"
        }
    }

    private func staticFile(_ r: Req) -> Resp {
        guard r.method == "GET" else { return Resp(status: 405) }
        let p = r.path
        if p.contains("..") { return Resp(status: 404) }
        let candidates = p.hasSuffix("/") ? [p + "index.html"] : [p, p + ".html", p + "/index.html"]
        for cand in candidates {
            let u = Paths.web.appendingPathComponent(String(cand.drop(while: { $0 == "/" })))
            var dir: ObjCBool = false
            if FileManager.default.fileExists(atPath: u.path, isDirectory: &dir), !dir.boolValue, let d = try? Data(contentsOf: u) {
                return Resp(headers: ["Content-Type": mime(u.pathExtension), "Cache-Control": "no-cache"], body: d)
            }
        }
        let page = (try? Data(contentsOf: Paths.web.appendingPathComponent("404.html"))) ?? Data("Not found".utf8)
        return Resp(status: 404, headers: ["Content-Type": "text/html; charset=utf-8"], body: page)
    }

    // MARK: everything else goes to thinksl8.com

    private func proxy(_ r: Req, _ c: Conn) async {
        let path = r.path + (r.rawQuery.map { "?" + $0 } ?? "")
        var req = remote.urlRequest(r.method, path, body: r.body.isEmpty ? nil : r.body, type: r.headers["content-type"], timeout: 60)
        if let rg = r.headers["range"] { req.setValue(rg, forHTTPHeaderField: "Range") }
        if let a = r.headers["accept"] { req.setValue(a, forHTTPHeaderField: "Accept") }
        var started = false
        do {
            let (bytes, resp) = try await remote.session.bytes(for: req)
            guard let h = resp as? HTTPURLResponse else { throw URLError(.badServerResponse) }
            accountEffects(r, h)
            var out: [String: String] = [:]
            for k in ["Content-Type", "Content-Disposition", "Content-Range", "Accept-Ranges", "Cache-Control"] {
                if let v = h.value(forHTTPHeaderField: k) { out[k] = v }
            }
            started = true
            c.startStream(h.statusCode, out)
            var buf = Data()
            for try await b in bytes {
                buf.append(b)
                if b == 10 || buf.count >= 8192 { c.stream(buf); buf.removeAll(keepingCapacity: true) }
            }
            c.stream(buf)
            c.finish()
        } catch {
            if started { c.finish() } else { c.send(fail(503, offlineMsg)) }
        }
    }

    /// Signing in stores the session here; signing out (or a different account signing in) clears this Mac.
    private func accountEffects(_ r: Req, _ h: HTTPURLResponse) {
        let ok = (200...201).contains(h.statusCode)
        switch r.path {
        case "/api/login", "/api/signup":
            guard ok, let setCookie = h.value(forHTTPHeaderField: "Set-Cookie"),
                  let sid = match(setCookie, "sid=([^;]+)")?.first, !sid.isEmpty else { return }
            let email = (parse(r.body)["email"] as? String ?? "").lowercased()
            if let prev = db.meta("email"), prev != email { db.wipe() }
            db.setMeta("email", email)
            db.setMeta("sid", sid)
            sync.kick(after: 0.5)
        case "/api/logout", "/api/logout-all", "/api/account/delete":
            if ok { db.wipe() }
        default: break
        }
    }
}
