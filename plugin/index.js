/**
 * dsh-menubar — host plugin entry.
 *
 * Mounts a token-authenticated WebSocket carrier at `/menubar/bridge` plus a
 * discovery route at `/menubar/bridge-config`, and projects client calls onto
 * the running host's Typert Remotes so created sessions are first-class (they
 * show up in the GUI under a dedicated `menubar-sessions` workspace).
 *
 * Seamlessness comes from the token file: minted once at
 * `~/.dsh/menubar-token` (0600) and reused across every restart, so the
 * native client reads it at launch and never asks a human for anything.
 *
 * @module dsh-menubar
 */

import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { BRIDGE_CONFIG_PATH, BRIDGE_PATH, HELLO_TIMEOUT_MS, PING_INTERVAL_MS, SUPPORTED_METHODS } from './src/protocol.js'
import { resolveToken, tokenFilePath } from './src/token.js'
import { readPrefs, writePrefs } from './src/prefs.js'
import { createHostApi } from './src/hostapi.js'
import { SwiftBridgeServer } from './src/server.js'

/** Plugin name used by the loader patch. */
export const name = 'menubar'

/** Host services this plugin depends on. */
export const inject = ['webServer', 'typertGateway', 'connection']

/**
 * Mount the bridge in the host composition.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx host context.
 * @param {object} [config] plugin config from the loader patch.
 * @param {string} [config.token] pinned bearer token; empty means "use the persisted file".
 * @param {string} [config.workspacePath] dedicated workspace directory; empty means ungrouped.
 * @param {string} [config.path] carrier pathname; must start with `/`.
 * @param {number} [config.helloTimeoutMs] hello deadline override.
 * @param {number} [config.pingIntervalMs] ping cadence override.
 * @returns {Promise<void>} resolves once the routes are registered.
 */
export async function apply(ctx, config = {}) {
  const logger = ctx.logger ?? console

  const prefs = await readPrefs()
  // Explicit config wins, then the stored preference, then the default path.
  const workspacePath = typeof config.workspacePath === 'string' && config.workspacePath.length > 0
    ? config.workspacePath
    : prefs.workspacePath
  const path = typeof config.path === 'string' && config.path.startsWith('/')
    ? config.path
    : BRIDGE_PATH
  const helloTimeoutMs = Number.isSafeInteger(config.helloTimeoutMs) && config.helloTimeoutMs > 0
    ? config.helloTimeoutMs
    : HELLO_TIMEOUT_MS
  const pingIntervalMs = Number.isSafeInteger(config.pingIntervalMs) && config.pingIntervalMs > 0
    ? config.pingIntervalMs
    : PING_INTERVAL_MS

  const gateway = ctx.get('typertGateway')
  const connection = ctx.get('connection')
  if (gateway === undefined || connection === undefined) {
    logger.warn('menubar bridge: host has no typertGateway/connection; bridge not mounted')
    return
  }

  const tokenFile = tokenFilePath()
  const resolved = await resolveToken(config.token, tokenFile)
  if (resolved.generated) {
    logger.info(`menubar bridge: minted bridge token at ${resolved.file} (0600); the native client reads this file`)
  }

  const hostApi = createHostApi({
    gateway,
    connection,
    workspacePath,
    logger,
    prefs: async () => {
      const current = await readPrefs()
      return { ...current, tokenFile, workspacePathResolved: workspacePath }
    },
  })
  const server = new SwiftBridgeServer({
    token: resolved.token,
    hostApi,
    methods: SUPPORTED_METHODS,
    workspacePath,
    tokenFile,
    logger,
    helloTimeoutMs,
    pingIntervalMs,
  })

  // The WebSocket carrier itself.
  ctx.effect(
    () => ctx.webServer.registerUpgrade({
      path,
      handler: (req, socket, head) => { server.handleUpgrade(req, socket, head) },
    }),
    'menubar: bridge upgrade route',
  )

  // Discovery: a client that does not know the port asks this route.
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: BRIDGE_CONFIG_PATH,
      handler: (req, res) => {
        const port = ctx.webServer.port
        const hostHeader = typeof req.headers.host === 'string' && req.headers.host.length > 0
          ? req.headers.host
          : `127.0.0.1:${String(port)}`
        const wsUrl = `ws://${hostHeader}${path}`
        // The GUI's own page needs a signed browser cookie; the host can mint a
        // URL carrying this process's launch token, which `GET /` exchanges for
        // that cookie. Handing it to the app lets a webview boot the real UI.
        let appUrl
        try {
          const base = `http://${hostHeader}/`
          appUrl = typeof connection.authenticatedUrl === 'function'
            ? connection.authenticatedUrl(base)
            : undefined
        } catch (error) {
          logger.warn(`menubar bridge: could not build an authenticated app URL (${String(error)})`)
        }
        const body = JSON.stringify({
          wsUrl,
          appUrl,
          workspacePath,
          tokenFile,
          methods: SUPPORTED_METHODS,
        })
        res.statusCode = 200
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(body)
      },
    }),
    'menubar: discovery route',
  )

  // Preferences: read by the native app over the bridge and edited by the
  // Settings page the client half registers.
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: '/menubar/prefs',
      handler: async (req, res) => {
        const send = (body) => {
          res.statusCode = 200
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          res.end(JSON.stringify(body))
        }
        try {
          if (req.method === 'GET') {
            const current = await readPrefs()
            send({
              ...current,
              tokenFile,
              wsUrl: `ws://127.0.0.1:${String(ctx.webServer.port)}${path}`,
              workspacePathResolved: workspacePath,
            })
            return
          }
          if (req.method === 'POST') {
            const chunks = []
            for await (const chunk of req) chunks.push(chunk)
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
            const next = await writePrefs(body)
            logger.info(`menubar bridge: prefs saved (ui=${next.ui})`)
            send({ ...next, tokenFile })
            return
          }
          res.statusCode = 405
          res.end()
        } catch (error) {
          logger.warn(`menubar bridge: prefs request failed (${String(error)})`)
          res.statusCode = 400
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ error: String(error) }))
        }
      },
    }),
    'menubar: prefs route',
  )

  // Carrier teardown.
  ctx.effect(() => () => server.close(), 'menubar: carrier lifetime')

  logger.info(`menubar bridge: listening on ${path} (workspace ${workspacePath === '' ? 'ungrouped' : workspacePath})`)
}
