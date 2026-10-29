# Changelog

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
