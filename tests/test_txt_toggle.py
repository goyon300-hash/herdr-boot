"""Focused set/remove tests: disposable TXT files and fake hc, no live terminals."""
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest
from unittest.mock import patch

BIN = Path(os.environ.get("HERDR_BOOT_TEST_BIN", Path(__file__).resolve().parents[1] / "bin/herdr-boot"))
loader = importlib.machinery.SourceFileLoader("txt_boot", str(BIN))
spec = importlib.util.spec_from_loader(loader.name, loader)
boot = importlib.util.module_from_spec(spec)
loader.exec_module(boot)


def layout(name="Pi one"):
    return {"spaces": [{"id": "s1", "folder": "/workspace", "tabs": [
        {"id": "tab1", "name": name, "root": {"type": "row", "children": [
            {"id": "p1", "type": "block", "content": {"terminal": "t12"}},
            {"id": "p2", "type": "block", "content": {"terminal": "t13"}},
        ]}},
    ]}]}


class TxtToggleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.config = self.root / "restore.txt"
        self.config.write_text('# preserve this comment\n@space /workspace\nserve 1 btop\n"Pi one" 2 echo other\n')
        self.saved = self.config.read_bytes()
        self.work = self.root / "work with 'quotes'"
        self.work.mkdir()
        self.core = patch.object(boot, "core_layout", return_value=layout()).start()
        self.audit = patch.object(boot, "file_effect").start()
        self.addCleanup(patch.stopall)

    def change(self, command="pi --session '/session with spaces.jsonl'", terminal="t12"):
        return boot.edit_config_entry(self.config, terminal, self.work, command)

    def test_set_append_update_remove_preserves_unrelated_lines(self):
        self.assertTrue(self.change()["changed"])
        text = self.config.read_text()
        self.assertTrue(text.startswith(self.saved.decode()))
        self.assertIn('pi --session', text)
        self.assertEqual(self.change()["changed"], False)
        self.change("pi --session /new.jsonl")
        self.assertEqual(len(boot.parse_config(self.config)[1]), 3)
        self.assertIn("/new.jsonl", self.config.read_text())
        self.assertTrue(boot.edit_config_entry(self.config, "t12")["changed"])
        self.assertEqual(self.config.read_bytes(), self.saved)
        self.assertFalse(boot.edit_config_entry(self.config, "t12")["changed"])

    def test_replace_existing_row_and_remove_only_target(self):
        self.change("echo replacement", "t13")
        rows = boot.parse_config(self.config)[1]
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[1][:2], ("Pi one", 2))
        self.assertIn("echo replacement", rows[1][2])
        boot.edit_config_entry(self.config, "t13")
        self.assertEqual(boot.parse_config(self.config)[1], [("serve", 1, "btop")])

    def test_cwd_and_command_quotes_round_trip_without_execution(self):
        marker = self.root / "must-not-exist"
        command = "pi --session " + shlex.quote(str(marker)) + "; touch " + shlex.quote(str(marker))
        self.change(command)
        row = boot.parse_config(self.config)[1][-1][2]
        args = shlex.split(row)
        self.assertEqual(args[:4], ["cd", "--", str(self.work), "&&"])
        self.assertFalse(marker.exists())

    def test_unknown_remote_and_wrong_space_terminals_refused(self):
        for terminal in ["t99", "remote/t12", "../t12", ""]:
            with self.subTest(terminal=terminal), self.assertRaises(boot.BootError):
                self.change(terminal=terminal)
        self.assertEqual(self.config.read_bytes(), self.saved)

    def test_missing_or_nonabsolute_cwd_and_multiline_command_refused(self):
        for cwd in [Path("relative"), self.root / "missing"]:
            with self.assertRaises(boot.BootError):
                boot.edit_config_entry(self.config, "t12", cwd, "pi")
        for command in ["", "pi\nrm x", "pi\rfoo", "pi\0foo"]:
            with self.subTest(command=command), self.assertRaises(boot.BootError):
                self.change(command)
        self.assertEqual(self.config.read_bytes(), self.saved)

    def test_duplicate_names_or_rows_refused(self):
        value = layout()
        value["spaces"][0]["tabs"].append({"id": "other", "name": "Pi one", "root": {"id": "p3", "content": {"terminal": "t14"}}})
        self.core.return_value = value
        with self.assertRaises(boot.BootError):
            self.change()
        self.core.return_value = layout()
        self.config.write_text(self.config.read_text() + '"Pi one" 2 duplicate\n')
        with self.assertRaises(boot.BootError):
            self.change()

    def test_unnamed_tab_refused(self):
        self.core.return_value = layout(None)
        with self.assertRaises(boot.BootError):
            self.change()

    def test_tab_with_apostrophe(self):
        self.core.return_value = layout("Bob's Pi")
        self.change()
        self.assertEqual(boot.parse_config(self.config)[1][-1][0], "Bob's Pi")

    def test_preserves_crlf_and_permissions_and_symlink_target(self):
        self.config.write_bytes(self.saved.replace(b"\n", b"\r\n"))
        self.config.chmod(0o640)
        link = self.root / "link.txt"
        link.symlink_to(self.config)
        boot.edit_config_entry(link, "t12", self.work, "pi")
        self.assertTrue(link.is_symlink())
        self.assertEqual(self.config.stat().st_mode & 0o777, 0o640)
        self.assertNotIn(b"\n", self.config.read_bytes().replace(b"\r\n", b""))

    def test_atomic_failure_leaves_original(self):
        with patch.object(boot.os, "replace", side_effect=OSError("failed")):
            with self.assertRaises(OSError):
                self.change()
        self.assertEqual(self.config.read_bytes(), self.saved)
        self.assertEqual(list(self.root.glob(".restore.txt.*")), [])

    def test_cli_uses_env_config_and_never_launches_command(self):
        fakebin = self.root / "bin"
        fakebin.mkdir()
        hc = fakebin / "hc"
        hc.write_text('#!/usr/bin/env python3\nimport json,sys\nassert sys.argv[1:]==["connect"]\njson.loads(sys.stdin.readline())\nprint(json.dumps({"id":1,"result":{"value":' + repr(layout()) + '}}))\n')
        hc.chmod(0o700)
        audit = fakebin / "agent-change-log"
        audit.write_text("#!/bin/sh\nexit 0\n")
        audit.chmod(0o700)
        env = {"PATH": str(fakebin) + ":/usr/bin:/bin", "HOME": str(self.root), "HERDR_BOOT_CONFIG": str(self.config)}
        result = subprocess.run([str(BIN), "set", "t12", str(self.work), "pi --session /exact.jsonl"], env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)["changed"])
        result = subprocess.run([str(BIN), "remove", "t12"], env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.config.read_bytes(), self.saved)


if __name__ == "__main__":
    unittest.main()
