/**
 * Start, stop and inspect the menu bar app from the host.
 *
 * The app is a LaunchAgent, so its life is `launchctl` on the same user. The
 * host runs as that user, which is what makes a Settings button possible at
 * all: without it, quitting the app strands you in a terminal.
 *
 * @module dsh-menubar/src/appcontrol
 */

import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** LaunchAgent label and plist for the menu bar app. */
export const APP_LABEL = 'co.gnanesh.dshmenubar'

/** Absolute path of the LaunchAgent plist. */
export function appPlistPath() {
  return join(homedir(), 'Library', 'LaunchAgents', `${APP_LABEL}.plist`)
}

function domain() {
  return `gui/${process.getuid()}`
}

async function launchctl(args) {
  try {
    const { stdout } = await run('launchctl', args, { timeout: 10_000 })
    return { ok: true, stdout }
  } catch (error) {
    return { ok: false, stdout: String(error?.stdout ?? ''), message: String(error?.stderr || error?.message || error) }
  }
}

/**
 * Inspect the app's state.
 * @returns {Promise<{ running: boolean, pid: number|null, loaded: boolean, label: string }>} state.
 */
export async function appStatus() {
  const printed = await launchctl(['print', `${domain()}/${APP_LABEL}`])
  const text = printed.stdout
  const running = /state\s*=\s*running/.test(text)
  const pidMatch = text.match(/pid\s*=\s*(\d+)/)
  return {
    running,
    loaded: printed.ok,
    pid: pidMatch ? Number(pidMatch[1]) : null,
    label: APP_LABEL,
  }
}

/** Start the app, loading the LaunchAgent first when it is not loaded. */
export async function appStart() {
  const plist = appPlistPath()
  try {
    await access(plist)
  } catch {
    throw new Error(`no LaunchAgent at ${plist}`)
  }
  // bootstrap registers the job asynchronously, so a kickstart issued straight
  // after it can miss the service. Poll for registration first.
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const waitForJob = async (attempts) => {
    for (let i = 0; i < attempts; i += 1) {
      const printed = await launchctl(['print', `${domain()}/${APP_LABEL}`])
      if (printed.ok) return true
      await sleep(250)
    }
    return false
  }

  if (!(await waitForJob(1))) {
    const boot = await launchctl(['bootstrap', domain(), plist])
    // "already bootstrapped" is success for our purpose.
    if (!boot.ok && !/already bootstrapped|service is already loaded/i.test(boot.message)) {
      throw new Error(`could not load the LaunchAgent: ${boot.message}`)
    }
    if (!(await waitForJob(12))) throw new Error('the LaunchAgent did not register after bootstrap')
  }

  const kick = await launchctl(['kickstart', '-k', `${domain()}/${APP_LABEL}`])
  if (!kick.ok) {
    // kickstart -k reports failure when it races the process it just asked
    // launchd to replace; poll the settled state rather than trusting the exit.
    for (let i = 0; i < 8; i += 1) {
      await sleep(300)
      const current = await appStatus()
      if (current.running) return current
    }
    throw new Error(`could not start the app: ${kick.message}`)
  }
  return appStatus()
}

/** Stop the app and unload its LaunchAgent, so it stays stopped. */
export async function appStop() {
  const out = await launchctl(['bootout', `${domain()}/${APP_LABEL}`])
  // Bootout reports "Bad request" when the job was not loaded, which is the
  // state we wanted anyway.
  if (!out.ok && !/Bad request|No such process|could not find/i.test(out.message)) {
    throw new Error(`could not stop the app: ${out.message}`)
  }
  return appStatus()
}

/**
 * Act on the app.
 * @param {'start'|'stop'|'restart'} action requested transition.
 * @returns {Promise<object>} resulting state.
 */
export async function appAct(action) {
  if (action === 'start') return appStart()
  if (action === 'stop') return appStop()
  if (action === 'restart') {
    await appStop()
    return appStart()
  }
  throw new Error(`unknown action: ${String(action)}`)
}
