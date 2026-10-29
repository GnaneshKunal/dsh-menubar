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
 */
(function (root) {
  if (!root || !root.__ModuleLoader__ || typeof root.__ModuleLoader__.load !== "function") return;

  root.__ModuleLoader__.load({
    id: "dsh-menubar",
    factory: function (require) {
      var module = { exports: {} };
      var exports = module.exports;
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
        var [error, setError] = React.useState("");

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

        var ui = (prefs && prefs.ui) || "native";

        return React.createElement("div", { style: S.page },
          React.createElement("div", { style: S.group },
            React.createElement("div", { style: S.label }, "Window"),
            React.createElement(SurfaceOption, {
              active: ui === "native",
              title: "Menu bar window",
              description: "The compact chat window that ships with dsh-menubar.",
              onSelect: function () { choose("native"); },
            }),
            React.createElement(SurfaceOption, {
              active: ui === "embedded",
              title: "Full dsh interface",
              description: "Boots the complete dsh front end in the window: tool cards, approvals, themes.",
              onSelect: function () { choose("embedded"); },
            }),
            React.createElement("div", { style: S.hint },
              "Takes effect the next time the window opens; ⌃⌥Q reopens it.")),

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
            React.createElement("div", { style: S.label }, "Bridge"),
            React.createElement("div", { style: S.status }, (prefs && prefs.wsUrl) || ""),
            React.createElement("div", { style: S.hint }, "Token file: " + ((prefs && prefs.tokenFile) || "")),
            React.createElement("div", { style: S.hint },
              "The token is minted once and reused; delete that file to rotate it.")));
      }

      function apply(ctx) {
        var slots = ctx.get("slots");
        if (!slots || !React) {
          try { console.warn("[dsh-menubar] settings page unavailable: slots or react missing"); } catch (e) {}
          return;
        }
        ctx.effect(function () {
          return slots.register({
            name: "settings.section",
            id: "menubar",
            order: 25,
            label: "Menu Bar",
          }, function () {
            return React.createElement(MenuBarSettings, null);
          });
        }, "dsh-menubar: settings page");
      }

      exports.inject = ["slots"];
      exports.apply = apply;
      return module.exports;
    },
  });
})(typeof window !== "undefined" ? window : null);
