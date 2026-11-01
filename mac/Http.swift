import Foundation
import Network

struct Req {
    var method: String
    var path: String
    var rawQuery: String?
    var query: [String: String]
    var headers: [String: String] // lowercased names
    var body: Data
}

struct Resp {
    var status: Int = 200
    var headers: [String: String] = [:]
    var body: Data = Data()
}

private let reasons = [200: "OK", 201: "Created", 206: "Partial Content", 302: "Found", 400: "Bad Request", 401: "Unauthorized",
                       403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 409: "Conflict", 413: "Payload Too Large",
                       415: "Unsupported Media Type", 416: "Range Not Satisfiable", 429: "Too Many Requests",
                       500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable"]

final class Conn {
    private let c: NWConnection
    private var chunked = false
    init(_ c: NWConnection) { self.c = c }

    private func head(_ status: Int, _ h: [String: String], length: Int?) -> Data {
        var s = "HTTP/1.1 \(status) \(reasons[status] ?? "OK")\r\n"
        for (k, v) in h { s += "\(k): \(v)\r\n" }
        s += length.map { "Content-Length: \($0)\r\n" } ?? "Transfer-Encoding: chunked\r\n"
        s += "X-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n"
        return Data(s.utf8)
    }

    func send(_ r: Resp) {
        var out = head(r.status, r.headers, length: r.body.count)
        out.append(r.body)
        c.send(content: out, completion: .contentProcessed { [c] _ in c.cancel() })
    }

    func startStream(_ status: Int, _ h: [String: String]) {
        chunked = true
        c.send(content: head(status, h, length: nil), completion: .contentProcessed { _ in })
    }

    func stream(_ d: Data) {
        guard chunked, !d.isEmpty else { return }
        var out = Data(String(d.count, radix: 16).utf8)
        out.append(contentsOf: [13, 10]); out.append(d); out.append(contentsOf: [13, 10])
        c.send(content: out, completion: .contentProcessed { _ in })
    }

    func finish() {
        c.send(content: Data("0\r\n\r\n".utf8), completion: .contentProcessed { [c] _ in c.cancel() })
    }
}

/// A tiny HTTP server on 127.0.0.1 for the app's own window. A real http origin (not a custom scheme) so the web view treats
/// the page as a secure context: microphone, clipboard and so on work. Only this app's window holds the launch cookie.
final class HttpServer {
    let token = ProcessInfo.processInfo.environment["SL8_TEST_TOKEN"] ?? (UUID().uuidString + UUID().uuidString)
    private(set) var port: UInt16 = 0
    private var listener: NWListener?
    private let queue = DispatchQueue(label: "sl8.http")
    var handler: ((Req, Conn) -> Void)?

    private final class Flag { var ok = false }

    func start(ports: ClosedRange<UInt16>) -> Bool {
        for p in ports {
            let params = NWParameters.tcp
            params.requiredInterfaceType = .loopback
            params.allowLocalEndpointReuse = true
            guard let port = NWEndpoint.Port(rawValue: p), let l = try? NWListener(using: params, on: port) else { continue }
            let sem = DispatchSemaphore(value: 0), flag = Flag()
            l.newConnectionHandler = { [weak self] c in self?.accept(c) }
            l.stateUpdateHandler = { st in
                switch st {
                case .ready: flag.ok = true; sem.signal()
                case .failed, .cancelled: sem.signal()
                default: break
                }
            }
            l.start(queue: queue)
            _ = sem.wait(timeout: .now() + 3)
            if flag.ok { listener = l; self.port = p; return true }
            l.cancel()
        }
        return false
    }

    private enum Parsed { case need, bad(Int), ready(Req) }

    private func accept(_ c: NWConnection) {
        c.start(queue: queue)
        var buf = Data()
        func more() {
            c.receive(minimumIncompleteLength: 1, maximumLength: 1 << 16) { [weak self] data, _, done, err in
                guard let self = self else { return }
                if let d = data { buf.append(d) }
                if err != nil { c.cancel(); return }
                switch self.parse(buf) {
                case .need: if done { c.cancel() } else { more() }
                case .bad(let code): Conn(c).send(Resp(status: code))
                case .ready(let req): self.dispatch(req, Conn(c))
                }
            }
        }
        more()
    }

    private func parse(_ buf: Data) -> Parsed {
        guard let end = buf.range(of: Data([13, 10, 13, 10])) else { return buf.count > 65536 ? .bad(400) : .need }
        let lines = String(decoding: buf[buf.startIndex..<end.lowerBound], as: UTF8.self).components(separatedBy: "\r\n")
        let first = lines[0].split(separator: " ")
        guard first.count >= 2 else { return .bad(400) }
        var headers: [String: String] = [:]
        for l in lines.dropFirst() {
            guard let i = l.firstIndex(of: ":") else { continue }
            headers[l[..<i].lowercased()] = l[l.index(after: i)...].trimmingCharacters(in: .whitespaces)
        }
        let len = Int(headers["content-length"] ?? "0") ?? 0
        if len < 0 || len > 40_000_000 { return .bad(413) }
        let start = end.upperBound - buf.startIndex
        if buf.count - start < len { return .need }
        let body = Data(buf[(buf.startIndex + start)..<(buf.startIndex + start + len)])
        guard let comps = URLComponents(string: String(first[1])) else { return .bad(400) }
        var q: [String: String] = [:]
        for i in comps.queryItems ?? [] { q[i.name] = i.value ?? "" }
        return .ready(Req(method: String(first[0]), path: comps.path, rawQuery: comps.percentEncodedQuery,
                          query: q, headers: headers, body: body))
    }

    private func dispatch(_ r: Req, _ c: Conn) {
        guard r.headers["host"] == "127.0.0.1:\(port)" else { return c.send(Resp(status: 403)) } // not a rebinding page
        if r.path == "/__open" {
            guard r.query["k"] == token else { return c.send(Resp(status: 403)) }
            return c.send(Resp(status: 302, headers: ["Location": "/", "Set-Cookie": "sl8k=\(token); Path=/; HttpOnly; SameSite=Strict"]))
        }
        guard (r.headers["cookie"] ?? "").contains("sl8k=\(token)") else { return c.send(Resp(status: 403)) }
        handler?(r, c)
    }
}
