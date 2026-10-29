# Changelog

## v0.1.7

Configuration now renders **on the plugin's page**, not behind a Configure step.

- Registered on `plugins.bundle.config`, keyed by the bundle's package name — the slot documented as
  "rendered on the bundle's page between its description and its rows". This is the seat
  `dsh-auto-continue`, `dsh-openrouter-plus`, `dsh-cost-meter` and `dsh-claude-style` all use.
  Open Plugins → `@gnanesh/dsh-menubar` and the Window / Workspace / Menu bar app controls are right
  there, under the description.
- **Start actually starts again.** `bootstrap` already launches the app because the LaunchAgent has
  `RunAtLoad`, and the follow-up `kickstart -k` killed that process and could fail to respawn, leaving
  the job loaded but stopped. Start now bootstraps when unloaded, kickstarts only when loaded-but-down,
  and reads the result back from `launchctl print` either way.
- The app controls no longer dead-end when the first status read fails: state is polled every 4 s and
  the buttons are disabled only while a request is in flight. A failed action shows the host's error
  instead of silently doing nothing.

## v0.1.6

- **Find in page**: ⌘F (or ⌃F) opens a native find bar over the window and searches the embedded dsh
  interface with WebKit's own finder; ⌘G / ⇧⌘G walk matches, Esc dismisses the bar before it closes
  the window. Without an Edit menu the chord had no command behind it, which is the same gap that
  broke ⌘V.
- The patch row id is now `dsh-menubar`, matching the package basename. With `id: menubar` the Plugins
  page rendered our card with no version and no description, while every plugin that shows them has
  `row id == package basename`. The row-config key followed the rename to
  `@gnanesh/dsh-menubar#dsh-menubar`.

## v0.1.5

Configuration now lives on the plugin row instead of a top-level Settings section.

- Registered in `plugins.row.config` under the key `@gnanesh/dsh-menubar#menubar`
  (`<package name>#<row id>`), which is where the framework says a bundle's configuration belongs.
  The row on the bundle's page gains a configure control that opens the page, headed by the plugin's
  title and description, next to its version, source and uninstall controls.
- The top-level `settings.section` entry is gone, so Settings no longer carries a "Menu Bar" nav item
  for a plugin that is manageable from Plugins.
- The page still reads and writes `/menubar/prefs` and controls the app through `/menubar/app`.

## v0.1.4

You can now start the app from Settings, so quitting it is no longer a one-way
door.

- **Menu Bar settings → Menu bar app**: shows Running (with pid) or Stopped, and
  offers Start, Restart and Quit. Quit uses `launchctl bootout`, so the app stays
  stopped until you say otherwise; Start bootstraps the LaunchAgent first, so it
  works from a fully unloaded state.
- `GET /menubar/app` reports `{running, pid, loaded}`, `POST /menubar/app
  {action}` performs `start`, `stop` or `restart`.
- Both transitions tolerate launchd's asynchronous behaviour: `bootstrap`
  registers the job after it returns, and `kickstart -k` can report failure while
  it is busy replacing the process, so the outcome is read back from
  `launchctl print` instead of trusting an exit code.

## v0.1.3

Fixes the boot failure the scoped rename introduced.

The client bundle registered its lazy factory under the hardcoded id
`dsh-menubar`, while its entry id became `@gnanesh/dsh-menubar`. Any page that
still held the previous bundle therefore registered the same factory id twice
and the shell aborted with `duplicate factory registration for "dsh-menubar"`
→ `web boot: 1 entry did not activate`. The factory id now equals the package
name, which is the invariant the loader expects.

## v0.1.2

First release on npm, as `@gnanesh/dsh-menubar`.

- The unscoped name `dsh-menubar` was already reserved on npm by another author, so the package is
  scoped. `plugin/package.json` and `plugin/cordis.patch.yml` name the same package — the loader
  resolves a row by package name, so those two must never drift apart.
- npm metadata added (description, keywords, license, author, repository with `directory: plugin`,
  homepage, bugs) so the registry page describes the plugin instead of showing an empty card.
- The config overrides are now `DSH_MENUBAR_TOKEN` and `DSH_MENUBAR_WORKSPACE`; the old
  `DSH_SWIFT_*` names dated from before the project was renamed.

## v0.1.1

The menu bar item disappearing turned out to be the app exiting, not the host.

- The window no longer releases itself on close (`isReleasedWhenClosed = false`): the panel used to be
  deallocated the first time you dismissed it, which left a status item with nothing to show.
- Closing the window no longer ends the process (`applicationShouldTerminateAfterLastWindowClosed` →
  `false`). The status item is the app; dismissing a window should never be a way to quit it.
- The two `applicationWillTerminate` hooks are merged into one that both closes the socket and logs,
  so a restart of the host cannot leave a half-shut down process behind.
- README shows the whale in the menu bar rather than cropped out of it.

## v0.1.0

First release: DeepSeek Harness in the macOS menu bar.

**Plugin (`dsh-menubar`)**

- Token-authenticated WebSocket bridge mounted inside a running `dsh web` host at `/menubar/bridge`,
  projected onto the host's Typert Remotes, so sessions created from the menu bar are real sessions the
  GUI lists, resumes and forks.
- Methods: `session.create`, `session.prompt`, `session.cancel`, `session.history`, `session.list`,
  `session.models`, `session.selectModel`, `session.follow`, `workspace.list`, `workspace.create`,
  plus `menubar.prefs`.
- Live streaming through `session/follow` (`assistant-stream` frames), not polling.
- Bearer minted once at `~/.dsh/menubar-token` (0600) and reused, so reconnects need no copy-paste.
- Discovery route `/menubar/bridge-config` advertises `wsUrl`, a pre-authenticated `appUrl`
  (`ctx.connection.authenticatedUrl()`), the workspace and the token path.
- Preferences at `~/.dsh/menubar.json` via `GET/POST /menubar/prefs` and the `menubar.prefs` call.
- A **Menu Bar** section in DSH Settings (`settings.section`, order 25): window surface, workspace for
  new sessions, bridge and token information. Registration goes through `ctx.slots.inject`, and the
  client bundle never throws out of `factory`/`apply`, so a bad page degrades to a missing page instead
  of aborting the web boot.

## App (DSHMenubar)

- Menu bar app with the official DeepSeek whale as a template status item (light/dark aware), ⌃⌥Q
  global hotkey, right-click menu.
- Borderless, resizable, draggable window that does not close on outside clicks; ✕ or Escape closes it.
- **Embedded surface (default):** the real dsh interface in a webview, booted through the
  pre-authenticated URL, so tool cards, approvals, tabs and theme tokens come from the shell.
- **Compact surface (optional):** a purpose-built chat window — streaming transcript, collapsed
  reasoning, session titles, history on session switch, new session per open, markdown via
  marked + DOMPurify, stop button.
- Paste: text injected into the focused element on either surface; images and files on the compact one.
- Reconnects on its own when the host restarts, reloading the embedded page with a fresh launch token.
- Debug hooks for reproducible UI checks: `DSHBRIDGE_WINDOW_SIZE`, `DSHBRIDGE_SNAPSHOT[_DELAY]`,
  `DSHBRIDGE_EVAL`, `DSHBRIDGE_DEBUG`.
