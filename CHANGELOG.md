# Change log and feature inventory

## Unreleased — automatic TXT restoration for Pi 1.5.2

- Added `revive.ts`: new interactive Herdr sessions default ON and register their exact saved JSONL; session replacement updates the panel entry and clears stale unsaved-session entries.
- Kept `/revive` as a per-session toggle; OFF removes immediately and survives resume, including in another panel.
- Added a five-second external systemd user timer on quit. Removal requires running/degraded systemd, logind not preparing shutdown, and matching Pi-run ownership; unknown states preserve entries.
- Added locked owner markers and row fingerprints to `herdr-boot set/remove`, including safe removal after a pane disappears and protection against stale timers.
- Documented configuration and added focused extension/helper tests. Live Ctrl+D and the Herdr x-button command removed entries; an actual reboot remains for the owner to verify.

## Previous — explicit Pi restoration toggle

- Added `herdr-boot set TERMINAL CWD COMMAND` and `remove TERMINAL` for locked, atomic edits to the existing restoration TXT; no program execution or automatic registration.
- Added optional `pi/revive.ts`: `/revive` toggles the current exact saved session, new sessions/forks start OFF, and `[REV: on/off]` is exposed through Pi's footer status API.
- Added focused TXT and extension lifecycle tests; documented positional-pane limitations and the requirement to disable before moving or closing a pane.
- Published the conservative live launcher as the base. Separate unfinished automatic-registry experiments are not included; existing boot/apply behavior is unchanged.

## Previous — public-source preparation

- Collected the owner's local Python launcher and offline regression tests; retained command/config/state compatibility and existing audit calls.
- Configurable config/state paths; normalize state paths before Pi changes working directory.
- Fixed empty quoted tab names raising IndexError; reject NaN/infinite/overflowing split weights.
- Fixed idle-shell detection incorrectly treating long options such as --norc as Bash -c. Synchronize/sanitize the real-Bash regression test instead of racing startup.
- Explicitly refuse remote spaces; audit restored focus and persistent apply-lock creation.
- Preflight audit dependency before CLI mutations.
- Made tests repository-relative; added regression tests for validation and mocked Pi execution.
- Replaced private workstation documentation with generic setup, deployment and safety instructions.
- Included safe config, desktop-entry and user-service examples, without enabling them.

Features inherited from the inspected launcher: geometric pane ordering, tab/split creation, idle-Bash protection, keep enablement, pre-send deduplication ledger, focus restoration, symlink session binding and per-slot Pi process locks.

No upstream license/copyright notices were present in the inspected local launcher or tests. No license is added. Herdr/Pi are external dependencies; their source, notices and private state are not bundled.
