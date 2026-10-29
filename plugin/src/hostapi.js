/**
 * Host adapter: projects bridge calls onto dsh's own Typert Remotes, so every
 * session the bridge creates is created *by the running host* and therefore
 * appears in the GUI session list, resumes, forks, and replays like any other.
 *
 * This is the difference between a tracked session and a ghost: writing a log
 * file behind the host's back leaves no workspace registration; calling
 * `session.create` through the host produces one.
 *
 * @module dsh-menubar/src/hostapi
 */

import { mkdir } from 'node:fs/promises'
import { badRequest, isRecord, notFound, promptRequest } from './protocol.js'

/** Empty client→host uplink for in-process wire streams (host-only endpoints). */
const EMPTY_WIRE_UPLINK = {
  async *[Symbol.asyncIterator]() { /* host-only streams carry no uplink items */ },
}

/**
 * Build the host adapter for one bridge lifetime.
 *
 * @param {object} options adapter options.
 * @param {object} options.gateway Host TypertGateway service (`ctx.typertGateway`).
 * @param {object} options.connection Host Connection service (`ctx.connection`).
 * @param {string} options.workspacePath dedicated workspace directory, or '' to opt out.
 * @param {{ info: Function, warn: Function }} options.logger plugin logger.
 * @returns {{ call: Function, ensureWorkspace: Function }} the adapter.
 */
