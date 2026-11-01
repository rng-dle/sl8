import Foundation
import SQLite3

typealias Row = [String: Any]
extension Dictionary where Key == String, Value == Any {
    func s(_ k: String) -> String { self[k] as? String ?? "" }
    func i(_ k: String) -> Int { self[k] as? Int ?? 0 }
}

func nowMs() -> Int { Int(Date().timeIntervalSince1970 * 1000) }
private let jsonOpts: JSONSerialization.WritingOptions = [.sortedKeys, .withoutEscapingSlashes]
// Sorted keys everywhere, so the same item always serializes to the same text (that is how "unchanged" is detected).
func jsonData(_ o: Any) -> Data { (try? JSONSerialization.data(withJSONObject: o, options: jsonOpts)) ?? Data("{}".utf8) }
func ser(_ o: Any) -> String { String(decoding: jsonData(o), as: UTF8.self) }
func parse(_ d: Data) -> [String: Any] { ((try? JSONSerialization.jsonObject(with: d)) as? [String: Any]) ?? [:] }
func parse(_ s: String) -> [String: Any] { parse(Data(s.utf8)) }
func jstr(_ s: String) -> String { String(ser([s]).dropFirst().dropLast()) }

func match(_ s: String, _ pattern: String) -> [String]? {
    guard let re = try? NSRegularExpression(pattern: pattern),
          let m = re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) else { return nil }
    return (1..<max(1, m.numberOfRanges)).map { i in
        Range(m.range(at: i), in: s).map { String(s[$0]) } ?? ""
    }
}

enum Paths {
    static let root: URL = {
        let u = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("ThinkSL8")
        try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        return u
    }()
    static let files: URL = {
        let u = root.appendingPathComponent("files")
        try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        return u
    }()
    static var db: String { root.appendingPathComponent("sl8.sqlite").path }
    static var web: URL { Bundle.main.resourceURL!.appendingPathComponent("web") }
}

private let TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

final class DB {
    private var h: OpaquePointer?
    private let lock = NSRecursiveLock()

    init(path: String) {
        guard sqlite3_open_v2(path, &h, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else {
            fatalError("Can't open the local database at \(path)")
        }
        sqlite3_exec(h, """
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=NORMAL;
        CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
        -- state: 0 in step with the server, 1 made here and not on the server yet, 2 title or look changed here
        CREATE TABLE IF NOT EXISTS notes (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, style TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          remote_since INTEGER NOT NULL DEFAULT 0, remote_updated INTEGER NOT NULL DEFAULT 0, state INTEGER NOT NULL DEFAULT 0);
        -- dirty: changed here, not sent yet. src: 1 arrived from the server (the page should hear of it), 0 written by the page
        CREATE TABLE IF NOT EXISTS items (
          note_id TEXT NOT NULL, id TEXT NOT NULL, t INTEGER NOT NULL, data TEXT NOT NULL,
          updated_at INTEGER NOT NULL, dirty INTEGER NOT NULL DEFAULT 0, src INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (note_id, id));
        CREATE TABLE IF NOT EXISTS pending_del (note_id TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (note_id, id));
        CREATE TABLE IF NOT EXISTS tomb (note_id TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, src INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (note_id, id));
        CREATE TABLE IF NOT EXISTS pending_note_del (id TEXT PRIMARY KEY);
        -- pending: 1 added here, not uploaded yet; 2 the server doesn't have it (don't ask again)
        CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, type TEXT NOT NULL, size INTEGER NOT NULL, pending INTEGER NOT NULL DEFAULT 0);
        """, nil, nil, nil)
    }

    @discardableResult
    func run(_ sql: String, _ args: [Any?] = []) -> Int {
        lock.lock(); defer { lock.unlock() }
        var st: OpaquePointer?
        guard sqlite3_prepare_v2(h, sql, -1, &st, nil) == SQLITE_OK else {
            NSLog("sql error: %@ in %@", String(cString: sqlite3_errmsg(h)), sql)
            return 0
        }
        defer { sqlite3_finalize(st) }
        bind(st, args)
        while sqlite3_step(st) == SQLITE_ROW {}
        return Int(sqlite3_changes(h))
    }

    func rows(_ sql: String, _ args: [Any?] = []) -> [Row] {
        lock.lock(); defer { lock.unlock() }
        var st: OpaquePointer?
        guard sqlite3_prepare_v2(h, sql, -1, &st, nil) == SQLITE_OK else {
            NSLog("sql error: %@ in %@", String(cString: sqlite3_errmsg(h)), sql)
            return []
        }
        defer { sqlite3_finalize(st) }
        bind(st, args)
        var out: [Row] = []
        while sqlite3_step(st) == SQLITE_ROW {
            var r: Row = [:]
            for c in 0..<sqlite3_column_count(st) {
                let name = String(cString: sqlite3_column_name(st, c))
                switch sqlite3_column_type(st, c) {
                case SQLITE_INTEGER: r[name] = Int(sqlite3_column_int64(st, c))
                case SQLITE_FLOAT: r[name] = sqlite3_column_double(st, c)
                case SQLITE_TEXT: r[name] = String(cString: sqlite3_column_text(st, c))
                default: break
                }
            }
            out.append(r)
        }
        return out
    }

    func one(_ sql: String, _ args: [Any?] = []) -> Row? { rows(sql, args).first }

    func tx(_ body: () -> Void) {
        lock.lock(); defer { lock.unlock() }
        run("BEGIN"); body(); run("COMMIT")
    }

    private func bind(_ st: OpaquePointer?, _ args: [Any?]) {
        for (i, a) in args.enumerated() {
            let n = Int32(i + 1)
            switch a {
            case .none: sqlite3_bind_null(st, n)
            case .some(let v):
                switch v {
                case let x as Int: sqlite3_bind_int64(st, n, Int64(x))
                case let x as Double: sqlite3_bind_double(st, n, x)
                case let x as String: sqlite3_bind_text(st, n, x, -1, TRANSIENT)
                default: sqlite3_bind_null(st, n)
                }
            }
        }
    }

    func meta(_ k: String) -> String? { one("SELECT v FROM meta WHERE k = ?", [k])?.s("v") }
    func setMeta(_ k: String, _ v: String?) {
        if let v = v { run("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", [k, v]) }
        else { run("DELETE FROM meta WHERE k = ?", [k]) }
    }

    func dropNote(_ id: String) {
        tx {
            for t in ["items", "pending_del", "tomb"] { run("DELETE FROM \(t) WHERE note_id = ?", [id]) }
            run("DELETE FROM notes WHERE id = ?", [id])
        }
    }

    /// Everything on this Mac: used on logout and when a different account signs in.
    func wipe() {
        tx { for t in ["meta", "notes", "items", "pending_del", "tomb", "pending_note_del", "files"] { run("DELETE FROM \(t)") } }
        if let names = try? FileManager.default.contentsOfDirectory(atPath: Paths.files.path) {
            for n in names { try? FileManager.default.removeItem(at: Paths.files.appendingPathComponent(n)) }
        }
    }
}
