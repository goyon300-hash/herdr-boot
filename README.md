# herdr-boot

Populate numbered Herdr terminal panes from a trusted text file, and give each Pi pane a dedicated resumable conversation slot. Linux, Python 3.10+, Bash and a running Herdr desktop are required. No Python packages are needed.

This is source packaging of the owner's local launcher, not an official Herdr or Pi project. No license has been selected; publication does not itself grant a license. No owner layout, startup commands, conversations or configuration are included.

## Install (manual, after review)

Install `bin/herdr-boot` into your user executable directory, preserving executable permissions:

```sh
install -Dm755 bin/herdr-boot "$HOME/.local/bin/herdr-boot"
```

Ensure `hc`, `herdr-app`, `pi` (if using slots), and **[`agent-change-log`](https://github.com/goyon300-hash/agent-change-log)** are in PATH. The latter is a separately installed audit CLI, not a standard dependency or bundled implementation. Mutating operations require its `system` and `file create|modify` interfaces; see the calls in the launcher. Do not enable startup until this dependency is supplied and tested. Read-only plan/list do not require it.

Default config: `~/herdr-app_on_boot_run.txt` (retained for compatibility). Override with `HERDR_BOOT_CONFIG` or `--config PATH` **before** the subcommand. Default private state: `${XDG_STATE_HOME:-~/.local/state}/herdr-boot`; override with `HERDR_BOOT_STATE`. Home expansion is supported; state paths become absolute. Do not put state in this repository.

Copy `examples/startup.txt` to a private location and replace the space name with one existing **local** space. There is no automatic creation of spaces.

```sh
herdr-boot list
herdr-boot --config /path/to/private-startup.txt plan
herdr-boot --config /path/to/private-startup.txt apply
```

Plan/list query the running core but do not mutate it. Plan prints commands, so do not store credentials in config or publish its output.

## Configuration and behavior

- Syntax: `@space EXACT_NAME_OR_FOLDER`, then `TAB PANE_NUMBER COMMAND`. Quote tab names containing spaces. Blank lines/full-line comments are ignored.
- Commands are **trusted Bash code**, run using `bash -ic`; the user's shell startup file executes. Never load an untrusted config. Commands stay inside a subshell.
- Pane numbers are geometric left-to-right, then top-to-bottom for equal left edges. Mods are omitted; pixel-sized splits are refused. Limit: 32.
- Missing tabs/panes are created. Existing extra panes/layouts are not removed. Remote, ambiguous or unsupported targets are refused.
- Only live, idle Bash shells without child jobs receive commands. Busy panes are skipped, never interrupted. Avoid typing while applying: inspection and delivery are not atomic.
- Keep is enabled before delivery. A per-shell, per-command ledger reserves delivery **before** sending. Failed/uncertain sends are not retried automatically in the same shell. Inspect the pane and recover manually; do not delete the ledger to blindly retry.
- A changed command has a different reservation and may run again in an idle shell. Removing a row does not stop anything.
- Focus is restored after layout creation. This is startup orchestration, not service supervision. A successful send does not prove a command remained healthy.
- Closing the window differs from closing a pane. Core keeps programs across window closure; recovery after loss/reboot gives new shells, not reruns of old commands. Intentional exit/kill is not recovery.

## Pi slots

```sh
herdr-boot pi example-slot
herdr-boot pi example-slot --model MODEL_ID --thinking high
herdr-boot bind-pi example-slot /path/to/existing-session.jsonl
```

Slots live under private state, `pi/SLOT/`. The newest modified JSONL file in that slot is resumed in its recorded working directory; missing directories are refused. New slots start in the caller's directory. Session/mode selection flags are reserved by the helper. Additional arguments are trusted Pi CLI arguments, **not a sandbox**; pass only reviewed model/resource options, not prompts, export flags or @files.

`bind-pi` validates the session header and creates a **symlink**, not a copy. Future writes are shared. An occupied slot is refused. Keep the original file. A helper-held flock prevents concurrent helper launches for one slot; it cannot detect Pi independently opening the same file. Do not concurrently bind/launch a slot or open its original elsewhere. Neither the slot lock nor recovery resumes an interrupted process in RAM.

Slot CLI/session behavior was reviewed against Pi 1.5.2. Check your installed Pi help when upgrading.

## Opt-in Pi extension: `/revive`

Install the updated helper above, then the extension:

```sh
install -Dm644 pi/revive.ts "$HOME/.pi/agent/extensions/revive.ts"
```

Run `/reload` in an existing Pi, or start Pi normally. `/revive` is an ON/OFF
toggle for the current saved conversation. **New sessions and forks default OFF.**
The footer displays `[REV: on]` or `[REV: off]`; status key `revive` appears
immediately left of `mode` in a footer using descending status-key order.
The extension uses Pi 1.5.2 APIs and has no extra dependencies or background watcher.

It calls these commands without a shell:

```sh
herdr-boot set t12 /absolute/working/directory 'pi --session /absolute/session.jsonl'
herdr-boot remove t12
```

`set` resolves a **local core terminal ID** to its named tab and numbered pane
in the TXT file's configured `@space`. It adds or replaces that row with
`cd -- <quoted cwd> && <command>`. `remove` deletes that row. Other rows and
comments are preserved; neither command launches a program. Updates are locked,
validated and atomically replaced. The command argument is trusted Bash code,
not a sandbox. `--config PATH` (before the subcommand) or `HERDR_BOOT_CONFIG`
selects a different restoration TXT; it must already contain an `@space`.

The extension records the **absolute session file**, not `--continue` or a
latest-session guess. Custom session directories work because the file path is
explicit. A new conversation needs its first message saved before ON is allowed.
The helper is selected by `HERDR_BOOT_BIN`, then `~/.local/bin/herdr-boot`, then
PATH. A failed helper call leaves the toggle unchanged and reports an error.

Only an explicit `/revive` changes the TXT. Starting a new session, quitting Pi,
or closing a terminal does not remove an older entry. Toggle state is remembered
in the Pi session for reload/resume in the same terminal; it is not a live monitor
of manual TXT edits.

**Pane movement/closure:** rows use tab names and pane numbers, not stable pane
identities. Toggle OFF **before** moving, renaming or closing a pane/tab; after a
move, toggle ON again in its new position. Otherwise the old row remains, and
OFF at the new location targets the new position. A closed pane with a saved row
can be recreated on the next `apply`. If already closed, edit the stale TXT row
manually. No automatic registration or per-pane registry is included.

## Optional desktop-login deployment

Review `examples/herdr-boot.service` and `examples/herdr-boot.desktop`. These are templates, **not installed/enabled by this repository**. Install the desktop entry into `~/.config/autostart/` only if you want a login window. Its executable must be available in the desktop session's PATH, or replace Exec with your reviewed absolute executable path.

Install the service into `~/.config/systemd/user/`, adjust the executable/config and PATH, then:

```sh
systemctl --user daemon-reload
systemctl --user enable herdr-boot.service
# Start only when ready to run every configured command:
systemctl --user start herdr-boot.service
journalctl --user -u herdr-boot.service -b
```

The example retries failures until the app is ready; permanent config/dependency errors also retry, so inspect the journal. It remains active after success; edit config then explicitly restart to reapply. Disable with `systemctl --user disable --now herdr-boot.service`; this does not kill launched programs. Disable the desktop entry separately. No root unit or linger is required. Do not enable a second unit alongside an existing boot launcher: adapt the existing unit instead.

The retired `herdr-run-onboot` launcher is intentionally omitted. No live legacy files are removed. This package does not configure shell history, sudoers, services or Pi settings.

## Offline verification

```sh
python3 -B -m unittest discover -s tests -v
node --test tests/test_revive_extension.mjs
```

Tests import the repository executable, use temporary synthetic sessions, mocked CLIs and one isolated Bash process. They never send to live terminals, launch Pi, or contact a model. Tests cover parsing, numbering, invalid weights, remote refusal, busy panes, binding, launch arguments, focus restoration, retry reservations, TXT set/remove and extension toggle lifecycle. A real reboot/login and live application are not tested.
