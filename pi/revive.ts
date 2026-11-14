// Opt-in only: /revive updates the existing restoration TXT through herdr-boot.
// Plain-JS-compatible TypeScript; no dependency or settings change is required.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const ENTRY = "revive-state";
const quote = (word) => "'" + word.replaceAll("'", "'\\''") + "'";

export default function revive(pi, { env = process.env, exists = existsSync } = {}) {
  const local = join(homedir(), ".local", "bin", "herdr-boot");
  const helper = env.HERDR_BOOT_BIN || (exists(local) ? local : "herdr-boot");
  let enabled = false;
  let pending;

  const show = (ctx) => {
    if (ctx.mode === "tui") ctx.ui.setStatus("revive", enabled ? "[REV: on]" : "[REV: off]");
  };

  pi.on("session_start", (event, ctx) => {
    enabled = false;
    if (event.reason !== "new" && event.reason !== "fork") {
      for (const entry of ctx.sessionManager.getEntries()) {
        if (entry.type === "custom" && entry.customType === ENTRY
            && entry.data?.sessionId === ctx.sessionManager.getSessionId()
            && entry.data?.terminal === env.HC_TERMINAL_ID) {
          enabled = entry.data.enabled === true;
        }
      }
    }
    // "revive" sorts immediately before "mode" in the existing custom footer.
    show(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await pending; // Finish an explicit toggle before reload/session replacement.
    if (ctx.mode === "tui") ctx.ui.setStatus("revive", undefined);
  });

  pi.registerCommand("revive", {
    description: "Toggle this session's herdr-boot restoration entry",
    handler: async (args, ctx) => {
      const notify = (text, level = "warning") => { if (ctx.hasUI) ctx.ui.notify(text, level); };
      if ((args || "").trim()) return notify("Usage: /revive (ON/OFF toggle)");
      const terminal = env.HC_TERMINAL_ID;
      const file = ctx.sessionManager.getSessionFile();
      if (ctx.mode !== "tui" || !/^t[0-9a-z]+$/.test(terminal || "")) {
        return notify("/revive needs an interactive Pi in a local Herdr terminal.");
      }
      if (!file || !isAbsolute(file)) return notify("/revive needs a persistent Pi session (not --no-session).");
      if (pending) return notify("/revive is already updating the restoration file.");
      if (!enabled && !exists(file)) return notify("This session is not saved yet. Send a message first, then /revive.");
      const next = !enabled;
      pending = (async () => {
        try {
          const argv = next
            ? ["set", terminal, ctx.sessionManager.getCwd(), `pi --session ${quote(file)}`]
            : ["remove", terminal];
          const result = await pi.exec(helper, argv, { timeout: 10000, maxBuffer: 65536 });
          if (result.code !== 0 || result.killed) throw new Error("helper failed");
        } catch {
          notify("herdr-boot failed; toggle unchanged. Check the restoration file before retrying.", "error");
          return;
        }
        enabled = next;
        show(ctx);
        try {
          pi.appendEntry(ENTRY, {
            sessionId: ctx.sessionManager.getSessionId(), terminal, enabled,
          });
        } catch {
          notify("TXT updated, but toggle state could not be saved in this session.");
        }
        notify(`Restoration ${enabled ? "ON" : "OFF"} for this Pi session.`, "info");
      })();
      try { await pending; } finally { pending = undefined; }
    },
  });
}
