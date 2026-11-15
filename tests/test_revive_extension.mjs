import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const source = readFileSync(new URL("../pi/revive.ts", import.meta.url), "utf8");
const { default: revive, quitCheck } = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));

function host(options = {}) {
  const handlers = {}, commands = {}, statuses = new Map(), notes = [], calls = [], entries = options.entries || [];
  const session = { id: "session-a", file: "/tmp/a'b session.jsonl", cwd: "/tmp/session cwd" };
  const ctx = {
    mode: options.mode || "tui", hasUI: true,
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
  revive(pi, { env: { HC_TERMINAL_ID: "t12", HERDR_BOOT_BIN: "/fake/herdr-boot", HERDR_BOOT_CONFIG: "/tmp/boot.txt", ...options.env }, exists: options.exists ?? (() => true) });
  return { handlers, statuses, notes, calls, entries, session, ctx,
    start: (reason = "startup") => handlers.session_start({ reason }, ctx),
    stop: (reason = "quit") => handlers.session_shutdown({ reason }, ctx),
    toggle: (args = "") => commands.revive.handler(args, ctx) };
}
const helperArgs = (call) => call[1].slice(call[1].indexOf("/fake/herdr-boot") + 1);

test("default ON registers the exact session and cwd with a fresh run owner", async () => {
  const h = host(); await h.start();
  assert.equal(h.statuses.get("revive"), "[REV: on]");
  assert.deepEqual(helperArgs(h.calls[0]).slice(0, 3), ["set", "t12", h.session.cwd]);
  const parsed = spawnSync("python3", ["-c", "import shlex,json,sys; print(json.dumps(shlex.split(sys.argv[1])))", helperArgs(h.calls[0])[3]], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(parsed.stdout), ["pi", "--session", h.session.file]);
  assert.match(h.calls[0][1].find(v => v.startsWith("HERDR_BOOT_OWNER=")), /^HERDR_BOOT_OWNER=[0-9a-f-]{36}$/);
});

test("OFF removes immediately and follows the session to another terminal; fork defaults ON", async () => {
  const h = host(); await h.start(); await h.toggle();
  assert.deepEqual(helperArgs(h.calls.at(-1)), ["remove", "t12"]);
  assert.equal(h.statuses.get("revive"), "[REV: off]");
  const resumed = host({ entries: h.entries, env: { HC_TERMINAL_ID: "t99" } });
  await resumed.start("resume");
  assert.equal(resumed.statuses.get("revive"), "[REV: off]");
  assert.deepEqual(helperArgs(resumed.calls[0]), ["remove", "t99"]);
  await resumed.stop();
  assert.equal(resumed.calls.some(c => c[0] === "systemd-run"), false);
  const fork = host({ entries: h.entries }); fork.session.id = "fork-id"; await fork.start("fork");
  assert.equal(fork.statuses.get("revive"), "[REV: on]");
});

test("new/resume/fork/reload register the replacement and never schedule quit cleanup", async () => {
  for (const reason of ["new", "resume", "fork", "reload"]) {
    const h = host(); h.session.id = reason; h.session.file = `/tmp/${reason}.jsonl`;
    await h.start(reason); await h.stop(reason);
    assert.match(helperArgs(h.calls[0])[3], new RegExp(reason + "\\.jsonl"));
    assert.equal(h.calls.length, 1);
  }
});

test("unsaved /new clears stale row; file appearance registers without another message", async () => {
  let saved = false;
  const h = host({ exists: () => saved }); await h.start("new");
  assert.deepEqual(helperArgs(h.calls[0]), ["remove", "t12"]);
  saved = true;
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(helperArgs(h.calls.at(-1))[0], "set");
  await h.stop("reload");
});

test("quit schedules an external five-second systemd timer with matching owner and no shell expansion", async () => {
  const h = host(); await h.start(); await h.stop();
  const timer = h.calls.at(-1);
  assert.equal(timer[0], "systemd-run");
  assert.ok(timer[1].includes("--on-active=5s"));
  assert.ok(timer[1].includes("--expand-environment=no"));
  const owner = h.calls[0][1].find(v => v.startsWith("HERDR_BOOT_OWNER="));
  assert.ok(timer[1].includes(`--setenv=${owner}`));
  assert.equal(timer[1].at(-3), "pi-revive");
  assert.equal(timer[1].at(-2), "/fake/herdr-boot");
  assert.equal(timer[1].at(-1), "t12");
});

test("timer failure retains entry; helper failure does not persist a toggle", async () => {
  let fail = false;
  const h = host({ exec: () => ({ code: fail ? 1 : 0 }) }); await h.start(); fail = true;
  await h.toggle(); assert.equal(h.entries.length, 0);
  assert.equal(h.statuses.get("revive"), "[REV: on]");
  await h.stop(); assert.match(h.notes.at(-1)[0], /retained/);
});

test("non-TUI, non-Herdr and ephemeral sessions never register", async () => {
  for (const options of [{ mode: "rpc" }, { env: { HC_TERMINAL_ID: "remote/t12" } }, { env: { HC_TERMINAL_ID: "" } }]) {
    const h = host(options); await h.start(); await h.stop(); assert.equal(h.calls.length, 0);
  }
  const h = host(); h.session.file = undefined; await h.start(); await h.toggle(); await h.stop();
  assert.equal(h.calls.length, 0);
});

test("quit guard removes only for running/degraded plus known false logind", () => {
  const dir = mkdtempSync(join(tmpdir(), "revive-guard-"));
  try {
    for (const [name, script] of Object.entries({
      systemctl: '#!/bin/sh\nprintf "%s\\n" "$TEST_STATE"\nexit "$TEST_STATE_CODE"\n',
      busctl: '#!/bin/sh\nprintf "%s\\n" "$TEST_SHUTDOWN"\nexit "$TEST_BUS_CODE"\n',
      helper: '#!/bin/sh\n[ "$1" = remove ] && [ "$2" = t12 ] && printf REMOVED\n',
    })) { writeFileSync(join(dir, name), script); chmodSync(join(dir, name), 0o700); }
    for (const [state, shutdown, stateCode, busCode, expected] of [
      ["running", "b false", 0, 0, true], ["degraded", "b false", 1, 0, true],
      ["stopping", "b false", 1, 0, false], ["running", "b true", 0, 0, false],
      ["unknown", "b false", 1, 0, false], ["", "b false", 1, 0, false],
      ["running", "", 0, 1, false], ["running", "b false", 0, 1, false],
    ]) {
      const r = spawnSync("/bin/sh", ["-c", quitCheck, "pi-revive", join(dir, "helper"), "t12"], {
        env: { PATH: dir, TEST_STATE: state, TEST_SHUTDOWN: shutdown, TEST_STATE_CODE: String(stateCode), TEST_BUS_CODE: String(busCode) }, encoding: "utf8",
      });
      assert.equal(r.stdout.includes("REMOVED"), expected, `${state}/${shutdown}/${busCode}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
