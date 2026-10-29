import Foundation

/// Client for the dsh-menubar WebSocket carrier.
///
/// Frames are one JSON object per text message, discriminated by `t`:
///   hello -> hello.ok, rpc -> rpc.result, ping -> pong.
///
/// The token comes from the 0600 file the host plugin persists, so connecting
/// never asks the user for anything and survives every DSH restart.
final class MenubarClient {

    struct BridgeError: LocalizedError {
        let code: String
        let message: String
        var errorDescription: String? { "\(code): \(message)" }
    }

    private let tokenPath: String
    private let cookieName = "DSHMenubar"
    private var task: URLSessionWebSocketTask?
    private var receiveLoop: Task<Void, Never>?
    private var pending: [String: CheckedContinuation<Any, Error>] = [:]
    private var handshake: CheckedContinuation<Void, Error>?
    private var nextID = 0
    private let lock = NSLock()

    /// Outbound frames waiting their turn. URLSessionWebSocketTask permits only
    /// one outstanding send; issuing a second one while the first is in flight
    /// corrupts the task, after which every later send fails with
    /// "Message too long" — even a 60-byte frame. One serialized pump avoids it.
    private var sendQueue: [String] = []
    private var sending = false

    private(set) var workspacePath: String = ""
    private(set) var hostURL: URL?
    /// Absolute websocket URL of the live socket, for the page to reconnect.
    private(set) var connectedURL: String?
    /// Full discovery payload, including the host's pre-authenticated app URL.
    private(set) var discoveryPayload: [String: Any] = [:]

    init(tokenPath: String = (NSHomeDirectory() as NSString).appendingPathComponent(".dsh/menubar-token")) {
        self.tokenPath = tokenPath
    }

    var tokenFileExists: Bool {
        FileManager.default.fileExists(atPath: tokenPath)
    }

    // MARK: - Connection

