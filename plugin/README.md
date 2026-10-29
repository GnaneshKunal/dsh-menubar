# dsh-menubar

A host plugin for DeepSeek Harness that lets a **native macOS (Swift) app** talk to the running
`dsh web` host — creating and driving sessions that are first-class citizens: they appear in the
GUI session list, resume, fork, replay, and group together exactly like the `browser-sessions`
workspace the Chrome bridge produces.

## Why this exists

Writing a session log behind the host's back does **not** make a session visible: the sidebar is
rendered from the workspace registry (`~/.dsh/storages/workspace.json` →
`tables.workspaces[<id>].sessionIds[]`), which only the running host writes. Two consequences:

| Approach | Shows up in the GUI? |
|---|---|
| `dsh --profile headless "…"` in a subprocess | No — log on disk, no workspace registration |
| Calling `/connect` with the per-process launch token | Yes, but the token changes every restart |
| **This plugin** | **Yes, and reconnects are seamless** |

The seamless property comes from **not** using the launch token: the plugin mints its own bearer
once, persists it at `~/.dsh/menubar-token` (mode 0600), and reuses it across restarts. A
native client reads that file at launch and never asks a human for anything.

## Wire protocol

One JSON object per WebSocket text message, discriminated by `t`.

```
client → host:  { t: 'hello', token, client? }
                { t: 'rpc', id, method, payload }
                { t: 'ping' }

host → client:  { t: 'hello.ok', workspacePath, tokenFile, methods, pingIntervalMs }
                { t: 'rpc.result', id, ok: true,  value }
                { t: 'rpc.result', id, ok: false, error: { code, message, details } }
                { t: 'pong' }
                { t: 'error', code, message }
```

`hello` must arrive within 5 s. A new authenticated socket replaces the previous one (close code
4003), so a restarted app reconnects cleanly. The server pings every 30 s and terminates a socket
that stops answering.

## Methods

| Method | Payload | Notes |
|---|---|---|
| `session.create` | `{ agentPreset? }` — or explicit `{ workspaceId }` / `{ cwd }` | An implicit create joins `~/.dsh/menubar-sessions`; the plugin mkdirs and `workspace.create`-registers it once |
| `session.prompt` | `{ sessionId, text }` or `{ sessionId, content: [{type:'text',text}] , mode? }` | Host request id is the rpc id |
| `session.history` | `{ sessionId, maxMessages? }` | Snapshot: `{ cursor, records, hasMore, projections?, assistantStream? }` |
| `session.cancel` | `{ sessionId }` | Cancels the live turn |
| `session.list` | `{}` or a host filter | Host session directory |
| `workspace.list` | — | Host directory: `{ items: [{ workspaceId, path, title, sessionIds }], archivedSessionIds, pinnedSessionIds }` |
| `workspace.create` | `{ path }` | `{ workspace: { workspaceId, … } }` |

## Discovery

`GET /menubar/bridge-config` on the host port answers:

```json
{ "wsUrl": "ws://127.0.0.1:3080/menubar/bridge", "workspacePath": "…/menubar-sessions",
  "tokenFile": "…/.dsh/menubar-token", "methods": ["…"] }
```

It never returns the token itself — the client reads the 0600 file.

## Config

| Key | Default | Meaning |
|---|---|---|
| `token` | — | Pinned bearer token. Empty/absent → persisted file is used, minted on first boot. |
| `workspacePath` | `~/.dsh/menubar-sessions` | Dedicated workspace for implicit `session.create`. `""` keeps sessions ungrouped. |
| `path` | `/menubar/bridge` | Carrier pathname. |
| `helloTimeoutMs` | `5000` | Hello deadline. |
| `pingIntervalMs` | `30000` | Ping cadence. |

## Security

The carrier path sits **outside** dsh's `/api` trust fence, so it authenticates itself: bearer
token in `hello`, constant-time comparison, 0600 token file, one connection at a time. The host
still binds loopback only — `dsh web --host 0.0.0.0` is unsupported upstream, and this bridge does
not weaken that. Do not expose the port through a tunnel without adding your own transport
security.

## Not in this version

- **Live event push.** The client polls `session.history` while a turn runs. A `session/follow`
  pump that emits `event` frames is the next increment.
- **Beacon discovery** on the `43189…43198` range for hosts launched with `--port 0`.
- **Approval / question waterfalls** (`user-questions/request` ↔ `respond`), so in-session
  `ask_user_question` currently falls through to the GUI.

## Install

```bash
# from a DSH session with Full access
plugin_manager install_bundle /Users/gnanesh/self/dsh-menubar
# then restart the host
dsh web
```
