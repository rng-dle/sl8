import Foundation

struct RemoteError: Error { let status: Int }

/// The real thinksl8.com. Cookie handled by hand: the session id lives in the local database.
final class Remote {
    static let base = URL(string: "https://thinksl8.com")!
    let db: DB
    let session: URLSession

    init(db: DB) {
        self.db = db
        let cfg = URLSessionConfiguration.ephemeral
        cfg.httpShouldSetCookies = false
        cfg.httpCookieAcceptPolicy = .never
        cfg.timeoutIntervalForRequest = 60
        session = URLSession(configuration: cfg)
    }

    var sid: String? { db.meta("sid") }
    func setSid(_ s: String?) { db.setMeta("sid", s) }

    func urlRequest(_ method: String, _ path: String, body: Data? = nil, type: String? = nil, timeout: TimeInterval = 30) -> URLRequest {
        var req = URLRequest(url: URL(string: path, relativeTo: Remote.base)!.absoluteURL, timeoutInterval: timeout)
        req.httpMethod = method
        req.httpBody = body
        if let t = type { req.setValue(t, forHTTPHeaderField: "Content-Type") }
        if let s = sid { req.setValue("sid=\(s)", forHTTPHeaderField: "Cookie") }
        req.setValue("ThinkSL8-Mac", forHTTPHeaderField: "User-Agent")
        return req
    }

    func request(_ method: String, _ path: String, body: Data? = nil, type: String = "application/json",
                 timeout: TimeInterval = 30) async throws -> (status: Int, data: Data, http: HTTPURLResponse) {
        let (data, resp) = try await session.data(for: urlRequest(method, path, body: body, type: body == nil && method == "GET" ? nil : type, timeout: timeout))
        guard let http = resp as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        return (http.statusCode, data, http)
    }
}

/// Keeps the local database and thinksl8.com in step. Sends what changed here, brings in what changed elsewhere.
/// Same rules as the web app: per item, the last save wins; anything changed here and not sent yet is never overwritten.
final class Sync {
    let db: DB
    let remote: Remote
    var onStatus: ((String) -> Void)?
    private let lock = NSLock()
    private var running = false, again = false

    init(db: DB, remote: Remote) { self.db = db; self.remote = remote }

    func kick(after seconds: Double = 2) {
        DispatchQueue.global().asyncAfter(deadline: .now() + seconds) { Task { await self.run() } }
    }

    private func begin() -> Bool { lock.lock(); defer { lock.unlock() }; if running { again = true; return false }; running = true; return true }
    private func finishRound() -> Bool { lock.lock(); defer { lock.unlock() }; if again { again = false; return true }; running = false; return false }

    func run() async {
        if ProcessInfo.processInfo.environment["SL8_NO_SYNC"] != nil { return } // the smoke test talks to the local API only
        guard begin() else { return }
        repeat { await cycle() } while finishRound()
    }

    private func status(_ s: String) { onStatus?(s) }

    private func cycle() async {
        guard remote.sid != nil else { return status("Not signed in") }
        status("Syncing…")
        do {
            try await push()
            try await pull()
            try await prefetch()
            status("Synced")
        } catch let e as RemoteError {
            if e.status == 401 { remote.setSid(nil); status("Signed out") } else { status("Sync problem, will retry") }
        } catch {
            status("Offline")
        }
    }

    /// Throws for the answers that mean "stop and try later". Any other 4xx means the server refused that change for good.
    private func check(_ s: Int) throws { if s == 401 || s == 429 || s >= 500 { throw RemoteError(status: s) } }

    // MARK: send

