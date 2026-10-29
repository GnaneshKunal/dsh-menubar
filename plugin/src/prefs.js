/**
 * Persisted preferences for the menu bar integration.
 *
 * Both surfaces read the same file: the DSH Settings page (through the
 * /menubar/prefs route) and the native app (through the bridge's
 * `menubar.prefs` call). One source of truth, no duplicated settings.
 *
 * @module dsh-menubar/src/prefs
 */

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** Absolute path of the preferences file. */
export function prefsFilePath() {
  return dshHomePath('menubar.json')
}

/** Defaults used before anything is saved. */
export function defaultPrefs() {
  return {
    ui: 'embedded',
    workspacePath: dshHomePath('menubar-sessions'),
  }
}

/**
 * Read prefs, falling back to defaults for anything missing or malformed.
 * @returns {Promise<{ ui: 'native'|'embedded', workspacePath: string }>} preferences.
 */
export async function readPrefs() {
  const defaults = defaultPrefs()
  try {
    const raw = await readFile(prefsFilePath(), 'utf8')
    const parsed = JSON.parse(raw)
    return {
      ui: parsed.ui === 'embedded' ? 'embedded' : 'native',
      workspacePath: typeof parsed.workspacePath === 'string' && parsed.workspacePath.length > 0
        ? parsed.workspacePath
        : defaults.workspacePath,
    }
  } catch {
    return defaults
  }
}

/**
 * Validate and persist preferences atomically.
 * @param {{ ui?: string, workspacePath?: string }} patch requested values.
 * @returns {Promise<{ ui: 'native'|'embedded', workspacePath: string }>} the stored result.
 */
export async function writePrefs(patch) {
  const current = await readPrefs()
  const next = {
    ui: patch.ui === 'embedded' ? 'embedded' : patch.ui === 'native' ? 'native' : current.ui,
    workspacePath: typeof patch.workspacePath === 'string' && patch.workspacePath.length > 0
      ? patch.workspacePath
      : current.workspacePath,
  }
  const file = prefsFilePath()
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.tmp-${process.pid}`
  await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  await chmod(temp, 0o600)
  await rename(temp, file)
  return next
}
