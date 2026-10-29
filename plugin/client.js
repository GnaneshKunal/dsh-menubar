/* dsh-menubar — browser half.
 *
 * Registers a "Menu Bar" page in DSH Settings. The page edits the same
 * preferences the native app reads (`~/.dsh/menubar.json`) through the plugin's
 * own `/menubar/prefs` route, so there is one source of truth and no extra
 * settings transport.
 *
 * Loaded by dsh-client-modules at /plugins/dsh-menubar/client.js and executed
 * through the vendored cordis Loader's lazy-CJS table; react resolves from the
 * shell's module table.
 *
 * Boot safety: a client entry that throws — or that never arrives because it
 * declared an inject edge that is not a boot entry — aborts the whole web boot
 * with "Failed to load plugins". So this module declares no module-level inject
 * edges at all, and both the factory and apply swallow their own errors: the
 * worst case is a missing settings page, never a dead GUI.
 */
(function (root) {
  if (!root || !root.__ModuleLoader__ || typeof root.__ModuleLoader__.load !== "function") return;

  root.__ModuleLoader__.load({
    // Must equal the package name: the loader keys factories by this id, and a
    // stale page can hold the previous bundle, so a stale id collides as
    // "duplicate factory registration".
    id: "@gnanesh/dsh-menubar",
    factory: function (require) {
      var module = { exports: {} };
      var exports = module.exports;
      try {
        Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

        var React = null;
        try { React = require("react") || null; } catch (e) { React = null; }

        var PREFS_URL = "/menubar/prefs";

        function readPrefs() {
          return fetch(PREFS_URL, { headers: { accept: "application/json" } }).then(function (r) {
            if (!r.ok) throw new Error("HTTP " + r.status);
            return r.json();
          });
        }

        function savePrefs(patch) {
          return fetch(PREFS_URL, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(patch),
          }).then(function (r) {
            if (!r.ok) throw new Error("HTTP " + r.status);
            return r.json();
          });
        }

        // Tokens follow the theme so the page looks native in light and dark.
        var S = {
          page: { display: "flex", flexDirection: "column", gap: "18px", maxWidth: "560px" },
          group: { display: "flex", flexDirection: "column", gap: "8px" },
          label: { fontSize: "12px", color: "var(--dsw-alias-label-secondary)" },
          hint: { fontSize: "11px", color: "var(--dsw-alias-label-secondary)", opacity: 0.8 },
          row: { display: "flex", gap: "8px", alignItems: "center" },
          input: {
            flex: "1",
            background: "var(--dsw-alias-bg-layer-2)",
            border: "1px solid var(--dsw-alias-border-l1)",
            color: "var(--dsw-alias-label-primary)",
            borderRadius: "8px",
            padding: "7px 10px",
            fontSize: "12.5px",
            outline: "none",
          },
          button: {
            background: "var(--dsw-alias-brand-primary)",
            color: "#fff",
            border: "none",
            borderRadius: "8px",
            padding: "7px 14px",
            fontSize: "12.5px",
            cursor: "pointer",
          },
          option: function (active) {
            return {
              textAlign: "left",
              cursor: "pointer",
              borderRadius: "10px",
              padding: "10px 12px",
              border: "1px solid " + (active ? "var(--dsw-alias-brand-primary)" : "var(--dsw-alias-border-l1)"),
              background: active ? "var(--dsw-alias-bg-layer-2)" : "transparent",
              color: "var(--dsw-alias-label-primary)",
              fontSize: "12.5px",
            };
          },
          status: { fontSize: "11.5px", color: "var(--dsw-alias-label-secondary)" },
        };

        function SurfaceOption(props) {
          return React.createElement("button", {
            type: "button",
            style: S.option(props.active),
            onClick: props.onSelect,
          },
            React.createElement("div", { style: { fontWeight: 600 } }, props.title),
            React.createElement("div", { style: S.hint }, props.description));
        }

        function MenuBarSettings() {
          var [prefs, setPrefs] = React.useState(null);
          var [workspace, setWorkspace] = React.useState("");
          var [state, setState] = React.useState("loading");
          var [app, setApp] = React.useState(null);
          var [appBusy, setAppBusy] = React.useState(false);
          var [appError, setAppError] = React.useState("");
          var [error, setError] = React.useState("");

          var appTimer = null;
          function refreshApp() {
            return fetch("/menubar/app", { headers: { accept: "application/json" } })
              .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
              .then(function (value) { setApp(value); setAppBusy(false); return value; })
              .catch(function (e) { setAppError(String(e && e.message ? e.message : e)); return null; });
          }

          function controlApp(action) {
            setAppBusy(true);
            setAppError("");
            fetch("/menubar/app", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ action: action }),
            })
              .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
              .then(function (res) {
                // A 500 carries {error}; surface it instead of pretending.
                if (!res.ok) { setAppError(res.body && res.body.error ? res.body.error : "request failed"); }
                else { setApp(res.body); }
              })
              .catch(function (e) { setAppError(String(e && e.message ? e.message : e)); })
              .then(function () { setAppBusy(false); });
          }

          React.useEffect(function () {
            refreshApp();
            // Keep it live: the app can be quit from its own menu, and a failed
            // first read must not leave the controls dead.
            appTimer = setInterval(refreshApp, 4000);
            return function () { if (appTimer) clearInterval(appTimer); };
          }, []);

          React.useEffect(function () {
            readPrefs().then(function (value) {
              setPrefs(value);
              setWorkspace(value.workspacePathResolved || value.workspacePath || "");
              setState("ready");
            }).catch(function (e) {
              setError(String(e && e.message ? e.message : e));
              setState("error");
            });
          }, []);

          function choose(ui) {
            if (!prefs) return;
            setPrefs(Object.assign({}, prefs, { ui: ui }));
            savePrefs({ ui: ui }).catch(function (e) { setError(String(e)); });
          }

          function commitWorkspace() {
            savePrefs({ workspacePath: workspace }).then(function (next) {
              setPrefs(function (prev) { return Object.assign({}, prev, next); });
              setState("saved");
            }).catch(function (e) { setError(String(e)); });
          }

          if (state === "loading") {
            return React.createElement("div", { style: S.status }, "Loading menu bar settings…");
          }
          if (state === "error") {
            return React.createElement("div", { style: Object.assign({}, S.status, { color: "var(--dsw-alias-state-error-primary)" }) },
              "Could not read menu bar settings: " + error);
          }

          var ui = (prefs && prefs.ui) || "embedded";

          return React.createElement("div", { style: S.page },
            React.createElement("div", { style: S.group },
              React.createElement("div", { style: S.label }, "Window"),
              React.createElement(SurfaceOption, {
                active: ui === "embedded",
                title: "Full dsh interface",
                description: "The complete dsh front end in the window: tool cards, approvals, themes.",
                onSelect: function () { choose("embedded"); },
              }),
              React.createElement(SurfaceOption, {
                active: ui === "native",
                title: "Menu bar window",
                description: "A compact chat window with its own transcript and composer.",
                onSelect: function () { choose("native"); },
              }),
              React.createElement("div", { style: S.hint },
                "Applies the next time the window opens; ⌃⌥Q reopens it.")),

            React.createElement("div", { style: S.group },
              React.createElement("div", { style: S.label }, "Workspace for new sessions"),
              React.createElement("div", { style: S.row },
                React.createElement("input", {
                  style: S.input,
                  value: workspace,
                  spellCheck: false,
                  onChange: function (event) { setWorkspace(event.target.value); },
                }),
                React.createElement("button", { style: S.button, onClick: commitWorkspace }, "Save")),
              React.createElement("div", { style: S.hint },
                "Sessions created from the menu bar are grouped under this folder.")),

            React.createElement("div", { style: S.group },
              React.createElement("div", { style: S.label }, "Menu bar app"),
              React.createElement("div", { style: S.row },
                React.createElement("div", { style: Object.assign({}, S.status, { flex: "1" }) }, !app ? "Checking…" : (app.running
                  ? "Running" + (app.pid ? " (pid " + app.pid + ")" : "")
                  : "Stopped")),
                React.createElement("button", {
                  style: S.button,
                  disabled: appBusy,
                  onClick: function () { controlApp("start"); },
                }, "Start"),
                React.createElement("button", {
                  style: Object.assign({}, S.button, { background: "var(--dsw-alias-bg-layer-2)", color: "var(--dsw-alias-label-primary)", border: "1px solid var(--dsw-alias-border-l1)" }),
                  disabled: appBusy,
                  onClick: function () { controlApp("restart"); },
                }, "Restart"),
                React.createElement("button", {
                  style: Object.assign({}, S.button, { background: "transparent", color: "var(--dsw-alias-label-secondary)", border: "1px solid var(--dsw-alias-border-l1)" }),
                  disabled: appBusy,
                  onClick: function () { controlApp("stop"); },
                }, "Quit")),
              React.createElement("div", { style: S.hint },
                "Quitting the app from its menu removes the whale from the menu bar; start it again here."),
              appError ? React.createElement("div", {
                style: { fontSize: "11px", color: "var(--dsw-alias-state-error-primary)" },
              }, appError) : null),

            React.createElement("div", { style: S.group },
              React.createElement("div", { style: S.label }, "Bridge"),
              React.createElement("div", { style: S.status }, (prefs && prefs.wsUrl) || ""),
              React.createElement("div", { style: S.hint }, "Token file: " + ((prefs && prefs.tokenFile) || "")),
              React.createElement("div", { style: S.hint },
                "The token is minted once and reused; delete that file to rotate it.")));
        }

        // "slots" is a shell service (service inject). The Plugins page declares
        // the config slots, so those carry a module edge in the manifest.
        exports.inject = ["slots"];
        exports.apply = function (ctx) {
          try {
            var slots = ctx.get("slots");
            if (!slots || !React) {
              try { console.warn("[dsh-menubar] settings page unavailable: slots or react missing"); } catch (e) {}
              return;
            }
            // Bundle-level configuration renders on the bundle's own page,
            // between its description and its rows — no configure step. This is
            // the seat auto-continue, openrouter-plus and cost-meter use.
            ctx.effect(function () {
              return slots.inject("plugins.bundle.config", function () {
                return slots.register({
                  name: "plugins.bundle.config",
                  key: "@gnanesh/dsh-menubar",
                }, function () {
                  return React.createElement(MenuBarSettings, null);
                });
              });
            }, "dsh-menubar: bundle configuration");
          } catch (e) {
            try {
              console.warn("[dsh-menubar] settings page failed to register: "
                + (e && e.message ? e.message : String(e)) + " | stack: "
                + String((e && e.stack) || "").split("\n").slice(0, 3).join(" <- "));
            } catch (e2) {}
          }
        };
      } catch (e) {
        try { console.warn("[dsh-menubar] client bundle failed to initialise", e); } catch (e2) {}
      }
      return module.exports;
    },
  });
})(typeof window !== "undefined" ? window : null);
