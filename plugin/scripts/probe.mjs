/**
 * End-to-end probe for dsh-swift-bridge: hello, workspace.list, session.create,
 * session.prompt, then poll session.history for the answer.
 *
 * Reads the persisted token from ~/.dsh/swift-bridge-token — exactly what the
 * Swift app will do, with no copy-paste.
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'

const PROMPT = 'Reply with exactly: SWIFT-BRIDGE-OK'
const token = (await readFile(join(homedir(), '.dsh', 'swift-bridge-token'), 'utf8')).trim()
const config = await (await fetch('http://127.0.0.1:3080/swift/bridge-config')).json()
console.log('discovery:', config.wsUrl, '| workspace:', config.workspacePath)

const ws = new WebSocket(config.wsUrl)
const pending = new Map()
let seq = 0

function rpc(method, payload) {
  const id = `probe-${++seq}`
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ t: 'rpc', id, method, payload }))
    setTimeout(() => {
      if (!pending.has(id)) return
      pending.delete(id)
      reject(new Error(`timeout on ${method}`))
    }, 120000)
  })
}

function sessionIdOf(value) {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return undefined
  if (typeof value.sessionId === 'string') return value.sessionId
  if (value.session && typeof value.session.sessionId === 'string') return value.session.sessionId
  if (value.session && typeof value.session.id === 'string') return value.session.id
  if (typeof value.id === 'string') return value.id
  return undefined
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

ws.on('open', () => {
  console.log('socket open → hello')
  ws.send(JSON.stringify({ t: 'hello', token, client: 'probe' }))
})

ws.on('message', async raw => {
  const frame = JSON.parse(raw.toString())
  if (frame.t === 'hello.ok') {
    console.log('hello.ok | methods:', frame.methods.length)
    try {
      const workspaces = await rpc('workspace.list', {})
      const list = workspaces.workspace?.workspaces ?? workspaces.workspaces ?? workspaces
      console.log('workspace.list →', Array.isArray(list) ? `${list.length} workspaces` : typeof workspaces)
      if (Array.isArray(list)) {
        const hit = list.find(w => String(w.path ?? '').includes('swift-sessions'))
        console.log('  swift-sessions registered:', hit ? `yes (${hit.workspaceId ?? hit.id})` : 'no (not yet created)')
      }

      const created = await rpc('session.create', {})
      const sessionId = sessionIdOf(created)
      console.log('session.create →', JSON.stringify(created).slice(0, 300))
      if (!sessionId) throw new Error('no sessionId in create result')
      console.log('  sessionId:', sessionId)

      const accepted = await rpc('session.prompt', { sessionId, text: PROMPT })
      console.log('session.prompt →', JSON.stringify(accepted))

      const deadline = Date.now() + 90000
      let answer
      while (Date.now() < deadline) {
        await sleep(2000)
        const history = await rpc('session.history', { sessionId })
        const blob = JSON.stringify(history)
        if (blob.includes('SWIFT-BRIDGE-OK')) { answer = blob; break }
      }
      console.log(answer ? 'ANSWER SEEN in session.history ✓' : 'no answer within 90s')
      if (answer) {
        const at = answer.indexOf('SWIFT-BRIDGE-OK')
        console.log('  context:', answer.slice(Math.max(0, at - 120), at + 20).replace(/\\n/g, ' '))
      }
      ws.close()
      process.exit(answer ? 0 : 2)
    } catch (error) {
      console.error('probe failed:', error.message)
      ws.close()
      process.exit(1)
    }
    return
  }
  if (frame.t === 'rpc.result') {
    const slot = pending.get(frame.id)
    if (!slot) return
    pending.delete(frame.id)
    if (frame.ok) slot.resolve(frame.value)
    else slot.reject(new Error(`${frame.error?.code}: ${frame.error?.message}`))
    return
  }
  if (frame.t === 'error') console.error('host error frame:', frame.code, frame.message)
})

ws.on('close', (code, reason) => console.log('socket closed', code, reason?.toString() ?? ''))
ws.on('error', error => { console.error('socket error:', error.message); process.exit(1) })
setTimeout(() => { console.error('probe hard timeout'); process.exit(1) }, 180000)
