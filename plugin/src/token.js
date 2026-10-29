/**
 * Bridge bearer-token lifecycle: generation, constant-time verification, and
 * file persistence under the dsh home directory.
 *
 * The token authenticates the native client against the bridge WebSocket. It
 * is not the /api trust fence: the bridge route lives outside that fence by
 * design, so it brings its own auth.
 *
 * Persisting the token is the whole reason reconnects are seamless: the file
 * is minted once, survives every DSH restart, and the client reads it at
 * launch. No copy-paste, no per-process launch token.
 *
 * @module dsh-menubar/src/token
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** File name of the persisted token inside the dsh home. */
export const TOKEN_FILE_NAME = 'menubar-token'

/** Entropy bytes of a generated token (256-bit). */
export const DEFAULT_TOKEN_BYTES = 32

/**
 * Path of the persisted token file under the dsh home.
 * @returns absolute path like `~/.dsh/menubar-token`.
 */
export function tokenFilePath() {
  return dshHomePath(TOKEN_FILE_NAME)
}

/**
 * Generate a fresh token as lowercase hex.
 * @param {number} [bytes] entropy bytes; defaults to 256-bit.
 * @returns {string} the hex token.
 */
export function generateToken(bytes = DEFAULT_TOKEN_BYTES) {
  return randomBytes(bytes).toString('hex')
}

/**
 * Constant-time token comparison. A length mismatch fails fast; a wrong-length
 * token can never verify.
 * @param {string} expected configured token.
 * @param {string} actual token presented by the client.
 * @returns {boolean} true only when both are equal-length and byte-equal.
 */
export function verifyToken(expected, actual) {
  if (typeof expected !== 'string' || typeof actual !== 'string') return false
  const expectedBuf = Buffer.from(expected, 'utf8')
  const actualBuf = Buffer.from(actual, 'utf8')
  if (expectedBuf.length === 0 || expectedBuf.length !== actualBuf.length) return false
  return timingSafeEqual(expectedBuf, actualBuf)
}

/**
 * Read the persisted token; undefined when absent or unreadable.
 * @param {string} [file] token file path.
 * @returns {Promise<string | undefined>} the stored token, trimmed.
 */
export async function readTokenFile(file = tokenFilePath()) {
  try {
    return (await readFile(file, 'utf8')).trim()
  } catch {
    return undefined
  }
}

/**
 * Persist a token atomically (temp file + rename) with 0600 permissions.
 * @param {string} token hex token to persist.
 * @param {string} [file] token file path.
 * @returns {Promise<void>} resolves after the rename.
 */
export async function writeTokenFile(token, file = tokenFilePath()) {
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.tmp-${process.pid}`
  await writeFile(temp, `${token}\n`, { mode: 0o600 })
  await chmod(temp, 0o600)
  await rename(temp, file)
}

/**
 * Resolve the bridge token: an explicitly configured token wins; otherwise the
 * persisted file is reused when present, and a fresh token is generated and
 * persisted otherwise.
 * @param {string | undefined} configured token from plugin config.
 * @param {string} [file] token file path.
 * @returns {Promise<{ token: string, file: string, generated: boolean }>} resolved identity.
 */
export async function resolveToken(configured, file = tokenFilePath()) {
  if (typeof configured === 'string' && configured.length > 0) {
    return { token: configured, file, generated: false }
  }
  const persisted = await readTokenFile(file)
  if (persisted !== undefined && persisted.length > 0) {
    return { token: persisted, file, generated: false }
  }
  const token = generateToken()
  await writeTokenFile(token, file)
  return { token, file, generated: true }
}
