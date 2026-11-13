# Change log and feature inventory

## Unreleased — public-source preparation

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
