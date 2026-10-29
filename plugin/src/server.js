/**
 * Bridge WebSocket carrier: token-authenticated connection registry and RPC
 * dispatch.
 *
 * The route this server mounts (`/menubar/bridge`) lives outside dsh's /api
 * trust fence, so the bridge brings its own authentication: a bearer token
 * presented in the `hello` frame within `helloTimeoutMs`. The host validates
 * the token against the persisted file, then every `rpc` frame dispatches into
 * the host adapter.
 *
 * One active connection at a time: a new authenticated socket replaces the
 * previous one, so a restarted Swift app reconnects without the host holding a
 * stale peer.
 *
 * @module dsh-menubar/src/server
 */

import { WebSocketServer } from 'ws'
import {
  CLOSE_BAD_FRAME,
  CLOSE_REPLACED,
  CLOSE_UNAUTHORIZED,
  HELLO_TIMEOUT_MS,
  MAX_FRAME_BYTES,
  PING_INTERVAL_MS,
  isRecord,
  parseFrame,
} from './protocol.js'
import { verifyToken } from './token.js'

/**
 * Token-authenticated bridge carrier. Construct once per plugin instance.
 */
export class SwiftBridgeServer {
  /**
   * @param {object} options carrier options.
   * @param {string} options.token bearer token the client must present.
   * @param {{ call: Function }} options.hostApi host adapter.
   * @param {string[]} options.methods accepted RPC methods, for the `hello.ok` advertisement.
   * @param {string} options.workspacePath advertised workspace path.
   * @param {string} options.tokenFile advertised token file path.
   * @param {{ info: Function, warn: Function }} options.logger plugin logger.
   * @param {number} [options.helloTimeoutMs] hello deadline.
   * @param {number} [options.pingIntervalMs] ping cadence.
   */
  constructor({
    token,
    hostApi,
    methods,
    workspacePath,
    tokenFile,
    logger,
    helloTimeoutMs = HELLO_TIMEOUT_MS,
    pingIntervalMs = PING_INTERVAL_MS,
  }) {
    this.token = token
    this.hostApi = hostApi
    this.methods = methods
    this.workspacePath = workspacePath
    this.tokenFile = tokenFile
    this.logger = logger
    this.helloTimeoutMs = helloTimeoutMs
    this.pingIntervalMs = pingIntervalMs
    this.wss = new WebSocketServer({ noServer: true })
    /** @type {import('ws').WebSocket | undefined} */
    this.active = undefined
    this.disposed = false
  }

