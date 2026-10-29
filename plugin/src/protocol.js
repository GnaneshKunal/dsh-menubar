/**
 * Wire contract between the menubar bridge plugin (host, node) and a native
 * client (Swift). Frames are one JSON object per WebSocket text message,
 * discriminated by `t`; correlation ids are opaque strings minted by the
 * requestor and echoed by the responder.
 *
 * Client → host:  hello · rpc · ping
 * Host → client:  hello.ok · rpc.result · event · pong · error
 *
 * @module dsh-menubar/src/protocol
 */

/** WebSocket pathname the plugin registers on the host webserver. */
export const BRIDGE_PATH = '/menubar/bridge'

/** Discovery endpoint answering `{ wsUrl, workspacePath, tokenFile }`. */
export const BRIDGE_CONFIG_PATH = '/menubar/bridge-config'

/** Seconds a fresh socket may take to present `hello` before it is closed. */
export const HELLO_TIMEOUT_MS = 5000

/** Server-side ping cadence; the client answers `pong` to prove liveness. */
export const PING_INTERVAL_MS = 30000

/** Upper bound on one inbound frame, in bytes. */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024

/** Close codes the bridge uses for its own failures (application range). */
export const CLOSE_UNAUTHORIZED = 4001
export const CLOSE_BAD_FRAME = 4002
export const CLOSE_REPLACED = 4003

/** Host RPC methods this bridge accepts. Everything else is refused. */
export const SUPPORTED_METHODS = Object.freeze([
  'workspace.list',
  'workspace.create',
  'session.list',
  'session.create',
  'session.prompt',
  'session.cancel',
  'session.history',
  'session.models',
  'session.selectModel',
  'session.follow',
])

/**
 * Whether a value is a plain JSON object record.
 * @param {unknown} value candidate.
 * @returns {boolean} true for non-null, non-array objects.
 */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parse one inbound frame without throwing.
 * @param {string} raw frame text.
 * @returns {Record<string, unknown> | undefined} the parsed frame, or undefined when malformed.
 */
export function parseFrame(raw) {
  if (typeof raw !== 'string') return undefined
  try {
    const value = JSON.parse(raw)
    return isRecord(value) && typeof value.t === 'string' ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Build one text prompt part in the Host's own content shape.
 * @param {string} text prompt text.
 * @returns {Array<{ type: 'text', text: string }>} a single-part prompt content array.
 */
export function textContent(text) {
  return [{ type: 'text', text }]
}

/**
 * Normalize a prompt payload into the Host's `SessionPromptRequest` shape.
 *
 * Accepts either the canonical `content` array or the convenience `text`
 * string a native client naturally sends. The request id is minted by the
 * caller and always overwritten here so it matches the rpc id the client sees.
 *
 * @param {Record<string, unknown>} payload client payload.
 * @param {string} rpcId correlation id of the originating call.
 * @returns {Record<string, unknown>} a `SessionPromptRequest`.
 */
export function promptRequest(payload, rpcId) {
  const sessionId = payload.sessionId
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw badRequest('session.prompt requires a non-empty sessionId')
  }
  const content = Array.isArray(payload.content)
    ? payload.content
    : typeof payload.text === 'string' && payload.text.trim().length > 0
      ? textContent(payload.text)
      : undefined
  if (content === undefined) {
    throw badRequest('session.prompt requires `content` or non-empty `text`')
  }
  const mode = payload.mode === 'steer' ? 'steer' : 'queue'
  return {
    requestId: rpcId,
    sessionId,
    mode,
    content,
    ...(typeof payload.clientTimeZone === 'string' && payload.clientTimeZone.length > 0
      ? { clientTimeZone: payload.clientTimeZone }
      : {}),
  }
}

/**
 * Create a bad-request error with a stable code.
 * @param {string} message human text.
 * @returns {Error & { code: string, details: Record<string, unknown> }} the tagged error.
 */
export function badRequest(message) {
  const error = new Error(message)
  error.code = 'bad-request'
  error.details = {}
  return error
}

/**
 * Create a not-found error for an unsupported method.
 * @param {string} method requested method name.
 * @returns {Error & { code: string, details: Record<string, unknown> }} the tagged error.
 */
export function notFound(method) {
  const error = new Error(`menubar bridge method ${JSON.stringify(method)} is not available`)
  error.code = 'not-found'
  error.details = {}
  return error
}
