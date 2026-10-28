#!/usr/bin/env python3
"""Offline whole-/data archive. Use backup.sh for the Compose quiescence gate.

No keys are read from .env. Archives contain private user data; encrypt off-host.
Restore accepts only a NEW target directory, never clears an existing directory.
"""
import argparse
import hashlib
import os
from pathlib import Path, PurePosixPath
import tarfile


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def backup(source, archive):
    source = source.resolve(strict=True)
    archive = archive.absolute()
    if not source.is_dir() or archive.resolve().is_relative_to(source):
        raise ValueError("archive must be outside a data directory")
    checksum = Path(str(archive) + ".sha256")
    if archive.exists() or archive.is_symlink() or checksum.exists() or checksum.is_symlink():
        raise ValueError("backup output already exists")

    def regular_only(member):
        # Reject links/devices rather than producing an archive we cannot safely restore.
        if not (member.isdir() or member.isfile()):
            raise ValueError("data contains a link or special file; archive refused")
        return member

    created = []
    try:
        fd = os.open(archive, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        created.append(archive)
        with os.fdopen(fd, "wb") as output:
            with tarfile.open(fileobj=output, mode="w:gz") as tar:
                tar.add(source, arcname="data", filter=regular_only)
            output.flush()
            os.fsync(output.fileno())
        fd = os.open(checksum, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        created.append(checksum)
        with os.fdopen(fd, "w") as output:
            output.write(digest(archive) + "\n")
            output.flush()
            os.fsync(output.fileno())
    except BaseException:
        for path in created:
            path.unlink(missing_ok=True)
        raise


def restore(archive, target):
    # Do not resolve target: that would follow a symlink to an existing live volume.
    target = target.absolute()
    if target.exists() or target.is_symlink():
        raise ValueError("restore target must not exist (including empty directories)")
    if not target.parent.is_dir():
        raise ValueError("restore target parent must already exist")
    expected = Path(str(archive) + ".sha256").read_text().strip()
    if len(expected) != 64 or expected != digest(archive):
        raise ValueError("archive checksum mismatch")
    with tarfile.open(archive, "r:gz") as tar:
        members = tar.getmembers()
        names = set()
        for member in members:
            path = PurePosixPath(member.name)
            if (path.is_absolute() or ".." in path.parts or not path.parts
                    or path.parts[0] != "data" or member.name in names
                    or not (member.isdir() or member.isfile())):
                raise ValueError("unsafe archive member")
            names.add(member.name)
        if not any(m.name == "data" and m.isdir() for m in members):
            raise ValueError("archive has no data directory")
        for member in members:
            member.name = str(PurePosixPath(*PurePosixPath(member.name).parts[1:]))
        # mkdir is exclusive: refuse even a target created since the initial check.
        target.mkdir(mode=0o700)
        # All member names/types validated above; no links can escape the new root.
        # Numeric ownership is retained when run as root (server uses UID 10001).
        tar.extractall(target, members=members, numeric_owner=True, filter="fully_trusted")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    save = sub.add_parser("backup")
    save.add_argument("source", type=Path)
    save.add_argument("archive", type=Path)
    save.add_argument("--quiesced", action="store_true", required=True,
                      help="assert ALL volume writers are stopped; prefer backup.sh")
    load = sub.add_parser("restore")
    load.add_argument("archive", type=Path)
    load.add_argument("target", type=Path)
    args = parser.parse_args()
    try:
        if args.command == "backup":
            backup(args.source, args.archive)
        else:
            restore(args.archive, args.target)
    except (OSError, ValueError, tarfile.TarError):
        # Do not dump potentially private paths, archive contents or configuration.
        parser.exit(1, "Operation refused or failed; check permissions, checksum, archive safety and NEW target.\n")
    print(f"{args.command} completed")


if __name__ == "__main__":
    main()