  /**
   * Handle one HTTP upgrade for the bridge path.
   * @param {import('node:http').IncomingMessage} req upgrade request.
   * @param {import('node:stream').Duplex} socket raw socket transferred by the server.
   * @param {Buffer} head bytes already read after the upgrade headers.
   * @returns {void}
   */
  handleUpgrade(req, socket, head) {
    if (this.disposed) {
      socket.destroy()
      return
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.attach(ws)
    })
  }

  /**
   * Attach one freshly upgraded socket and run its state machine.
   * @param {import('ws').WebSocket} ws the socket.
   * @returns {void}
   */
  attach(ws) {
    const previous = this.active
    this.active = ws
    if (previous !== undefined && previous.readyState === previous.OPEN) {
      previous.close(CLOSE_REPLACED, 'replaced by a newer client')
    }

    const controller = new AbortController()
    ws.aborted = controller
    ws.authed = false
    ws.alive = true

    const helloDeadline = setTimeout(() => {
      if (!ws.authed) {
        this.logger.warn('menubar bridge: socket closed without hello')
        ws.close(CLOSE_UNAUTHORIZED, 'hello required')
      }
    }, this.helloTimeoutMs)

    const heartbeat = setInterval(() => {
      if (!ws.alive) {
        this.logger.warn('menubar bridge: client stopped answering pings; terminating')
        ws.terminate()
        return
      }
      ws.alive = false
      try {
        ws.ping()
      } catch {
        ws.terminate()
      }
    }, this.pingIntervalMs)

    const teardown = () => {
      this.stopFollow(ws)
      clearTimeout(helloDeadline)
      clearInterval(heartbeat)
      controller.abort(new Error('bridge socket closed'))
      if (this.active === ws) this.active = undefined
    }

    ws.on('pong', () => { ws.alive = true })

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        this.reject(ws, CLOSE_BAD_FRAME, 'binary frames are not supported')
        return
      }
      const raw = data.toString('utf8')
      if (Buffer.byteLength(raw, 'utf8') > MAX_FRAME_BYTES) {
        this.reject(ws, CLOSE_BAD_FRAME, 'frame too large')
        return
      }
      const frame = parseFrame(raw)
      if (frame === undefined) {
        this.send(ws, { t: 'error', code: 'bad-frame', message: 'malformed frame' })
        return
      }
      void this.onFrame(ws, frame)
    })

    ws.on('close', teardown)
    ws.on('error', () => { teardown() })
  }

  /**
   * Dispatch one parsed client frame.
   * @param {import('ws').WebSocket} ws the socket.
   * @param {Record<string, unknown>} frame parsed frame.
   * @returns {Promise<void>} resolves after dispatch.
   */
  async onFrame(ws, frame) {
    switch (frame.t) {
      case 'hello': {
        if (ws.authed) {
          this.send(ws, { t: 'error', code: 'already-authenticated', message: 'hello was already accepted' })
          return
        }
        if (!verifyToken(this.token, frame.token)) {
          this.logger.warn('menubar bridge: hello rejected (bad token)')
          this.reject(ws, CLOSE_UNAUTHORIZED, 'invalid token')
          return
        }
        ws.authed = true
        this.send(ws, {
          t: 'hello.ok',
          workspacePath: this.workspacePath,
          tokenFile: this.tokenFile,
          methods: this.methods,
          pingIntervalMs: this.pingIntervalMs,
        })
        this.logger.info('menubar bridge: client authenticated')
        return
      }

      case 'ping':
        this.send(ws, { t: 'pong' })
        return

      case 'rpc': {
        if (!ws.authed) {
          this.reject(ws, CLOSE_UNAUTHORIZED, 'hello required before rpc')
          return
        }
        const id = frame.id
        const method = frame.method
        if (typeof id !== 'string' || id.length === 0 || typeof method !== 'string' || method.length === 0) {
          this.send(ws, { t: 'error', code: 'bad-frame', message: 'rpc frames need a string id and method' })
          return
        }
        if (method === 'session.follow') {
          this.startFollow(ws, id, frame.payload)
          return
        }
        try {
          const value = await this.hostApi.call({
            rpcId: id,
            method,
            payload: frame.payload,
            signal: ws.aborted.signal,
          })
          this.send(ws, { t: 'rpc.result', id, ok: true, value: value === undefined ? null : value })
        } catch (error) {
          const failure = this.hostApi.failure(error)
          this.send(ws, { t: 'rpc.result', id, ok: false, error: failure })
        }
        return
      }

      case 'unfollow':
        this.stopFollow(ws)
        return

      default:
        this.send(ws, { t: 'error', code: 'unknown-frame', message: `unsupported frame type ${JSON.stringify(frame.t)}` })
    }
  }

  /**
   * Open the live session stream and forward every frame to the client.
   * @param {import('ws').WebSocket} ws target socket.
   * @param {string} id rpc id being acknowledged.
   * @param {unknown} payload `{ sessionId }`.
   * @returns {void}
   */
  startFollow(ws, id, payload) {
    this.stopFollow(ws)
    const sessionId = isRecord(payload) && typeof payload.sessionId === 'string' ? payload.sessionId : ''
    const controller = new AbortController()
    ws.followAbort = controller
    this.send(ws, { t: 'rpc.result', id, ok: true, value: { streaming: true, sessionId } })
    this.hostApi.follow({
      sessionId,
      signal: controller.signal,
      onFrame: (frame) => this.send(ws, { t: 'event', payload: frame }),
    }).catch((error) => {
      if (controller.signal.aborted) return
      this.send(ws, { t: 'event', payload: { type: 'follow-error', error: this.hostApi.failure(error) } })
    }).finally(() => {
      if (ws.followAbort === controller) ws.followAbort = undefined
    })
  }

  /**
   * Stop an in-flight follow for one socket.
   * @param {import('ws').WebSocket} ws target socket.
   * @returns {void}
   */
  stopFollow(ws) {
    ws.followAbort?.abort(new Error('follow cancelled'))
    ws.followAbort = undefined
  }

  /**
   * Send one frame, ignoring sockets that are no longer open.
   * @param {import('ws').WebSocket} ws target socket.
   * @param {Record<string, unknown>} frame outbound frame.
   * @returns {void}
   */
  send(ws, frame) {
    if (ws.readyState !== ws.OPEN) return
    try {
      ws.send(JSON.stringify(frame))
    } catch (error) {
      this.logger.warn(`menubar bridge: send failed (${String(error)})`)
    }
  }

  /**
   * Send a terminal error frame, then close the socket with a stable code.
   * @param {import('ws').WebSocket} ws target socket.
   * @param {number} code close code.
   * @param {string} message human reason.
   * @returns {void}
   */
  reject(ws, code, message) {
    this.send(ws, { t: 'error', code, message })
    try {
      ws.close(code, message)
    } catch {
      ws.terminate()
    }
  }

  /**
   * Close the carrier and every socket it owns.
   * @returns {void}
   */
  close() {
    if (this.disposed) return
    this.disposed = true
    try {
      this.active?.close(1001, 'bridge shutting down')
    } catch { /* already gone */ }
    this.active = undefined
    this.wss.close()
  }
}
