"""Run: python3 -B -m unittest discover -s infra/selfhost -p 'test_*.py' -v"""
import hashlib
import io
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tarfile
import tempfile
import unittest

import volume


class VolumeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.data = self.root / "data"
        self.data.mkdir()
        self.archive = self.root / "backup.tar.gz"

    def test_full_volume_with_committed_wal_and_worker_fixture(self):
        connections = []
        for path in ("ohiyo.db", "kikka/tasks/fixture/pi.sqlite", "kikka/accounts.sqlite"):
            db = self.data / path
            db.parent.mkdir(parents=True, exist_ok=True)
            con = sqlite3.connect(db)
            connections.append(con)
            self.addCleanup(con.close)
            con.execute("PRAGMA journal_mode=WAL")
            con.execute("PRAGMA wal_autocheckpoint=0")
            con.execute("CREATE TABLE fixture (content TEXT)")
            con.execute("INSERT INTO fixture VALUES ('committed in WAL')")
            con.commit()
            self.assertGreater(Path(str(db) + "-wal").stat().st_size, 0)
        # Keep idle connections open so SQLite cannot remove/checkpoint the WAL.
        # No writers run during the copy. This is fixture state, not a Pi execution.
        files = {"uploads/fixture.bin": b"\x00upload\xff", "kikka/tasks/fixture/receipt.json":
                 b'{"status":"uncertain","retry":false}', ".hidden-state": b"preserved"}
        for name, value in files.items():
            path = self.data / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(value)
        before = {str(p.relative_to(self.data)): hashlib.sha256(p.read_bytes()).hexdigest()
                  for p in self.data.rglob("*") if p.is_file()}
        volume.backup(self.data, self.archive)
        self.assertEqual(self.archive.stat().st_mode & 0o777, 0o600)
        restored = self.root / "restored"
        volume.restore(self.archive, restored)
        after = {str(p.relative_to(restored)): hashlib.sha256(p.read_bytes()).hexdigest()
                 for p in restored.rglob("*") if p.is_file()}
        self.assertEqual(before, after)
        for path in ("ohiyo.db", "kikka/tasks/fixture/pi.sqlite", "kikka/accounts.sqlite"):
            with sqlite3.connect(restored / path) as con:
                self.assertEqual(con.execute("PRAGMA integrity_check").fetchone(), ("ok",))
                self.assertEqual(con.execute("SELECT content FROM fixture").fetchone(),
                                 ("committed in WAL",))

    def test_existing_targets_and_outputs_untouched(self):
        (self.data / "sentinel").write_bytes(b"keep")
        volume.backup(self.data, self.archive)
        original = self.archive.read_bytes()
        with self.assertRaises(ValueError):
            volume.backup(self.data, self.archive)
        self.assertEqual(self.archive.read_bytes(), original)
        empty = self.root / "empty"
        empty.mkdir()
        link = self.root / "link"
        link.symlink_to(self.data, target_is_directory=True)
        for target in (self.data, empty, link, self.root / "/"):
            with self.assertRaises(ValueError):
                volume.restore(self.archive, target)
        self.assertEqual((self.data / "sentinel").read_bytes(), b"keep")

    def test_corrupt_archive_refused_before_creating_target(self):
        volume.backup(self.data, self.archive)
        with self.archive.open("ab") as output:
            output.write(b"corrupt")
        target = self.root / "restored"
        with self.assertRaises(ValueError):
            volume.restore(self.archive, target)
        self.assertFalse(target.exists())

    def test_links_and_nested_backup_refused(self):
        with self.assertRaises(ValueError):
            volume.backup(self.data, self.data / "nested.tar.gz")
        (self.data / "link").symlink_to("/etc/passwd")
        with self.assertRaises(ValueError):
            volume.backup(self.data, self.archive)
        self.assertFalse(self.archive.exists())
        self.assertFalse(Path(str(self.archive) + ".sha256").exists())

    def test_unsafe_members_refused_before_creating_target(self):
        for name, kind in (("data/../escape", tarfile.REGTYPE),
                           ("/absolute", tarfile.REGTYPE),
                           ("data/link", tarfile.SYMTYPE),
                           ("data/link", tarfile.LNKTYPE),
                           ("data/pipe", tarfile.FIFOTYPE)):
            with self.subTest(name=name, kind=kind):
                with tarfile.open(self.archive, "w:gz") as tar:
                    root = tarfile.TarInfo("data")
                    root.type = tarfile.DIRTYPE
                    tar.addfile(root)
                    bad = tarfile.TarInfo(name)
                    bad.type = kind
                    bad.linkname = "/etc/passwd"
                    tar.addfile(bad, io.BytesIO(b""))
                Path(str(self.archive) + ".sha256").write_text(volume.digest(self.archive))
                target = self.root / "restored"
                with self.assertRaises(ValueError):
                    volume.restore(self.archive, target)
                self.assertFalse(target.exists())

    def test_backup_wrapper_requires_confirmed_stopped_container(self):
        # Fake Docker checks the shell's stop/inspect gate, not Docker integration.
        here = Path(__file__).parent
        for name in ("backup.sh", "volume.py"):
            shutil.copyfile(here / name, self.root / name)
        docker = self.root / "docker"
        docker.write_text("""#!/bin/sh
echo "$*" >> "$CALL_LOG"
case "$*" in
  *'stop server') exit "${STOP_EXIT:-0}" ;;
  *'ps --all --quiet server') echo "${CONTAINER_ID-fixture}" ;;
  'inspect '*) echo "${CONTAINER_STATE:-exited}" ;;
  *) exit 99 ;;
esac
""")
        docker.chmod(0o700)
        base = {**os.environ, "PATH": str(self.root) + ":" + os.environ["PATH"],
                "CALL_LOG": str(self.root / "calls")}
        for extra in ({"STOP_EXIT": "1"}, {"CONTAINER_STATE": "running"}, {"CONTAINER_ID": ""}):
            result = subprocess.run(["bash", str(self.root / "backup.sh"), str(self.archive)],
                                    env={**base, **extra}, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(self.archive.exists())
        result = subprocess.run(["bash", str(self.root / "backup.sh"), str(self.archive)],
                                env=base, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        calls = (self.root / "calls").read_text()
        self.assertIn("stop server", calls)
        self.assertIn("inspect --format", calls)
        self.assertNotIn("start server", calls)
        self.assertTrue(self.archive.exists())


if __name__ == "__main__":
    unittest.main()
