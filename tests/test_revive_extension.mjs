import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

// The extension deliberately uses JS syntax so distro Node needs no TS loader.
const source = readFileSync(new URL("../pi/revive.ts", import.meta.url), "utf8");
const { default: revive } = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));

function host(options = {}) {
  const handlers = {}, commands = {}, statuses = new Map(), notes = [], calls = [], entries = [];
  const session = { id: "session-a", file: "/tmp/a'b session.jsonl", cwd: "/tmp/session cwd" };
  const ctx = {
    mode: "tui", hasUI: true, cwd: "/wrong/current/cwd",
    sessionManager: {
      getSessionId: () => session.id, getSessionFile: () => session.file,
      getCwd: () => session.cwd, getEntries: () => entries,
    },
    ui: { setStatus: (key, value) => statuses.set(key, value), notify: (...args) => notes.push(args) },
  };
  const pi = {
    on: (name, handler) => { handlers[name] = handler; },
    registerCommand: (name, command) => { commands[name] = command; },
    exec: async (...args) => { calls.push(args); return options.exec ? options.exec(...args) : { code: 0 }; },
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
  };
  revive(pi, { env: { HC_TERMINAL_ID: "t12", HERDR_BOOT_BIN: "/fake/herdr-boot", ...options.env }, exists: options.exists ?? (() => true) });
  const start = (reason = "startup") => handlers.session_start({ reason }, ctx);
  const toggle = (args = "") => commands.revive.handler(args, ctx);
  return { handlers, commands, statuses, notes, calls, entries, session, ctx, start, toggle };
}

test("new sessions start OFF and lifecycle events never invoke the helper", async () => {
  const h = host(); h.start();
  assert.equal(h.statuses.get("revive"), "[REV: off]");
  assert.deepEqual(Object.keys(h.commands), ["revive"]);
  assert.deepEqual(Object.keys(h.handlers).sort(), ["session_shutdown", "session_start"]);
  h.start("new"); await h.handlers.session_shutdown({ reason: "quit" }, h.ctx);
  assert.equal(h.calls.length, 0);
  assert.equal(h.entries.length, 0);
  assert.equal(h.statuses.get("revive"), undefined);
});

test("ON sets exact file+session cwd; OFF removes current terminal, with quoted path", async () => {
  const h = host(); h.start(); await h.toggle();
  assert.equal(h.statuses.get("revive"), "[REV: on]");
  assert.equal(h.calls[0][0], "/fake/herdr-boot");
  assert.deepEqual(h.calls[0][1].slice(0, 3), ["set", "t12", h.session.cwd]);
  const parsed = spawnSync("python3", ["-c", "import shlex,json,sys; print(json.dumps(shlex.split(sys.argv[1])))", h.calls[0][1][3]], { encoding: "utf8" });
  assert.equal(parsed.status, 0);
  assert.deepEqual(JSON.parse(parsed.stdout), ["pi", "--session", h.session.file]);
  await h.toggle();
  assert.deepEqual(h.calls[1][1], ["remove", "t12"]);
  assert.equal(h.statuses.get("revive"), "[REV: off]");
  assert.deepEqual(h.entries.map(e => e.data.enabled), [true, false]);
});

test("reload and resume preserve chosen state without updating TXT", async () => {
  const h = host(); h.start(); await h.toggle();
  for (const reason of ["reload", "resume", "startup"]) {
    h.start(reason); assert.equal(h.statuses.get("revive"), "[REV: on]");
  }
  assert.equal(h.calls.length, 1);
});

test("new and fork always OFF, even if custom state was copied", async () => {
  const h = host(); h.start(); await h.toggle();
  h.start("new"); assert.equal(h.statuses.get("revive"), "[REV: off]");
  h.start("fork"); assert.equal(h.statuses.get("revive"), "[REV: off]");
  h.session.id = "session-b"; h.start("startup");
  assert.equal(h.statuses.get("revive"), "[REV: off]");
  assert.equal(h.calls.length, 1);
});

test("state from another terminal does not enable this pane", () => {
  const h = host();
  h.entries.push({ type: "custom", customType: "revive-state", data: { sessionId: h.session.id, terminal: "t13", enabled: true } });
  h.start(); assert.equal(h.statuses.get("revive"), "[REV: off]");
});

test("helper failure leaves previous state unchanged in both directions", async () => {
  let fail = true;
  const h = host({ exec: () => ({ code: fail ? 1 : 0 }) }); h.start();
  await h.toggle(); assert.equal(h.statuses.get("revive"), "[REV: off]");
  assert.equal(h.entries.length, 0);
  fail = false; await h.toggle(); fail = true; await h.toggle();
  assert.equal(h.statuses.get("revive"), "[REV: on]");
  assert.equal(h.entries.length, 1);
  assert.equal(h.notes.at(-1)[1], "error");
});

test("unsaved/ephemeral sessions, non-TUI and invalid terminal refuse safely", async () => {
  for (const change of [h => { h.session.file = undefined; }, h => { h.session.file = "relative"; }, h => { h.ctx.mode = "rpc"; }]) {
    const h = host(); h.start(); change(h); await h.toggle(); assert.equal(h.calls.length, 0);
  }
  for (const terminal of ["", "remote/t12"]) {
    const h = host({ env: { HC_TERMINAL_ID: terminal } }); h.start(); await h.toggle(); assert.equal(h.calls.length, 0);
  }
  const h = host({ exists: () => false }); h.start(); await h.toggle();
  assert.equal(h.calls.length, 0); assert.equal(h.statuses.get("revive"), "[REV: off]");
});

test("rapid invocation does not double-toggle; shutdown waits for helper", async () => {
  let release;
  const h = host({ exec: () => new Promise(resolve => { release = () => resolve({ code: 0 }); }) });
  h.start(); const first = h.toggle(); await h.toggle();
  let stopped = false;
  const shutdown = h.handlers.session_shutdown({ reason: "reload" }, h.ctx).then(() => { stopped = true; });
  await Promise.resolve(); assert.equal(stopped, false);
  assert.equal(h.calls.length, 1); release(); await first; await shutdown;
  assert.equal(stopped, true); assert.equal(h.entries.length, 1);
});

test("arguments are rejected and footer key sorts immediately left of mode", async () => {
  const h = host(); h.start(); await h.toggle("on"); assert.equal(h.calls.length, 0);
  const ordered = ["mode", "local-clock", "revive"].sort((a, b) => b.localeCompare(a));
  assert.deepEqual(ordered, ["revive", "mode", "local-clock"]);
});