    private func push() async throws {
        for r in db.rows("SELECT id FROM pending_note_del") {
            let id = r.s("id")
            try check(try await remote.request("DELETE", "/api/notes/\(id)", body: Data("{}".utf8)).status)
            db.run("DELETE FROM pending_note_del WHERE id = ?", [id])
        }
        for n in db.rows("SELECT id, title, style FROM notes WHERE state = 1") {
            let id = n.s("id"), title = n.s("title"), style = n.s("style")
            try check(try await remote.request("POST", "/api/notes", body: jsonData(["id": id, "title": title, "style": parse(style)])).status)
            db.run("UPDATE notes SET state = CASE WHEN title = ? AND style = ? THEN 0 ELSE 2 END WHERE id = ? AND state = 1", [title, style, id])
        }
        for n in db.rows("SELECT id, title, style FROM notes WHERE state = 2") {
            let id = n.s("id"), title = n.s("title"), style = n.s("style")
            let res = try await remote.request("PATCH", "/api/notes/\(id)", body: jsonData(["title": title, "style": parse(style)]))
            try check(res.status)
            db.run("UPDATE notes SET state = 0 WHERE id = ? AND state = 2 AND title = ? AND style = ?", [id, title, style])
        }
        for f in db.rows("SELECT id, type FROM files WHERE pending = 1") {
            let id = f.s("id")
            guard let bytes = try? Data(contentsOf: Paths.files.appendingPathComponent(id)) else { db.run("UPDATE files SET pending = 0 WHERE id = ?", [id]); continue }
            try check(try await remote.request("POST", "/api/files?id=\(id)", body: bytes, type: f.s("type"), timeout: 180).status)
            db.run("UPDATE files SET pending = 0 WHERE id = ?", [id])
        }
        for n in db.rows("SELECT id FROM notes WHERE state = 0") {
            let nid = n.s("id")
            while true {
                let puts = db.rows("SELECT id, data FROM items WHERE note_id = ? AND dirty > 0 LIMIT 40", [nid])
                let dels = db.rows("SELECT id FROM pending_del WHERE note_id = ? LIMIT ?", [nid, 40 - puts.count])
                if puts.isEmpty && dels.isEmpty { break }
                let ops = puts.map { "{\"put\":\($0.s("data"))}" } + dels.map { "{\"del\":\(jstr($0.s("id")))}" }
                let res = try await remote.request("POST", "/api/notes/\(nid)/ops", body: Data("{\"ops\":[\(ops.joined(separator: ","))],\"tab\":\"mac\"}".utf8))
                if res.status == 404 { db.dropNote(nid); break } // deleted elsewhere
                try check(res.status)
                db.tx {
                    for p in puts { db.run("UPDATE items SET dirty = 0 WHERE note_id = ? AND id = ? AND data = ?", [nid, p.s("id"), p.s("data")]) }
                    for d in dels { db.run("DELETE FROM pending_del WHERE note_id = ? AND id = ?", [nid, d.s("id")]) }
                }
            }
        }
    }

    // MARK: bring in

    private func pull() async throws {
        let res = try await remote.request("GET", "/api/notes")
        try check(res.status)
        guard res.status == 200, let list = parse(res.data)["notes"] as? [[String: Any]] else { throw RemoteError(status: res.status) }
        var remoteIds = Set<String>()
        for n in list {
            guard let id = n["id"] as? String else { continue }
            let upd = (n["updated_at"] as? NSNumber)?.intValue ?? 0
            let title = n["title"] as? String ?? "Untitled"
            remoteIds.insert(id)
            if db.one("SELECT 1 FROM pending_note_del WHERE id = ?", [id]) != nil { continue }
            let local = db.one("SELECT state, remote_updated FROM notes WHERE id = ?", [id])
            if local == nil {
                let now = nowMs()
                db.run("INSERT INTO notes (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)", [id, title, now, upd])
            }
            if local == nil || upd > local!.i("remote_updated") {
                try await pullNote(id, remoteUpdated: upd)
            }
            db.run("UPDATE notes SET title = ?, updated_at = MAX(updated_at, ?) WHERE id = ? AND state = 0", [title, upd, id])
        }
        for n in db.rows("SELECT id FROM notes WHERE state = 0") where !remoteIds.contains(n.s("id")) {
            db.dropNote(n.s("id")) // deleted on another device
        }
    }