export function createHostApi({ gateway, connection, workspacePath, logger, prefs }) {
  // One owner Peer speaks for every call and stream this bridge opens: the
  // bridge authenticates its own client with a bearer token, then acts as the
  // local operator who owns this Host.
  const peer = connection.createPeer({ principal: { kind: 'owner' }, interactions: 'answer' })

  /** Cached workspace preparation; the first implicit create wins. */
  let workspacePromise

  /**
   * Dispatch one Remote call as this bridge's Peer.
   * @param {object} request namespace, method, args, signal.
   * @returns {Promise<unknown>} the Remote result.
   */
  const invoke = request => gateway.invoke({ ...request, peer })

  /**
   * Map a thrown error to the wire failure shape.
   * @param {unknown} error thrown value.
   * @returns {{ code: string, message: string, details: Record<string, unknown> }} failure frame body.
   */
  function failure(error) {
    try {
      const mapped = gateway.wireStream.failure(error)
      if (isRecord(mapped) && typeof mapped.code === 'string' && typeof mapped.message === 'string') {
        return { code: mapped.code, message: mapped.message, details: isRecord(mapped.details) ? mapped.details : {} }
      }
    } catch { /* fall through to the local shape */ }
    const message = error instanceof Error ? error.message : String(error)
    const code = isRecord(error) && typeof error.code === 'string' ? error.code : 'internal'
    const details = isRecord(error) && isRecord(error.details) ? error.details : {}
    return { code, message, details }
  }

  /**
   * Open one host-only wire stream for this bridge's Peer.
   * @param {string} endpoint wire endpoint such as `workspace/follow`.
   * @param {unknown} payload endpoint payload.
   * @param {AbortSignal} signal cancellation.
   * @returns {Promise<AsyncIterable<unknown>>} the stream.
   */
  function openWireStream(endpoint, payload, signal) {
    return gateway.wireStream.open(endpoint, payload, EMPTY_WIRE_UPLINK, peer, signal)
  }

  /**
   * Create and register the dedicated workspace once, then reuse it.
   *
   * Grouping is best-effort: a failure logs one warning and leaves sessions
   * ungrouped rather than making session creation depend on it.
   *
   * @param {AbortSignal} signal cancellation.
   * @returns {Promise<string | undefined>} the workspace id, or undefined when ungrouped.
   */
  function ensureWorkspace(signal) {
    if (workspacePath === '') return Promise.resolve(undefined)
    if (workspacePromise !== undefined) return workspacePromise
    workspacePromise = (async () => {
      try {
        await mkdir(workspacePath, { recursive: true })
        const value = await invoke({
          namespace: 'workspace',
          method: 'create',
          args: { request: { path: workspacePath } },
          signal,
        })
        const workspaceId = isRecord(value) && isRecord(value.workspace) ? value.workspace.workspaceId : undefined
        if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
          throw new TypeError('workspace.create returned no workspaceId')
        }
        logger.info(`menubar bridge: sessions grouped under ${workspacePath}`)
        return workspaceId
      } catch (error) {
        logger.warn(
          `menubar bridge: could not prepare session workspace "${workspacePath}" `
          + `(${failure(error).code}: ${failure(error).message}); sessions will remain ungrouped`,
        )
        workspacePromise = undefined
        return undefined
      }
    })()
    return workspacePromise
  }

  /**
   * One-shot Session snapshot: history plus the live assistant stream baseline.
   *
   * The client polls this while a turn runs; a live push channel is the next
   * increment, not part of this one.
   *
   * @param {unknown} payload `{ sessionId, maxMessages? }`.
   * @param {AbortSignal} signal cancellation.
   * @returns {Promise<{ cursor: number, records: unknown[], hasMore: boolean, projections?: unknown, assistantStream?: unknown }>} the snapshot.
   */
  async function sessionHistory(payload, signal) {
    if (!isRecord(payload) || typeof payload.sessionId !== 'string' || payload.sessionId.length === 0) {
      throw badRequest('session.history requires a non-empty sessionId')
    }
    const maxMessages = Number.isSafeInteger(payload.maxMessages) && payload.maxMessages > 0
      ? payload.maxMessages
      : undefined
    const controller = new AbortController()
    const combined = AbortSignal.any([signal, controller.signal])
    const source = await openWireStream('session/follow', {
      args: {
        request: {
          address: { kind: 'session', sessionId: payload.sessionId },
          assistantStream: true,
          ...(maxMessages === undefined ? {} : { maxMessages }),
        },
      },
    }, combined)
    const iterator = source[Symbol.asyncIterator]()
    try {
      const first = await iterator.next()
      const snapshot = first.done ? undefined : first.value
      if (!isRecord(snapshot) || snapshot.type !== 'snapshot') {
        throw new TypeError('session/follow did not begin with a snapshot')
      }
      return {
        cursor: snapshot.cursor,
        records: Array.isArray(snapshot.records) ? snapshot.records : [],
        hasMore: snapshot.hasMore === true,
        ...(snapshot.projections === undefined ? {} : { projections: snapshot.projections }),
        ...(snapshot.assistantStream === undefined ? {} : { assistantStream: snapshot.assistantStream }),
      }
    } finally {
      controller.abort(new Error('session snapshot received'))
      await iterator.return?.()
    }
  }

  /**
   * Read the workspace directory from the host's own follow stream.
   * @param {AbortSignal} signal cancellation.
   * @returns {Promise<unknown>} the baseline workspace directory.
   */
  async function workspaceList(signal) {
    const controller = new AbortController()
    const combined = AbortSignal.any([signal, controller.signal])
    const source = await openWireStream('workspace/follow', { args: {} }, combined)
    const iterator = source[Symbol.asyncIterator]()
    try {
      const first = await iterator.next()
      const baseline = first.done ? undefined : first.value
      if (!isRecord(baseline) || baseline.type !== 'baseline' || !isRecord(baseline.value)) {
        throw new TypeError('workspace/follow did not begin with a baseline')
      }
      return baseline.value
    } finally {
      controller.abort(new Error('workspace baseline received'))
      await iterator.return?.()
    }
  }

  /**
   * Dispatch one bridge call.
   *
   * @param {object} call the bridge call.
   * @param {string} call.rpcId correlation id; also the Host request id for prompts.
   * @param {string} call.method dotted method name.
   * @param {unknown} call.payload method payload.
   * @param {AbortSignal} call.signal cancellation.
   * @returns {Promise<unknown>} the method value.
   */
  async function call({ rpcId, method, payload, signal }) {
    switch (method) {
      case 'workspace.list':
        return workspaceList(signal)

      case 'workspace.create':
        if (!isRecord(payload) || typeof payload.path !== 'string' || payload.path.length === 0) {
          throw badRequest('workspace.create requires a non-empty path')
        }
        return invoke({
          namespace: 'workspace',
          method: 'create',
          args: { request: { path: payload.path } },
          signal,
        })

      case 'session.list':
        return invoke({
          namespace: 'session',
          method: 'list',
          args: { _request: isRecord(payload) ? payload : {} },
          signal,
        })

      case 'session.create': {
        const request = { ...(isRecord(payload) ? payload : {}) }
        // An implicit create joins the dedicated workspace, mirroring what the
        // browser bridge does. Explicit workspaceId/cwd from the client wins.
        if (request.workspaceId === undefined && request.cwd === undefined) {
          const workspaceId = await ensureWorkspace(signal)
          if (workspaceId !== undefined) {
            request.workspaceId = workspaceId
          }
        }
        return invoke({ namespace: 'session', method: 'create', args: { request }, signal })
      }

      case 'session.prompt':
        if (!isRecord(payload)) throw badRequest('session.prompt payload must be an object')
        return invoke({
          namespace: 'session',
          method: 'prompt',
          args: { request: promptRequest(payload, rpcId) },
          signal,
        })

      case 'session.cancel':
        if (!isRecord(payload)) throw badRequest('session.cancel payload must be an object')
        return invoke({ namespace: 'session', method: 'cancel', args: { request: payload }, signal })

      // `menubar.prefs` is answered by the plugin itself, not the host.
      case 'menubar.prefs':
        if (typeof prefs === 'function') return prefs()
        throw notFound(method)

      case 'session.history':
        return sessionHistory(payload, signal)

      // The model directory a client needs to offer a picker, and the switch
      // that makes the choice stick: both are the host's own Remotes, so the
      // selection lands in the session log exactly as a GUI selection would.
      case 'session.models':
        return invoke({ namespace: 'session', method: 'modelCatalog', args: {}, signal })

      case 'session.selectModel':
        if (!isRecord(payload) || typeof payload.sessionId !== 'string' || payload.sessionId.length === 0) {
          throw badRequest('session.selectModel requires a non-empty sessionId')
        }
        return invoke({ namespace: 'session', method: 'selectModel', args: { request: payload }, signal })

      default:
        throw notFound(method)
    }
  }

  /**
   * Attach to a session's live stream and report every frame.
   *
   * `session/follow` is the only place reasoning and token deltas exist — the
   * durable log stores settled messages, not the stream that produced them.
   * Frames: an initial `snapshot`, then `event` entries and `assistant-stream`
   * start/chunk/end frames.
   *
   * @param {object} options follow options.
   * @param {string} options.sessionId session to follow.
   * @param {AbortSignal} options.signal cancellation.
   * @param {(frame: unknown) => void} options.onFrame frame callback.
   * @returns {Promise<void>} resolves when the stream ends.
   */
  async function follow({ sessionId, signal, onFrame }) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw badRequest('session.follow requires a non-empty sessionId')
    }
    const controller = new AbortController()
    const combined = AbortSignal.any([signal, controller.signal])
    const source = await openWireStream('session/follow', {
      args: {
        request: {
          address: { kind: 'session', sessionId },
          assistantStream: true,
        },
      },
    }, combined)
    try {
      for await (const frame of source) {
        if (combined.aborted) break
        onFrame(frame)
      }
    } finally {
      controller.abort(new Error('follow closed'))
    }
  }

  return { call, ensureWorkspace, failure, follow }
}
