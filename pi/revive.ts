// Restore saved interactive Pi sessions in Herdr; /revive is a per-session toggle.
// Plain-JS-compatible TypeScript; no package or Pi settings change is required.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const ENTRY = "revive-state";
const quote = (word) => "'" + word.replaceAll("'", "'\\''") + "'";

// Runs in a one-shot systemd user service, not in Pi or its terminal's process tree.
// Any failed/unknown query preserves the entry. Recheck ownership under the TXT lock.
export const quitCheck = `
state=$(systemctl --system is-system-running 2>/dev/null)
case "$state" in running|degraded) ;; *) exit 0 ;; esac
shutdown=$(busctl --system get-property org.freedesktop.login1 /org/freedesktop/login1 org.freedesktop.login1.Manager PreparingForShutdown 2>/dev/null) || exit 0
[ "$shutdown" = "b false" ] || exit 0
exec "$1" remove "$2"
`;

export default function revive(pi, { env = process.env, exists = existsSync } = {}) {
  const local = join(homedir(), ".local", "bin", "herdr-boot");
  const helper = env.HERDR_BOOT_BIN || (exists(local) ? local : "herdr-boot");
  const config = resolve((env.HERDR_BOOT_CONFIG || join(homedir(), "herdr-on-boot.txt")).replace(/^~(?=\/)/, homedir()));
  const terminal = env.HC_TERMINAL_ID;
  const owner = randomUUID();
  let enabled = true;
  let pending;
  let watcher;
  let registered = false;
  let synced = false;

  const valid = (ctx) => ctx.mode === "tui" && /^t[0-9a-z]+$/.test(terminal || "")
    && isAbsolute(ctx.sessionManager.getSessionFile() || "");
  const notify = (ctx, text, level = "warning") => { if (ctx.hasUI) ctx.ui.notify(text, level); };
  const show = (ctx) => {
    if (ctx.mode === "tui") ctx.ui.setStatus("revive", enabled ? "[REV: on]" : "[REV: off]");
  };
  const exec = async (command, args) => {
    const result = await pi.exec(command, args, { timeout: 10000, maxBuffer: 65536 });
    if (result.code !== 0 || result.killed) throw new Error("revive command failed");
  };
  const update = async (ctx, next) => {
    const args = next
      ? ["set", terminal, ctx.sessionManager.getCwd(), `pi --session ${quote(ctx.sessionManager.getSessionFile())}`]
      : ["remove", terminal];
    // Only set claims ownership. Explicit OFF / an unsaved replacement clears
    // the pane's previous entry regardless of its old Pi-run identity.
    await exec("env", ["-u", "HERDR_BOOT_OWNER", `HERDR_BOOT_CONFIG=${config}`,
      ...(next ? [`HERDR_BOOT_OWNER=${owner}`] : []), helper, ...args]);
    registered = next;
  };
  const sync = (ctx) => {
    if (!valid(ctx) || pending || synced) return pending;
    const saved = exists(ctx.sessionManager.getSessionFile());
    pending = (async () => {
      try {
        await update(ctx, enabled && saved);
        synced = !enabled || saved;
      } catch {
        notify(ctx, "herdr-boot failed; restoration entry was not updated.", "error");
        // Retry when the pending session file appears, not every polling tick.
        synced = true;
      }
    })();
    return pending.finally(() => { pending = undefined; });
  };

  pi.on("session_start", async (_event, ctx) => {
    enabled = true;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === ENTRY
          && entry.data?.sessionId === ctx.sessionManager.getSessionId()) {
        enabled = entry.data.enabled !== false;
      }
    }
    show(ctx);
    await sync(ctx);
    // Pi 1.5.2 writes a fresh JSONL only after the first conversation message.
    // Stop polling as soon as it exists, and always dispose on runtime replacement.
    if (valid(ctx) && !exists(ctx.sessionManager.getSessionFile())) {
      watcher = setInterval(() => {
        if (exists(ctx.sessionManager.getSessionFile())) {
          clearInterval(watcher);
          watcher = undefined;
          synced = false;
          void sync(ctx);
        }
      }, 250);
      watcher.unref();
    }
  });

  pi.on("session_shutdown", async (event, ctx) => {
    clearInterval(watcher);
    await pending;
    // Catch a just-created file even when quit precedes the polling tick.
    if (event.reason === "quit" && valid(ctx) && enabled && !registered && exists(ctx.sessionManager.getSessionFile())) {
      synced = false;
      await sync(ctx);
    }
    if (event.reason === "quit" && valid(ctx) && enabled && registered) {
      try {
        await exec("systemd-run", ["--user", "--quiet", "--collect", "--expand-environment=no",
          `--unit=pi-revive-${terminal}-${owner}`, "--on-active=5s",
          "--timer-property=AccuracySec=100ms", "--property=Type=oneshot",
          `--setenv=PATH=${env.PATH || "/usr/local/bin:/usr/bin:/bin"}`,
          `--setenv=HERDR_BOOT_CONFIG=${config}`, `--setenv=HERDR_BOOT_OWNER=${owner}`,
          ...(env.HC_SESSION ? [`--setenv=HC_SESSION=${env.HC_SESSION}`] : []),
          "/bin/sh", "-c", quitCheck, "pi-revive", helper, terminal]);
      } catch {
        notify(ctx, "Could not schedule quit cleanup; restoration entry retained.", "error");
      }
    }
    if (ctx.mode === "tui") ctx.ui.setStatus("revive", undefined);
  });

  pi.registerCommand("revive", {
    description: "Toggle this session's herdr-boot restoration entry (default ON)",
    handler: async (args, ctx) => {
      if ((args || "").trim()) return notify(ctx, "Usage: /revive (ON/OFF toggle)");
      if (!valid(ctx)) return notify(ctx, "/revive needs an interactive, persistent Pi in a local Herdr terminal.");
      if (pending) return notify(ctx, "/revive is already updating the restoration file.");
      const next = !enabled;
      pending = (async () => {
        try {
          await update(ctx, next && exists(ctx.sessionManager.getSessionFile()));
          pi.appendEntry(ENTRY, { sessionId: ctx.sessionManager.getSessionId(), enabled: next });
          enabled = next;
          synced = !next || registered;
          show(ctx);
          notify(ctx, `Restoration ${enabled ? "ON" : "OFF"} for this Pi session.`, "info");
        } catch {
          notify(ctx, "Could not update/save restoration toggle; check the TXT before retrying.", "error");
        }
      })();
      try { await pending; } finally { pending = undefined; }
    },
  });
}