    func pullNote(_ id: String, remoteUpdated: Int) async throws {
        let since = db.one("SELECT remote_since FROM notes WHERE id = ?", [id])?.i("remote_since") ?? 0
        var res = try await remote.request("GET", since > 0 ? "/api/notes/\(id)?since=\(since)" : "/api/notes/\(id)")
        if res.status == 404 { return }
        try check(res.status)
        guard res.status == 200 else { throw RemoteError(status: res.status) }
        var obj = parse(res.data), full = since == 0
        if obj["reload"] as? Bool == true { // away too long to catch up: take the whole canvas
            res = try await remote.request("GET", "/api/notes/\(id)")
            try check(res.status)
            guard res.status == 200 else { return }
            obj = parse(res.data); full = true
        }
        apply(id, obj, full: full, remoteUpdated: remoteUpdated)
    }

    private func apply(_ id: String, _ obj: [String: Any], full: Bool, remoteUpdated: Int) {
        let now = nowMs()
        db.tx {
            var seen = Set<String>()
            for it in obj["items"] as? [[String: Any]] ?? [] {
                guard let iid = it["id"] as? String else { continue }
                seen.insert(iid)
                let data = ser(it), t = Int((it["t"] as? NSNumber)?.doubleValue ?? 0)
                if let cur = db.one("SELECT data, dirty FROM items WHERE note_id = ? AND id = ?", [id, iid]),
                   cur.i("dirty") > 0 || cur.s("data") == data { continue }
                db.run("""
                    INSERT INTO items (note_id, id, t, data, updated_at, dirty, src) VALUES (?, ?, ?, ?, ?, 0, 1)
                    ON CONFLICT (note_id, id) DO UPDATE SET t = excluded.t, data = excluded.data, updated_at = excluded.updated_at, dirty = 0, src = 1
                    """, [id, iid, t, data, now])
                db.run("DELETE FROM tomb WHERE note_id = ? AND id = ?", [id, iid])
            }
            var gone = obj["gone"] as? [String] ?? []
            if full {
                gone += db.rows("SELECT id FROM items WHERE note_id = ? AND dirty = 0", [id]).map { $0.s("id") }.filter { !seen.contains($0) }
            }
            for g in gone where db.one("SELECT 1 FROM items WHERE note_id = ? AND id = ? AND dirty > 0", [id, g]) == nil {
                if db.run("DELETE FROM items WHERE note_id = ? AND id = ?", [id, g]) > 0 {
                    db.run("INSERT OR REPLACE INTO tomb (note_id, id, at, src) VALUES (?, ?, ?, 1)", [id, g, now])
                }
            }
            if full, let note = obj["note"] as? [String: Any], let style = note["style"] {
                db.run("UPDATE notes SET style = ? WHERE id = ? AND state = 0", [ser(style), id])
            }
            let rs = (obj["now"] as? NSNumber)?.intValue ?? 0
            db.run("UPDATE notes SET remote_since = ?, remote_updated = ? WHERE id = ?", [rs, remoteUpdated, id])
        }
    }

    // MARK: photos, videos, recordings: keep a copy of everything the canvases use

    func fetchFile(_ id: String) async -> Bool {
        guard let res = try? await remote.request("GET", "/api/files/\(id)", timeout: 120) else { return false }
        if res.status == 404 { db.run("INSERT OR REPLACE INTO files (id, type, size, pending) VALUES (?, '', 0, 2)", [id]); return false }
        guard res.status == 200, (try? res.data.write(to: Paths.files.appendingPathComponent(id))) != nil else { return false }
        let type = res.http.value(forHTTPHeaderField: "Content-Type") ?? "application/octet-stream"
        db.run("INSERT OR REPLACE INTO files (id, type, size, pending) VALUES (?, ?, ?, 0)", [id, type, res.data.count])
        return true
    }

    private func prefetch() async throws {
        let wanted = db.rows("""
            SELECT json_extract(data, '$.file') AS f FROM items WHERE json_extract(data, '$.file') IS NOT NULL
            UNION SELECT json_extract(style, '$.image') FROM notes WHERE json_extract(style, '$.image') IS NOT NULL
            """).map { $0.s("f") }
        let missing = wanted.filter { !$0.isEmpty && db.one("SELECT 1 FROM files WHERE id = ?", [$0]) == nil }
        for id in missing.prefix(25) { _ = await fetchFile(id) }
    }
}