    /// Discover the bridge URL, open the socket, and complete the hello handshake.
    func connect() async throws {
        let wsURL = try await discover()
        let token = try readToken()

        task?.cancel(with: .goingAway, reason: nil)
        let socket = URLSession.shared.webSocketTask(with: wsURL)
        // `session.list` returns every session on the host (1000+) as one JSON
        // frame. The default 1 MB receive ceiling rejects it with "Message too
        // long" and poisons the task, so raise it well past that.
        socket.maximumMessageSize = 64 * 1024 * 1024
        task = socket
        hostURL = wsURL
        connectedURL = wsURL.absoluteString
        socket.resume()
        startReceiveLoop(socket)

        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            lock.lock()
            handshake = cont
            lock.unlock()
            send(["t": "hello", "token": token, "client": "DSHMenubar"])
            // Guard against a peer that never answers.
            DispatchQueue.global().asyncAfter(deadline: .now() + 8) { [weak self] in
                self?.failHandshake(BridgeError(code: "timeout", message: "no hello.ok within 8s"))
            }
        }
    }

    func disconnect() {
        receiveLoop?.cancel()
        receiveLoop = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        failAll(BridgeError(code: "closed", message: "bridge disconnected"))
        failHandshake(BridgeError(code: "closed", message: "bridge disconnected"))
    }

    // MARK: - Discovery

    /// Ask the host's discovery route for the live bridge URL.
    ///
    /// Candidates cover the CLI default and the ports the host has been seen
    /// on; the persisted path is the last resort so a pinned 3080 still works
    /// when the discovery route is missing.
    private func discover() async throws -> URL {
        var candidates: [URL] = []
        for port in [3080, 3081, 3090] {
            if let url = URL(string: "http://127.0.0.1:\(port)/menubar/bridge-config") { candidates.append(url) }
        }
        for candidate in candidates {
            var request = URLRequest(url: candidate)
            request.timeoutInterval = 2
            guard let (data, response) = try? await URLSession.shared.data(for: request),
                  let http = response as? HTTPURLResponse, http.statusCode == 200,
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let wsString = object["wsUrl"] as? String,
                  let wsURL = URL(string: wsString)
            else { continue }
            if let workspace = object["workspacePath"] as? String { workspacePath = workspace }
            discoveryPayload = object
            return wsURL
        }
        guard let fallback = URL(string: "ws://127.0.0.1:3080/menubar/bridge") else {
            throw BridgeError(code: "discovery", message: "no usable bridge URL")
        }
        return fallback
    }

    /// Token the bridge persists; shared with the page so it can own the socket.
    func sharedToken() throws -> String { try readToken() }

    private func readToken() throws -> String {
        guard let raw = try? String(contentsOfFile: tokenPath, encoding: .utf8) else {
            throw BridgeError(code: "no-token", message: "missing \(tokenPath); is dsh-menubar installed in the web profile?")
        }
        let token = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else {
            throw BridgeError(code: "no-token", message: "empty \(tokenPath)")
        }
        return token
    }

    // MARK: - RPC

    @discardableResult
    func rpc(_ method: String, _ payload: [String: Any] = [:], timeout: TimeInterval = 120) async throws -> Any {
        let id: String = {
            lock.lock()
            nextID += 1
            let value = "swift-\(nextID)"
            lock.unlock()
            return value
        }()
        return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Any, Error>) in
            lock.lock()
            pending[id] = cont
            lock.unlock()
            send(["t": "rpc", "id": id, "method": method, "payload": payload])
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { [weak self] in
                self?.resolve(id, .failure(BridgeError(code: "timeout", message: "\(method) timed out")))
            }
        }
    }

    // MARK: - High-level ask

    /// One model the host offers, flattened out of its provider groups.
    struct ModelChoice {
        let provider: String
        let model: String
        let label: String
    }

    /// One recent session offered in the picker, named the way the GUI names it.
    struct SessionChoice {
        let id: String
        /// The host's own session title (LLM-generated), when it has one yet.
        let title: String?
        let label: String
    }

    /// The host projects a generated title per session; it is absent only for
    /// sessions that never completed a turn.
    private static func sessionTitle(from item: [String: Any]) -> String? {
        guard let projections = item["projections"] as? [String: Any],
              let values = projections["values"] as? [String: Any],
              let title = values["title"] as? String
        else { return nil }
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func truncate(_ text: String, _ limit: Int) -> String {
        text.count <= limit ? text : String(text.prefix(limit - 1)) + "…"
    }

    private func createSession() async throws -> String {
        let value = try await rpc("session.create", [:])
        guard let object = value as? [String: Any], let sessionID = object["sessionId"] as? String else {
            throw BridgeError(code: "create", message: "session.create returned no sessionId")
        }
        return sessionID
    }

    /// Ask one question and return the answer plus the session it landed in.
    ///
    /// A nil `sessionID` starts a fresh session; a non-nil one continues that
    /// thread. This is the whole "new by default, or pick one" contract: the
    /// caller decides, the client never guesses.
    func ask(_ text: String,
             sessionID: String?,
             model: (provider: String, model: String)? = nil) async throws -> (answer: String, sessionID: String) {
        if let existing = sessionID {
            if let model {
                try? await selectModel(sessionID: existing, provider: model.provider, model: model.model)
            }
            let baseline = try await assistantCount(sessionID: existing)
            do {
                _ = try await rpc("session.prompt", ["sessionId": existing, "text": text])
                let answer = try await waitForAnswer(sessionID: existing, baseline: baseline)
                return (answer, existing)
            } catch let error as BridgeError where error.code == "timeout" {
                throw error
            } catch {
                // A pinned session can disappear (deleted in the GUI, fresh
                // DSH home). Fall through once to a brand-new session instead
                // of failing the ask outright.
                let fresh = try await createSession()
                if let model {
                    try? await selectModel(sessionID: fresh, provider: model.provider, model: model.model)
                }
                _ = try await rpc("session.prompt", ["sessionId": fresh, "text": text])
                let answer = try await waitForAnswer(sessionID: fresh, baseline: 0)
                return (answer, fresh)
            }
        }
        let fresh = try await createSession()
        if let model {
            try? await selectModel(sessionID: fresh, provider: model.provider, model: model.model)
        }
        _ = try await rpc("session.prompt", ["sessionId": fresh, "text": text])
        let answer = try await waitForAnswer(sessionID: fresh, baseline: 0)
        return (answer, fresh)
    }

    /// Switch one session onto an explicit provider route before asking.
    func selectModel(sessionID: String, provider: String, model: String) async throws {
        _ = try await rpc("session.selectModel", [
            "sessionId": sessionID,
            "provider": provider,
            "model": model,
        ], timeout: 30)
        debugLog("model set \(provider)/\(model) on \(sessionID)")
    }

    /// Every model the host advertises, flattened for a menu.
    func models() async throws -> [ModelChoice] {
        let value = try await rpc("session.models", [:], timeout: 60)
        guard let object = value as? [String: Any],
              let groups = object["groups"] as? [Any]
        else { return [] }
        var out: [ModelChoice] = []
        for group in groups {
            guard let group = group as? [String: Any],
                  let provider = group["id"] as? String,
                  let models = group["models"] as? [Any]
            else { continue }
            for entry in models {
                guard let entry = entry as? [String: Any],
                      let id = entry["id"] as? String
                else { continue }
                let name = (entry["name"] as? String) ?? id
                out.append(ModelChoice(provider: provider, model: id, label: "\(provider) · \(name)"))
            }
        }
        return out
    }

    private func waitForAnswer(sessionID: String, baseline: Int) async throws -> String {
        let deadline = Date().addingTimeInterval(180)
        while Date() < deadline {
            try await Task.sleep(nanoseconds: 800_000_000)
            let snapshot = try await history(sessionID: sessionID)
            if snapshot.assistantMessages > baseline {
                return snapshot.lastAssistantText
            }
        }
        throw BridgeError(code: "timeout", message: "no assistant answer within 180s")
    }

    private func assistantCount(sessionID: String) async throws -> Int {
        try await history(sessionID: sessionID).assistantMessages
    }

    /// Cached picker contents. `session.list` ships every session on the host
    /// (9 MB+ on a busy home), so it is fetched at most once a minute instead of
    /// on every popover open.
    private var sessionCache: (at: Date, rows: [SessionChoice])?

    /// Preferences the host plugin persists (which window surface to use, etc.).
    func prefs() async throws -> [String: Any] {
        let value = try await rpc("menubar.prefs", [:], timeout: 15)
        return (value as? [String: Any]) ?? [:]
    }

    /// Sessions that belong to the bridge's own workspace, newest first.
    ///
    /// `session.list` returns every session on the host, so the picker filters
    /// by the working directory the bridge assigns, which is exactly the
    /// decoded form of the workspace path it created.
    func recentSessions(limit: Int = 12, maxAge: TimeInterval = 60) async throws -> [SessionChoice] {
        if let cache = sessionCache, Date().timeIntervalSince(cache.at) < maxAge, !cache.rows.isEmpty {
            return Array(cache.rows.prefix(limit))
        }
        let value = try await rpc("session.list", [:], timeout: 120)
        guard let object = value as? [String: Any], let items = object["items"] as? [Any] else {
            return []
        }
        var rows: [(updated: Double, choice: SessionChoice)] = []
        for item in items {
            guard let item = item as? [String: Any],
                  let id = item["sessionId"] as? String,
                  let cwd = item["cwd"] as? String
            else { continue }
            guard cwd == workspacePath || cwd.hasSuffix("/.dsh/menubar-sessions") else { continue }
            let updated = (item["updatedAt"] as? Double) ?? 0
            let short = id.hasPrefix("session-") ? String(id.dropFirst(8).prefix(8)) : String(id.prefix(8))
            let title = Self.sessionTitle(from: item)
            let label = title.map { Self.truncate($0, 46) } ?? "session \(short)"
            rows.append((updated, SessionChoice(id: id, title: title, label: label)))
        }
        rows.sort { $0.updated > $1.updated }
        let choices = rows.map(\.choice)
        sessionCache = (Date(), choices)
        return Array(choices.prefix(limit))
    }

    struct HistorySnapshot {
        let assistantMessages: Int
        let lastAssistantText: String
    }

    /// Read the session snapshot and flatten assistant messages to text.
    func history(sessionID: String) async throws -> HistorySnapshot {
        let value = try await rpc("session.history", ["sessionId": sessionID], timeout: 30)
        guard let object = value as? [String: Any], let records = object["records"] as? [Any] else {
            throw BridgeError(code: "history", message: "session.history returned no records")
        }
        var count = 0
        var lastText = ""
        for record in records {
            guard let record = record as? [String: Any],
                  let event = record["event"] as? [String: Any],
                  let type = event["type"] as? String, type == "assistant/message",
                  let data = event["data"] as? [String: Any],
                  let message = data["message"] as? [String: Any],
                  let content = message["content"] as? [Any]
            else { continue }
            count += 1
            lastText = content.compactMap { part -> String? in
                guard let part = part as? [String: Any], (part["type"] as? String) == "text" else { return nil }
                return part["text"] as? String
            }.joined()
        }
        return HistorySnapshot(assistantMessages: count, lastAssistantText: lastText)
    }

    // MARK: - Transport

    private func startReceiveLoop(_ socket: URLSessionWebSocketTask) {
        receiveLoop = Task { [weak self] in
            while let self, !Task.isCancelled {
                do {
                    let message = try await socket.receive()
                    switch message {
                    case .string(let text): self.handle(text)
                    case .data(let data): self.handle(String(decoding: data, as: UTF8.self))
                    @unknown default: break
                    }
                } catch {
                    self.failAll(BridgeError(code: "closed", message: error.localizedDescription))
                    self.failHandshake(BridgeError(code: "closed", message: error.localizedDescription))
                    return
                }
            }
        }
    }

    private func send(_ frame: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: frame),
              let text = String(data: data, encoding: .utf8)
        else { return }
        lock.lock()
        sendQueue.append(text)
        let shouldStart = !sending
        if shouldStart { sending = true }
        lock.unlock()
        if shouldStart { pumpSend() }
    }

    /// Send the head of the queue, then the next one, and so on.
    private func pumpSend() {
        lock.lock()
        guard !sendQueue.isEmpty else {
            sending = false
            lock.unlock()
            return
        }
        let next = sendQueue.removeFirst()
        let socket = task
        lock.unlock()

        guard let socket else {
            lock.lock(); sending = false; sendQueue.removeAll(); lock.unlock()
            return
        }
        socket.send(.string(next)) { [weak self] error in
            guard let self else { return }
            if let error {
                self.debug("send failed (\(next.count)B): \(error.localizedDescription)")
                self.lock.lock()
                self.sending = false
                self.sendQueue.removeAll()
                self.lock.unlock()
                self.failAll(BridgeError(code: "send", message: error.localizedDescription))
                return
            }
            self.pumpSend()
        }
    }

    private func debug(_ message: String) {
        debugLog(message)
    }

    private func handle(_ text: String) {
        guard let data = text.data(using: .utf8),
              let frame = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let kind = frame["t"] as? String
        else { return }

        debugLog("recv \(text.count)B t=\(kind)")
        switch kind {
        case "hello.ok":
            if let workspace = frame["workspacePath"] as? String { workspacePath = workspace }
            resolveHandshake(.success(()))
        case "rpc.result":
            guard let id = frame["id"] as? String else { return }
            if frame["ok"] as? Bool == true {
                resolve(id, .success(frame["value"] ?? NSNull()))
            } else {
                let error = frame["error"] as? [String: Any]
                let code = error?["code"] as? String ?? "error"
                let message = error?["message"] as? String ?? "unknown host error"
                resolve(id, .failure(BridgeError(code: code, message: message)))
            }
        case "error":
            let code = frame["code"] as? String ?? "error"
            let message = frame["message"] as? String ?? "unknown host error"
            failAll(BridgeError(code: code, message: message))
        case "ping":
            send(["t": "pong"])
        default:
            break
        }
    }

    private func resolve(_ id: String, _ result: Result<Any, Error>) {
        lock.lock()
        let continuation = pending.removeValue(forKey: id)
        lock.unlock()
        continuation?.resume(with: result)
    }

    private func resolveHandshake(_ result: Result<Void, Error>) {
        lock.lock()
        let continuation = handshake
        handshake = nil
        lock.unlock()
        continuation?.resume(with: result)
    }

    private func failHandshake(_ error: Error) {
        resolveHandshake(.failure(error))
    }

    private func failAll(_ error: Error) {
        lock.lock()
        let continuations = pending.values
        pending.removeAll()
        lock.unlock()
        for continuation in continuations { continuation.resume(throwing: error) }
    }
}
