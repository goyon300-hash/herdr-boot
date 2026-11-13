"""Isolated tests: temporary files and fake CLIs; never alter the real window."""
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

LOADER = importlib.machinery.SourceFileLoader("herdr_boot", str(Path(__file__).resolve().parents[1]/"bin/herdr-boot"))
SPEC = importlib.util.spec_from_loader(LOADER.name, LOADER)
boot = importlib.util.module_from_spec(SPEC)
LOADER.exec_module(boot)


def pane(n, **kw):
    return {"id": "p"+str(n), "type": "block", "content": {"terminal": "t"+str(n)}, **kw}


class Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.dir = Path(self.temp.name)

    def config(self, text):
        p = self.dir / "config.txt"
        p.write_text(text)
        return p

    def test_config_commands_preserved(self):
        p = self.config('# comment\n@space /example\n"My tab" 2 echo "a | b" && true\n')
        self.assertEqual(boot.parse_config(p), ("/example", [("My tab", 2, 'echo "a | b" && true')]))

    def test_config_rejects_duplicates_invalid_numbers_and_missing_space(self):
        for text in ["serve 1 true", "@space /x\ns 0 true", "@space /x\ns 33 true",
                     "@space /x\ns 1 true\ns 1 false", "@space /x\ns 1 true\n@space /y",
                     "@space /x\ns 1 herdr-boot pi shared\ns 2 herdr-boot pi shared"]:
            with self.subTest(text=text), self.assertRaises(boot.BootError):
                boot.parse_config(self.config(text))

    def test_pane_order_stacked_left(self):
        root = {"type": "row", "children": [
            {"type": "column", "children": [pane(1), pane(2)]}, pane(3)]}
        self.assertEqual(boot.ordered_panes(root), [("p1", "t1"), ("p2", "t2"), ("p3", "t3")])

    def test_geometric_order_not_depth_first(self):
        root = {"type": "column", "children": [
            {"type": "row", "children": [pane(1), pane(3)]},
            {"type": "row", "children": [pane(2), pane(4)]}]}
        self.assertEqual([t for p,t in boot.ordered_panes(root)], ["t1", "t2", "t3", "t4"])

    def test_mods_not_numbered_and_unsupported_sizes_rejected(self):
        root = {"type": "row", "children": [pane(1), {"id":"mod","type":"block","content":{"mod":"files"}}, pane(2)]}
        self.assertEqual(len(boot.ordered_panes(root)), 2)
        root["children"][0]["size"] = {"px": 10}
        with self.assertRaises(boot.BootError):
            boot.ordered_panes(root)

    def test_ambiguity_is_an_error(self):
        with self.assertRaises(boot.BootError):
            boot.select_space({"spaces":[{"folder":"/x"},{"folder":"/x"}]}, "/x")
        with self.assertRaises(boot.BootError):
            boot.find_tab({"tabs":[{"name":"s"},{"name":"s"}]}, "s")

    def test_reject_busy_shell(self):
        for value in [{"state":"finished"}, {"state":"live","pid":1,"foreground":{"pid":2,"name":"bash"}},
                      {"state":"live","pid":1,"foreground":{"pid":1,"name":"pi"}}]:
            self.assertFalse(boot.idle_shell(value))

    def test_real_idle_bash_and_shell_token(self):
        proc = subprocess.Popen(["bash", "--norc", "--noprofile"], stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
                                env={"PATH": "/usr/bin:/bin", "HOME": str(self.dir)})
        try:
            # Synchronize with a builtin, not exec readiness or a startup sleep.
            proc.stdin.write("printf 'READY\\n'\n")
            proc.stdin.flush()
            self.assertEqual(proc.stdout.readline(), "READY\n")
            t = {"state":"live", "pid":proc.pid,"foreground":{"name":"bash","pid":proc.pid}}
            self.assertTrue(boot.idle_shell(t))
            self.assertIn(":"+str(proc.pid)+":", boot.shell_token(t))
        finally:
            proc.terminate()
            proc.communicate(timeout=3)

    def test_bind_is_symlink_not_stale_copy(self):
        source = self.dir/"existing.jsonl"
        source.write_text(json.dumps({"type":"session","cwd":str(self.dir)})+"\n")
        with patch.object(boot, "STATE", self.dir/"state"), patch.object(boot,"effect"), patch.object(boot,"file_effect"):
            boot.bind_pi("test", source)
            link = self.dir/"state/pi/test/existing.jsonl"
            self.assertTrue(link.is_symlink())
            source.write_text(source.read_text()+"new data\n")
            self.assertIn("new data", link.read_text())
            with self.assertRaises(boot.BootError):
                boot.bind_pi("test", source)

    def test_pi_slot_name_validation(self):
        for slot in ["../escape", "bad/name", "", "/absolute"]:
            with self.assertRaises(boot.BootError):
                boot.slot_dir(slot)

    def test_plan_does_not_make_changes(self):
        layout = {"spaces":[{"id":"s","folder":"/x","tabs":[]}]}
        with patch.object(boot,"core_layout",return_value=layout), patch.object(boot,"run") as run:
            boot.populate(self.config("@space /x\nnew 3 true"))
            run.assert_not_called()

    def test_apply_creates_and_splits_then_deduplicates(self):
        layout = {"spaces":[{"id":"s","folder":"/x","tabs":[]}]}
        calls = []
        status = {"focused_pane":"p-original"}
        terminal = {"pid":123,"state":"live","keep":True}
        def fake_run(args, **kw):
            calls.append(args)
            if args[:2] == ["herdr-app","status"]:
                return json.dumps(status)
            if args[:2] == ["herdr-app","do"]:
                command, data = args[2], json.loads(args[3])
                tabs = layout["spaces"][0]["tabs"]
                if command == "tab.new":
                    tabs.append({"name":data["name"], "id":"tab", "root":{"type":"row","children":[pane(1)]}})
                    status["focused_pane"] = "p1"
                elif command == "pane.split":
                    tabs[0]["root"]["children"].append(pane(2))
                    status["focused_pane"] = "p2"
                elif command == "pane.focus":
                    status["focused_pane"] = data["pane"]
                return "{}"
            if args[:2] == ["hc","get"]:
                return json.dumps(terminal)
            if args[:2] == ["hc","send"]:
                return "{}"
            raise AssertionError(args)
        p = self.config("@space /x\nnew 2 echo OK")
        with patch.object(boot,"STATE",self.dir/"state"), patch.object(boot,"core_layout",return_value=layout), \
             patch.object(boot,"run",side_effect=fake_run), patch.object(boot,"effect"), patch.object(boot,"file_effect"), \
             patch.object(boot,"idle_shell",return_value=True), patch.object(boot,"shell_token",return_value="boot:123:1"), \
             patch.object(boot.shutil,"which",return_value="/bin/logger"):
            boot.populate(p, apply=True)
            boot.populate(p, apply=True)
        self.assertEqual(sum(c[:2]==["hc","send"] for c in calls), 1)
        self.assertEqual(status["focused_pane"], "p-original")
        self.assertEqual(len(layout["spaces"][0]["tabs"][0]["root"]["children"]),2)

    def test_uncertain_delivery_is_not_retried(self):
        layout = {"spaces":[{"id":"s","folder":"/x","tabs":[{"name":"s","root":pane(1)}]}]}
        sends = []
        def fake_run(args, **kw):
            if args[:2]==["herdr-app","status"]:
                return '{"focused_pane":"p1"}'
            if args[:2]==["hc","get"]:
                return '{"pid":123,"keep":true}'
            if args[:2]==["hc","send"]:
                sends.append(args)
                raise boot.BootError("delivery uncertain")
            self.fail(f"Unexpected call: {args[:2]}")
        config = self.config("@space /x\ns 1 true")
        with patch.object(boot,"STATE",self.dir/"state"), patch.object(boot,"core_layout",return_value=layout), \
             patch.object(boot,"run",side_effect=fake_run), patch.object(boot,"effect"), patch.object(boot,"file_effect"), \
             patch.object(boot,"idle_shell",return_value=True), patch.object(boot,"shell_token",return_value="boot:123:1"), \
             patch.object(boot.shutil,"which",return_value="/bin/logger"):
            with self.assertRaises(boot.BootError):
                boot.populate(config, apply=True)
            boot.populate(config, apply=True)
        self.assertEqual(len(sends), 1)

    def test_busy_pane_never_receives_input(self):
        layout = {"spaces":[{"id":"s","folder":"/x","tabs":[{"name":"s","root":pane(1)}]}]}
        def fake_run(args, **kw):
            if args[:2]==["herdr-app","status"]:
                return '{"focused_pane":"p1"}'
            if args[:2]==["hc","get"]:
                return '{"state":"live","foreground":{"name":"pi"}}'
            self.fail(f"Unexpected mutating call: {args[:2]}")
        with patch.object(boot,"STATE",self.dir/"state"), patch.object(boot,"core_layout",return_value=layout), \
             patch.object(boot,"run",side_effect=fake_run), patch.object(boot,"effect"), \
             patch.object(boot.shutil,"which",return_value="/bin/logger"):
            boot.populate(self.config("@space /x\ns 1 true"), apply=True)
        self.assertFalse((self.dir/"state/started.json").exists())


    def test_empty_quoted_tab_is_a_validation_error(self):
        with self.assertRaises(boot.BootError):
            boot.parse_config(self.config('@space /x\n"" 1 true'))

    def test_nonfinite_split_weights_rejected(self):
        for weights in [(float("nan"), 1), (float("inf"), 1), (1e308, 1e308), (-1, 1)]:
            root = {"type": "row", "children": [
                pane(1, size={"weight": weights[0]}), pane(2, size={"weight": weights[1]})]}
            with self.assertRaises(boot.BootError):
                boot.ordered_panes(root)

    def test_remote_space_rejected(self):
        with self.assertRaises(boot.BootError):
            boot.select_space({"spaces": [{"folder": "/x", "machine": "example-remote"}]}, "/x")

    def test_bash_c_options_are_rejected(self):
        terminal = {"state": "live", "pid": 123, "foreground": {"name": "bash", "pid": 123}}
        for option in [b"-c", b"-ic", b"-lc"]:
            with patch.object(Path, "read_bytes", return_value=b"bash\0" + option + b"\0read line\0"):
                self.assertFalse(boot.idle_shell(terminal))

    def test_session_header_validation(self):
        p = self.dir / "bad.jsonl"
        for header in [{"type": "message", "cwd": str(self.dir)}, {"type": "session", "cwd": "relative"}]:
            p.write_text(json.dumps(header) + "\n")
            with self.assertRaises(boot.BootError):
                boot.session_header(p)

    def test_pi_launch_resumes_newest_session_without_starting_pi(self):
        state = self.dir / "state"
        slot = state / "pi" / "sample"
        slot.mkdir(parents=True)
        latest = slot / "new.jsonl"
        latest.write_text(json.dumps({"type": "session", "cwd": str(self.dir)}) + "\n")
        lock_fd = os.open(self.dir / "lock", os.O_CREAT | os.O_RDWR, 0o600)
        self.addCleanup(os.close, lock_fd)
        with patch.object(boot, "STATE", state), patch.object(boot.os, "open", return_value=lock_fd), \
             patch.object(boot.os, "chdir") as chdir, patch.object(boot, "effect"), \
             patch.object(boot.os, "execvp") as execute:
            boot.launch_pi("sample", ["--", "--model", "example-model"])
        chdir.assert_called_once_with(self.dir)
        execute.assert_called_once_with("pi", ["pi", "--session-dir", str(slot),
            "--session", str(latest), "--model", "example-model"])

    def test_pi_session_override_rejected(self):
        state = self.dir / "state"
        (state / "pi" / "sample").mkdir(parents=True)
        for args in [["--session=/other.jsonl"], ["--mode", "rpc"], ["-p"], ["--no-session"]]:
            lock_fd = os.open(self.dir / "lock", os.O_CREAT | os.O_RDWR, 0o600)
            try:
                with patch.object(boot, "STATE", state), patch.object(boot.os, "open", return_value=lock_fd), \
                     patch.object(boot, "effect"), patch.object(boot.os, "execvp") as execute:
                    with self.assertRaises(boot.BootError):
                        boot.launch_pi("sample", args)
                    execute.assert_not_called()
            finally:
                os.close(lock_fd)


if __name__ == "__main__":
    unittest.main(verbosity=2)
