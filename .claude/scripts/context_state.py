#!/usr/bin/env python3
"""Serialize and atomically update shared repository context state."""

from __future__ import annotations

import argparse
import contextlib
import datetime
import hashlib
import json
import math
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Callable, Iterator, NamedTuple, Sequence

try:
    import fcntl
except ImportError:  # pragma: no cover - exercised only on unsupported platforms
    fcntl = None  # type: ignore[assignment]


DEFAULT_LOCK_TIMEOUT_SECONDS = 10.0
LOCK_POLL_SECONDS = 0.05
SHA256_PATTERN = re.compile(r"[0-9a-f]{64}\Z")
GIT_SHA_PATTERN = re.compile(r"[0-9a-f]{40}\Z")
MONTH_PATTERN = re.compile(r"(\d{4})-(0[1-9]|1[0-2])\Z")
TASK_NAME_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*\Z")
MIGRATION_NUMBER_PATTERN = re.compile(r"(?:0|[1-9]\d*)\Z")
MIGRATION_FILE_PATTERN = re.compile(r"(\d+)_.*\.sql\Z")
MIGRATION_FIELD_PATTERN = re.compile(rb"(?m)^\*\*Migration numbers:\*\* *(.*)$")
TASK_FIELD = re.compile(r"^\*\*([^*]+):\*\*\s*(.*?)\s*$", re.M)
DELIVERY_FIELDS = (
    "Verified at",
    "Reviewed at",
    "Integrated at",
    "Published",
    "Releases with",
)
DELIVERY_EVIDENCE = re.compile(
    r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z @ [0-9a-f]{40}\Z"
)
ACTIVE_TASK_STATUSES = {"assigned", "in-progress"}
TERMINAL_TASK_STATUSES = {"dropped", "parked"}
DEFAULT_STALE_HOURS = 3.0
SECONDS_PER_HOUR = 3600
TASK_STATUSES = ACTIVE_TASK_STATUSES | TERMINAL_TASK_STATUSES | {"done"}
ACTIVITY_FIELD = re.compile(r"^\*\*([^*\n]+):\*\*[ \t]*(.*?)[ \t]*$", re.M)


class ContextStateError(Exception):
    """A safe context-state operation could not be completed."""


def _run_git(*args: str) -> bytes:
    try:
        result = subprocess.run(
            ["git", *args],
            check=True,
            capture_output=True,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        raise ContextStateError(
            "Could not resolve repository state with git; run this command inside a Git "
            "working tree, fix the reported Git error, and retry."
        ) from exc
    return result.stdout


def _repository_paths() -> tuple[Path, Path]:
    super_text = _run_git("rev-parse", "--show-superproject-working-tree").decode().strip()
    if super_text:
        top_text = _run_git("rev-parse", "--show-toplevel").decode().strip()
        common_text = _run_git("rev-parse", "--git-common-dir").decode().strip()
        if top_text and common_text:
            common = Path(common_text)
            if not common.is_absolute():
                common = Path.cwd() / common
            common = common.resolve()
            main = Path(top_text).resolve()
            if common.is_dir() and main.is_dir():
                return main, common
        raise ContextStateError(
            "Could not resolve this submodule's checkout; repair the submodule and retry."
        )

    common_text = _run_git("rev-parse", "--git-common-dir").decode().strip()
    if not common_text:
        raise ContextStateError(
            "Git returned an empty common directory; repair the working tree and retry."
        )
    common = Path(common_text)
    if not common.is_absolute():
        common = Path.cwd() / common
    common = common.resolve()
    main = common.parent.resolve()
    if not common.is_dir() or not main.is_dir():
        raise ContextStateError(
            "The Git common directory does not identify a canonical main checkout; "
            "repair the worktree and retry."
        )
    return main, common


def _validate_relative_path(value: str) -> Path:
    candidate = Path(value)
    if not value or candidate.is_absolute() or candidate == Path(".") or ".." in candidate.parts:
        raise ContextStateError(
            "Target path must be a non-empty repo-relative path without '..'; "
            "pass a path below the canonical main checkout."
        )
    return candidate


def _path_below(root: Path, relative: Path) -> Path:
    target = (root / relative).resolve(strict=False)
    try:
        target.relative_to(root)
    except ValueError as exc:
        raise ContextStateError(
            "Target path resolves outside the canonical main checkout; remove the escaping "
            "symlink or choose a repo-relative path below the repository."
        ) from exc
    return target


def _canonical_path(value: str) -> Path:
    main, _ = _repository_paths()
    return _path_below(main, _validate_relative_path(value))


def _lock_path(target: Path) -> Path:
    main, common = _repository_paths()
    try:
        relative = target.relative_to(main)
    except ValueError as exc:
        raise ContextStateError(
            "Lock target is outside the canonical main checkout; choose a repository path."
        ) from exc
    digest = hashlib.sha256(relative.as_posix().encode("utf-8")).hexdigest()
    lock_directory = common / "context-state-locks"
    lock_directory.mkdir(mode=0o700, exist_ok=True)
    return lock_directory / f"{digest}.lock"


@contextlib.contextmanager
def _exclusive_lock(
    target: Path, timeout: float, lock_path: Path | None = None
) -> Iterator[None]:
    if fcntl is None:
        raise ContextStateError(
            "This platform does not provide fcntl.flock; run the helper on Linux or macOS."
        )
    if timeout < 0:
        raise ContextStateError("Lock timeout must be non-negative; pass --lock-timeout 10.")
    lock_path = lock_path or _lock_path(target)
    deadline = time.monotonic() + timeout
    try:
        lock_file = lock_path.open("a+b")
    except OSError as exc:
        raise ContextStateError(
            f"Could not open context-state lock {lock_path}; fix its permissions and retry."
        ) from exc
    locked = False
    try:
        while True:
            try:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                locked = True
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise ContextStateError(
                        f"Timed out after {timeout:g}s waiting for the context-state lock; "
                        "let the active writer finish, then retry."
                    ) from None
                time.sleep(min(LOCK_POLL_SECONDS, max(0.0, deadline - time.monotonic())))
            except OSError as exc:
                raise ContextStateError(
                    f"Could not acquire context-state lock {lock_path}; fix its permissions "
                    "and retry."
                ) from exc
        yield
    finally:
        try:
            if locked:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
        finally:
            lock_file.close()


@contextlib.contextmanager
def _migration_reservation_lock(timeout: float) -> Iterator[None]:
    """Serialize every migration-number allocation in this repository."""
    main, _ = _repository_paths()
    with _exclusive_lock(main / ".claude/tasks", timeout):
        yield


def _read_input(path_text: str, description: str) -> bytes:
    path = Path(path_text)
    try:
        if not path.is_file():
            raise OSError("not a regular file")
        return path.read_bytes()
    except OSError as exc:
        raise ContextStateError(
            f"Could not read {description} file {path}; provide a readable regular file and retry."
        ) from exc


def _fsync_directory(directory: Path) -> None:
    descriptor = os.open(str(directory), os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _ensure_directory_durable(directory: Path, root: Path) -> None:
    try:
        directory.relative_to(root)
    except ValueError as exc:
        raise ContextStateError(
            f"Directory {directory} is outside the canonical main checkout; choose a "
            "repository path and retry."
        ) from exc
    missing = []
    current = directory
    while not current.exists():
        missing.append(current)
        current = current.parent
    if not current.is_dir():
        raise ContextStateError(
            f"Cannot create directory {directory} because {current} is not a directory; "
            "repair the path and retry."
        )
    for path in reversed(missing):
        try:
            path.mkdir()
            _fsync_directory(path.parent)
        except OSError as exc:
            raise ContextStateError(
                f"Could not durably create directory {path}; inspect the path, fix disk or "
                "permissions, and retry."
            ) from exc


def _atomic_replace(
    target: Path,
    content: bytes,
    before_replace: Callable[[], None] | None = None,
    root: Path | None = None,
) -> None:
    _ensure_directory_durable(target.parent, root or _repository_paths()[0])
    temporary_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile(dir=str(target.parent), delete=False) as temporary:
            temporary_name = temporary.name
            temporary.write(content)
            temporary.flush()
            os.fsync(temporary.fileno())
        if target.exists():
            os.chmod(temporary_name, target.stat().st_mode & 0o777)
        if before_replace is not None:
            before_replace()
        os.replace(temporary_name, target)
        temporary_name = None
        try:
            _fsync_directory(target.parent)
        except OSError as exc:
            raise ContextStateError(
                f"Replacement of {target} completed, but its directory could not be synced; "
                "completion is ambiguous. Inspect the target before continuing and do not "
                "blindly retry."
            ) from exc
    except ContextStateError:
        raise
    except OSError as exc:
        raise ContextStateError(
            f"Could not atomically replace {target}; check disk space and permissions, then retry."
        ) from exc
    finally:
        if temporary_name is not None:
            try:
                os.unlink(temporary_name)
            except FileNotFoundError:
                pass


# Three heading forms are in PROGRESS.md today: bare `### 2026-08-23:`, bracketed
# `### [2026-08-23]:`, and bare-with-time `### 2026-08-16 06:00Z:`. Anchoring on the
# date alone matches all three; requiring the colon drops the timestamped form, and a
# file whose newest entry uses it falls back to offset 0 — the prepend-above-the-title
# bug this helper exists to prevent.
_ENTRY_START = re.compile(
    rb"^### (?:\[\d{4}-\d{2}-\d{2}\]|\d{4}-\d{2}-\d{2})",
    re.M,
)


def _insert_point(existing: bytes) -> int:
    """Byte offset of the first dated entry — new records go immediately above it.

    A raw prepend at offset 0 pushes the document's own title and metadata below
    every record written. Measured on tiktok-monitor 2026-08-16: `# Development
    Progress` had sunk to line 490 of PROGRESS.md, with 24 entries stranded above
    it and the same dates appearing on both sides of the header. Inserting above
    the first ENTRY instead of above the FILE keeps newest-first ordering and
    leaves the header where a reader expects it.

    When the file has no dated entry at all, the offset is 0 — a plain prepend,
    exactly as before. This helper only ever moves the insertion point DOWN past a
    header, never past content it cannot identify, so the "prepend" contract holds
    for every caller that is not writing dated log entries.
    """
    m = _ENTRY_START.search(existing)
    return m.start() if m else 0


def _prepend(path_text: str, record_file: str, lock_timeout: float) -> None:
    target = _canonical_path(path_text)
    record = _read_input(record_file, "record")
    with _exclusive_lock(target, lock_timeout):
        try:
            existing = target.read_bytes() if target.exists() else b""
        except OSError as exc:
            raise ContextStateError(
                f"Could not read {target}; fix its permissions and retry."
            ) from exc
        at = _insert_point(existing)
        head = existing[:at]
        if head and not head.endswith(b"\n"):
            head += b"\n"
        _atomic_replace(target, head + record + existing[at:])


def _validate_expected_sha(expected_sha: str) -> None:
    if expected_sha != "missing" and SHA256_PATTERN.fullmatch(expected_sha) is None:
        raise ContextStateError(
            "Expected SHA must be 'missing' or exactly 64 lowercase hexadecimal characters; "
            "recompute SHA-256 and retry."
        )


def _require_expected_sha(target: Path, path_text: str, expected_sha: str) -> None:
    if expected_sha == "missing":
        if target.exists():
            raise ContextStateError(
                f"{path_text} already exists; re-read it and retry with its current SHA-256."
            )
        return
    if not target.is_file():
        raise ContextStateError(
            f"{path_text} changed because it is now missing or not a regular file; "
            "re-read repository state and retry."
        )
    try:
        actual_sha = hashlib.sha256(target.read_bytes()).hexdigest()
    except OSError as exc:
        raise ContextStateError(
            f"Could not read {path_text}; fix its permissions and retry."
        ) from exc
    if actual_sha != expected_sha:
        raise ContextStateError(
            f"{path_text} changed after the replacement was prepared; re-read it, "
            "reapply the intended edit, and retry with the new SHA-256."
        )


def _replace_if_hash(
    path_text: str,
    expected_sha: str,
    content_file: str,
    lock_timeout: float,
) -> None:
    _validate_expected_sha(expected_sha)
    target = _canonical_path(path_text)
    content = _read_input(content_file, "replacement content")
    with _exclusive_lock(target, lock_timeout):
        _require_expected_sha(target, path_text, expected_sha)
        _atomic_replace(
            target,
            content,
            before_replace=lambda: _require_expected_sha(target, path_text, expected_sha),
        )


def _validate_task_name(task: str) -> str:
    if TASK_NAME_PATTERN.fullmatch(task) is None:
        raise ContextStateError(
            "Task name must use only letters, digits, dots, underscores, and hyphens; "
            "pass the task filename without .md."
        )
    return task


def _validate_migration_number(number: str) -> int:
    if MIGRATION_NUMBER_PATTERN.fullmatch(number) is None:
        raise ContextStateError(
            "Migration number must be a non-negative decimal integer; pass a number such as 181."
        )
    return int(number)


def _migration_numbers(content: bytes, path: Path) -> set[int]:
    matches = MIGRATION_FIELD_PATTERN.findall(content)
    if len(matches) > 1:
        raise ContextStateError(
            f"Task record {path.name} has more than one Migration numbers field; reconcile it first."
        )
    if not matches:
        return set()
    value = matches[0].decode("utf-8", errors="strict").strip()
    if value in {"", "none"}:
        return set()
    numbers: set[int] = set()
    for item in value.split(","):
        text = item.strip()
        if MIGRATION_NUMBER_PATTERN.fullmatch(text) is None:
            raise ContextStateError(
                f"Task record {path.name} has invalid Migration numbers value {value!r}; reconcile it first."
            )
        numbers.add(int(text))
    return numbers


def _task_records(main: Path) -> list[Path]:
    tasks = _path_below(main, Path(".claude/tasks"))
    if not tasks.is_dir():
        return []
    return sorted(path for path in tasks.rglob("*.md") if path.is_file() and not path.is_symlink())


def _find_task_record(main: Path, task: str) -> Path:
    records = [path for path in _task_records(main) if path.name == f"{task}.md"]
    if not records:
        raise ContextStateError(
            f"No canonical task record exists for {task!r}; create .claude/tasks/{task}.md before reserving."
        )
    if len(records) > 1:
        names = ", ".join(path.relative_to(main).as_posix() for path in records)
        raise ContextStateError(
            f"Task record {task!r} is ambiguous across live/archive paths ({names}); reconcile it first."
        )
    return records[0]


def _migration_file_numbers(main: Path, migration_root: str) -> set[int]:
    root = _path_below(main, _validate_relative_path(migration_root))
    if not root.is_dir():
        raise ContextStateError(
            f"Migration root {migration_root} is not a directory; pass this repository's SQL migration path."
        )
    numbers = set()
    for path in root.glob("*.sql"):
        match = MIGRATION_FILE_PATTERN.fullmatch(path.name)
        if match:
            numbers.add(int(match.group(1)))
    return numbers


def _updated_migration_field(content: bytes, number: int) -> bytes:
    match = MIGRATION_FIELD_PATTERN.search(content)
    if match is None:
        line_end = b"" if content.endswith(b"\n") else b"\n"
        return content + line_end + f"**Migration numbers:** {number}\n".encode()
    existing = _migration_numbers(content, Path("task record"))
    updated = ", ".join(str(value) for value in sorted(existing | {number}))
    return content[:match.start(1)] + updated.encode() + content[match.end(1):]


def _reserve_migration(
    task: str,
    number_text: str,
    migration_root: str,
    lock_timeout: float,
) -> None:
    task = _validate_task_name(task)
    number = _validate_migration_number(number_text)
    main, _ = _repository_paths()
    with _migration_reservation_lock(lock_timeout):
        target = _find_task_record(main, task)
        with _exclusive_lock(target, lock_timeout):
            current = target.read_bytes()
            current_hash = hashlib.sha256(current).hexdigest()
            owners: dict[int, list[Path]] = {}
            for record in _task_records(main):
                for reserved in _migration_numbers(record.read_bytes(), record):
                    owners.setdefault(reserved, []).append(record)
            current_numbers = _migration_numbers(current, target)
            owner_paths = owners.get(number, [])
            if any(path != target for path in owner_paths):
                names = ", ".join(path.relative_to(main).as_posix() for path in owner_paths)
                raise ContextStateError(
                    f"Migration number {number} is already reserved by {names}; choose another number."
                )
            if number in current_numbers:
                return
            if number in _migration_file_numbers(main, migration_root):
                raise ContextStateError(
                    f"Migration number {number} already has an SQL file; create a new task reservation number."
                )
            updated = _updated_migration_field(current, number)
            _atomic_replace(
                target,
                updated,
                before_replace=lambda: _require_expected_sha(
                    target, target.relative_to(main).as_posix(), current_hash
                ),
            )


def _task_acceptance_complete(content: str) -> bool:
    match = re.search(r"^## Acceptance Criteria\s*$([\s\S]*?)(?=^## |\Z)", content, re.M)
    if match is None:
        return False
    criteria = match.group(1)
    unchecked = re.search(r"(?mi)^\s*-\s*\[\s*\]\s+", criteria)
    checked = re.search(r"(?mi)^\s*-\s*\[\s*x\s*\]\s+", criteria)
    return unchecked is None and checked is not None


def _replace_task_field(content: str, field: str, value: str) -> str:
    pattern = re.compile(rf"^\*\*{re.escape(field)}:\*\*.*$", re.M)
    replacement = f"**{field}:** {value}"
    if pattern.search(content):
        return pattern.sub(replacement, content, count=1)
    status = re.search(r"^\*\*Status:\*\*.*$", content, re.M)
    if status is None:
        raise ContextStateError("Task record has no Status field; repair it before completing work.")
    return content[: status.end()] + f"\n{replacement}" + content[status.end() :]


def _branch_points_to(main: Path, branch: str, sha: str) -> bool:
    try:
        actual = subprocess.run(
            ["git", "-C", str(main), "rev-parse", "--verify", f"{branch}^{{commit}}"],
            check=True,
            capture_output=True,
        ).stdout.decode().strip()
    except (OSError, subprocess.CalledProcessError):
        return False
    return actual == sha


def _validate_completion(
    main: Path,
    content: str,
    fields: dict[str, str],
    implementation_sha: str,
    verified_at: str,
    reviewed_at: str,
    review_required: bool,
    validation_passed: bool,
) -> None:
    if not _task_acceptance_complete(content):
        raise ContextStateError("Acceptance criteria are incomplete; keep the task in-progress and finish them.")
    branch = fields.get("Branch", "")
    if not branch or not _branch_points_to(main, branch, implementation_sha):
        raise ContextStateError(
            "The declared task branch does not point to the implementation SHA; re-read the task record "
            "and branch HEAD before completing."
        )
    if not validation_passed:
        raise ContextStateError("Validation was not confirmed; run it at the implementation SHA first.")
    if not _is_delivery_value(verified_at, main) or _evidence_sha(verified_at) != implementation_sha:
        raise ContextStateError("Verified at must name the validated implementation commit exactly.")
    if review_required and (
        not _is_delivery_value(reviewed_at, main) or _evidence_sha(reviewed_at) != implementation_sha
    ):
        raise ContextStateError("Required review must name the implementation commit exactly.")
    if not review_required and reviewed_at != "none":
        raise ContextStateError("Use Reviewed at: none when independent review is not required.")


def _complete_task(
    task_file: str,
    expected_sha: str,
    implementation_sha: str,
    verified_at: str,
    reviewed_at: str,
    review_required: bool,
    validation_passed: bool,
    lock_timeout: float,
) -> None:
    _validate_expected_sha(expected_sha)
    if GIT_SHA_PATTERN.fullmatch(implementation_sha) is None:
        raise ContextStateError("Implementation SHA must be 40 lowercase hex characters; re-read HEAD.")
    task_relative = _validate_relative_path(task_file)
    if task_relative.parent != Path(".claude/tasks") or task_relative.suffix != ".md":
        raise ContextStateError("Task file must be one direct .claude/tasks/*.md record.")
    target = _canonical_path(task_file)
    main, _ = _repository_paths()
    with _exclusive_lock(target, lock_timeout):
        _require_expected_sha(target, task_file, expected_sha)
        try:
            content = target.read_text(encoding="utf-8")
        except OSError as exc:
            raise ContextStateError(f"Could not read task record {task_file}; fix it and retry.") from exc
        fields = {name.strip(): value.strip() for name, value in TASK_FIELD.findall(content)}
        if fields.get("Status") != "in-progress":
            raise ContextStateError("Task status must be in-progress before completion; use /save otherwise.")
        _validate_completion(
            main,
            content,
            fields,
            implementation_sha,
            verified_at,
            reviewed_at,
            review_required,
            validation_passed,
        )
        completed = _replace_task_field(content, "Completed", time.strftime("%Y-%m-%d"))
        completed = _replace_task_field(completed, "Status", "done")
        completed = _replace_task_field(completed, "Verified at", verified_at)
        completed = _replace_task_field(completed, "Reviewed at", reviewed_at)
        completed = _replace_task_field(completed, "Integrated at", "none")
        _atomic_replace(
            target,
            completed.encode(),
            before_replace=lambda: _require_expected_sha(target, task_file, expected_sha),
        )


def _validate_session_name(session_file: str) -> None:
    candidate = Path(session_file)
    if (
        candidate.name != session_file
        or candidate.suffix != ".md"
        or session_file in {"", ".", "..", "README.md"}
    ):
        raise ContextStateError(
            "Session file must be a direct-child .md basename other than README.md; "
            "pass the live session filename only."
        )


def _stage_archive(main: Path, destination: Path) -> None:
    relative = destination.relative_to(main).as_posix()
    try:
        subprocess.run(
            ["git", "-C", str(main), "add", "--", relative],
            check=True,
            capture_output=True,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        raise ContextStateError(
            f"Could not stage archived session {relative}; fix Git/index permissions and retry."
        ) from exc


def _index_matches_file(main: Path, destination: Path) -> bool:
    relative = destination.relative_to(main).as_posix()
    try:
        indexed = subprocess.run(
            ["git", "-C", str(main), "show", f":{relative}"],
            check=True,
            capture_output=True,
        ).stdout
        return indexed == destination.read_bytes()
    except (OSError, subprocess.CalledProcessError):
        return False


def _move_without_overwrite(source: Path, destination: Path) -> None:
    created_destination = False
    try:
        os.link(source, destination, follow_symlinks=False)
        created_destination = True
        _fsync_directory(destination.parent)
        os.unlink(source)
        _fsync_directory(source.parent)
    except FileExistsError as exc:
        raise ContextStateError(
            f"Archive destination collision at {destination}; inspect both files and choose "
            "a unique session filename without overwriting."
        ) from exc
    except OSError as exc:
        owns_destination = False
        if created_destination and destination.exists() and source.exists():
            try:
                owns_destination = os.path.samestat(
                    source.stat(follow_symlinks=False),
                    destination.stat(follow_symlinks=False),
                )
            except OSError:
                owns_destination = False
        if owns_destination:
            try:
                destination.unlink()
                _fsync_directory(destination.parent)
            except OSError:
                raise ContextStateError(
                    f"Archive move failed and cleanup is ambiguous; inspect {source} and "
                    f"{destination} before retrying."
                ) from exc
        raise ContextStateError(
            f"Could not move {source.name} into the archive; check permissions and retry."
        ) from exc


def _rollback_archive(destination: Path, source: Path) -> None:
    try:
        os.link(destination, source, follow_symlinks=False)
        _fsync_directory(source.parent)
        os.unlink(destination)
        _fsync_directory(destination.parent)
    except OSError as exc:
        raise ContextStateError(
            f"Archive staging failed and rollback also failed; preserve {destination}, "
            "restore the live source manually, fix Git, and retry."
        ) from exc


def _reject_archive_symlinks(archive: Path, month_directory: Path, destination: Path) -> None:
    for label, path in (
        ("archive directory", archive),
        ("archive month directory", month_directory),
        ("archive destination", destination),
    ):
        if path.is_symlink():
            raise ContextStateError(
                f"The {label} {path} is a symlink; replace it with a real repository path "
                "and retry."
            )


def _archive_session(session_file: str, month: str, lock_timeout: float) -> None:
    _validate_session_name(session_file)
    if MONTH_PATTERN.fullmatch(month) is None:
        raise ContextStateError("Archive month must use a real YYYY-MM value; correct it and retry.")
    main, _ = _repository_paths()
    sessions = _path_below(main, Path(".claude/sessions"))
    source = sessions / session_file
    archive = sessions / "archive"
    month_directory = archive / month
    destination = month_directory / session_file

    with _exclusive_lock(archive, lock_timeout):
        if source.is_symlink():
            raise ContextStateError(
                f"Live session {session_file} is a symlink; replace it with a regular "
                "direct-child file or archive the real session explicitly."
            )
        _reject_archive_symlinks(archive, month_directory, destination)
        source_exists = source.is_file()
        destination_exists = destination.is_file()
        if source_exists and destination_exists:
            raise ContextStateError(
                f"Archive destination collision at {destination.relative_to(main)}; "
                "inspect both files and choose a unique session filename without overwriting."
            )
        if not source_exists and not destination_exists:
            raise ContextStateError(
                f"Neither live session nor archive destination exists for {session_file}; "
                "verify the filename and month, then retry."
            )
        if not source_exists:
            if not _index_matches_file(main, destination):
                raise ContextStateError(
                    f"Source is absent and cannot prove {destination.relative_to(main)} is the "
                    "byte-identical staged archive; inspect it, stage manually if correct, "
                    "then retry."
                )
            _stage_archive(main, destination)
            return

        _ensure_directory_durable(month_directory, sessions)
        _reject_archive_symlinks(archive, month_directory, destination)
        _move_without_overwrite(source, destination)
        try:
            _stage_archive(main, destination)
        except ContextStateError:
            _rollback_archive(destination, source)
            raise


def _read_live_sessions(limit: int, max_bytes: int) -> bytes:
    if limit < 0 or max_bytes < 0:
        raise ContextStateError(
            "Reader limits must be non-negative integers; pass --limit 10 --max-bytes 5120."
        )
    main, _ = _repository_paths()
    sessions = _path_below(main, Path(".claude/sessions"))
    if not sessions.is_dir():
        return b""
    candidates = []
    try:
        for path in sessions.glob("*.md"):
            if path.name == "README.md" or path.is_symlink() or not path.is_file():
                continue
            candidates.append(path)
        candidates.sort(key=lambda path: (-path.stat().st_mtime_ns, path.name))
        content = b"".join(path.read_bytes() for path in candidates[:limit])
    except OSError as exc:
        raise ContextStateError(
            "Could not read live session files; fix their permissions and retry."
        ) from exc
    return content[:max_bytes]


def _task_fields(path: Path) -> dict[str, str]:
    try:
        content = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ContextStateError(
            f"Could not read task record {path}; fix its permissions and retry."
        ) from exc
    return {name.strip(): value.strip() for name, value in TASK_FIELD.findall(content)}


def _task_identity(path: Path) -> str:
    # The record name, not Branch: distinct tasks share branches, and a shared Branch
    # read their differing statuses as conflicting evidence and held all dispatch
    # (tiktok-monitor 2026-09-25). Archiving keeps the name (tasks/X.md ->
    # tasks/archive/X.md), so a genuine live-vs-archive disagreement still conflicts.
    return f"record:{path.stem}"


def _activity_fields(path: Path) -> tuple[dict[str, str], str]:
    """Only the header is authoritative; worker logs may quote older fields."""
    header = re.split(r"^## ", path.read_text(encoding="utf-8"), maxsplit=1, flags=re.M)[0]
    pairs = ACTIVITY_FIELD.findall(header)
    fields = dict(pairs)
    if len(fields) != len(pairs):
        return fields, "duplicate header fields; reconcile the task header"
    if fields.get("Status") not in TASK_STATUSES:
        return fields, "missing or noncanonical Status; reconcile the task header"
    if fields["Status"] != "in-progress":
        return fields, ""
    if _PARTICIPANT.fullmatch(fields.get("Owner", "")) is None:
        return fields, "missing or invalid Owner; record the actual participant"
    if not fields.get("Branch") or not fields.get("Next"):
        return fields, "missing Branch or Next; record the actual branch and resume step"
    return fields, ""


def _live_task_paths() -> tuple[Path, list[Path]]:
    main, _ = _repository_paths()
    tasks = _path_below(main, Path(".claude/tasks"))
    paths = [path for path in sorted(tasks.glob("*.md"))
             if path.name != "README.md" and not path.is_symlink() and path.is_file()]
    return main, paths


def _read_stale_tasks(hours: float) -> dict[str, object]:
    main, paths = _live_task_paths()
    now = time.time()
    stale = []
    invalid = []
    for path in paths:
        fields, reason = _activity_fields(path)
        relative = path.relative_to(main).as_posix()
        if reason:
            invalid.append({"path": relative, "reason": reason})
            continue
        age = max(0.0, now - path.stat().st_mtime)
        if fields["Status"] == "in-progress" and age >= hours * SECONDS_PER_HOUR:
            stale.append({"path": relative, "owner": fields["Owner"],
                          "next": fields["Next"], "age_hours": age / SECONDS_PER_HOUR})
    return {"hours": hours, "stale": stale, "invalid": invalid}


SESSION_FIELD = re.compile(r"^\*\*Session:\*\*[ \t]*(.*?)[ \t]*$", re.M)


def _stamp_session(path: Path, session: str) -> bool:
    """Put `**Session:** <id>` in the task header (after Owner) so a router can map the
    task to one live pane. Returns True when the file changed."""
    text = path.read_text(encoding="utf-8")
    header, sep, rest = text.partition("\n## ")
    if SESSION_FIELD.search(header):
        new_header = SESSION_FIELD.sub(f"**Session:** {session}", header, count=1)
    else:
        new_header = re.sub(
            r"^(\*\*Owner:\*\*[^\n]*\n)", rf"\1**Session:** {session}\n", header, count=1, flags=re.M
        )
        if new_header == header:
            return False
    if new_header == header:
        return False
    _atomic_replace(path, (new_header + sep + rest).encode("utf-8"))
    return True


def _heartbeat_task(tool: str, session: str | None = None) -> dict[str, object]:
    top = Path(_run_git("rev-parse", "--show-toplevel").decode().strip())
    owner = _validate_participant(f"{tool}--{top.name}")
    branch = _run_git("branch", "--show-current").decode().strip()
    session_tag = _validate_header_token(session, "session")[:8] if session else None
    main, paths = _live_task_paths()
    touched = []
    for path in paths:
        fields, reason = _activity_fields(path)
        if reason or fields.get("Status") != "in-progress":
            continue
        if fields.get("Owner") != owner or fields.get("Branch") != branch:
            continue
        with _exclusive_lock(path, DEFAULT_LOCK_TIMEOUT_SECONDS):
            if not path.is_file() or path.is_symlink():
                continue
            fields, reason = _activity_fields(path)
            if reason or fields.get("Status") != "in-progress":
                continue
            if fields.get("Owner") == owner and fields.get("Branch") == branch:
                if session_tag:
                    _stamp_session(path, session_tag)
                os.utime(path, None)
                touched.append(path.relative_to(main).as_posix())
    return {"owner": owner, "touched": touched, "session": session_tag}


def _evidence_sha(value: str) -> str:
    return value.rsplit(" @ ", maxsplit=1)[-1]


def _is_delivery_value(value: str, main: Path) -> bool:
    if DELIVERY_EVIDENCE.fullmatch(value) is None:
        return False
    timestamp = value.split(" @ ", maxsplit=1)[0]
    try:
        datetime.datetime.strptime(timestamp, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        return False
    try:
        subprocess.run(
            ["git", "-C", str(main), "cat-file", "-e", f"{_evidence_sha(value)}^{{commit}}"],
            check=True,
            capture_output=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return False
    return True


def _task_entries(tasks: Path, main: Path) -> list[dict[str, object]]:
    if not tasks.is_dir():
        return []
    entries = []
    for path in sorted(tasks.rglob("*.md")):
        if path.is_symlink() or not path.is_file():
            continue
        fields = _task_fields(path)
        status = fields.get("Status", "")
        if not status:
            continue
        entries.append(
            {
                "identity": _task_identity(path),
                "path": path.relative_to(main).as_posix(),
                "status": status,
                "archived": "archive" in path.relative_to(tasks).parts,
                "fields": fields,
            }
        )
    return entries


def _delivery_signature(entry: dict[str, object]) -> tuple[str, ...]:
    fields = entry["fields"]
    assert isinstance(fields, dict)
    return (str(entry["status"]), *(str(fields.get(field, "")) for field in DELIVERY_FIELDS))


def _latest_task_entries(
    entries: list[dict[str, object]],
) -> tuple[list[dict[str, object]], list[dict[str, str]]]:
    chosen: dict[str, dict[str, object]] = {}
    conflicts: list[dict[str, str]] = []
    conflicted = set()
    for entry in entries:
        identity = str(entry["identity"])
        if identity in conflicted:
            continue
        prior = chosen.get(identity)
        if prior is None:
            chosen[identity] = entry
            continue
        if _delivery_signature(prior) != _delivery_signature(entry):
            conflicts.append(
                {
                    "identity": identity,
                    "path": f"{prior['path']}, {entry['path']}",
                    "reason": "conflicting live or archived delivery evidence",
                }
            )
            chosen.pop(identity, None)
            conflicted.add(identity)
            continue
        if not entry["archived"] and bool(prior["archived"]):
            chosen[identity] = entry
    return list(chosen.values()), conflicts


def _queue_item(entry: dict[str, object]) -> dict[str, str]:
    return {"identity": str(entry["identity"]), "path": str(entry["path"])}


def _classify_delivery_entry(
    entry: dict[str, object], main: Path
) -> list[tuple[str, dict[str, str]]]:
    status = str(entry["status"])
    item = _queue_item(entry)
    if status in TERMINAL_TASK_STATUSES:
        return []
    fields = entry["fields"]
    assert isinstance(fields, dict)
    present_delivery_fields = [field for field in DELIVERY_FIELDS if field in fields]
    if not present_delivery_fields:
        return [("legacy", item)]
    if len(present_delivery_fields) != len(DELIVERY_FIELDS):
        return [("invalid", {**item, "reason": "partial delivery evidence schema"})]
    classifications = []
    if status in ACTIVE_TASK_STATUSES and not bool(entry["archived"]):
        classifications.append(("active", item))
    verified = str(fields.get("Verified at", ""))
    integrated = str(fields.get("Integrated at", ""))
    if verified == "none" and integrated == "none":
        return classifications
    if not _is_delivery_value(verified, main):
        return classifications + [
            ("invalid", {**item, "reason": "Verified at is not a reachable commit evidence"})
        ]
    if integrated in {"", "none"}:
        return classifications + [
            ("pending", {**item, "verified_at": verified.split(" @ ", maxsplit=1)[0]})
        ]
    if not _is_delivery_value(integrated, main):
        return classifications + [
            ("invalid", {**item, "reason": "Integrated at is not a reachable commit evidence"})
        ]
    if _integration_contains(main, verified, integrated):
        return classifications
    return classifications + [
        ("invalid", {**item, "reason": "Integrated at does not contain the verified commit"})
    ]


def _integration_contains(main: Path, verified: str, integrated: str) -> bool:
    verified_sha = _evidence_sha(verified)
    integrated_sha = _evidence_sha(integrated)
    try:
        result = subprocess.run(
            ["git", "-C", str(main), "merge-base", "--is-ancestor", verified_sha, integrated_sha],
            capture_output=True,
        )
    except OSError:
        result = None
    return result is not None and result.returncode == 0


def _sort_queue_items(items: list[dict[str, str]]) -> None:
    items.sort(key=lambda value: (value["identity"], value["path"]))


def _task_queue() -> dict[str, object]:
    """Return deterministic delivery admission facts from live and archived task records.

    New records use timestamps paired with the exact verified or integrated code SHA:
    ``2026-09-25T14:30:00Z @ <40-lowercase-hex>``.  A nonempty string is never evidence
    by itself.  This makes old task packets visible for human reconciliation without
    manufacturing a delivery SHA for them.
    """
    main, _ = _repository_paths()
    tasks = _path_below(main, Path(".claude/tasks"))
    entries, conflicts = _latest_task_entries(_task_entries(tasks, main))
    active: list[dict[str, str]] = []
    pending: list[dict[str, str]] = []
    legacy: list[dict[str, str]] = []
    invalid: list[dict[str, str]] = []
    buckets = {"active": active, "pending": pending, "legacy": legacy, "invalid": invalid}
    for entry in entries:
        for kind, item in _classify_delivery_entry(entry, main):
            buckets[kind].append(item)
    invalid.extend(conflicts)
    for items in buckets.values():
        _sort_queue_items(items)
    reasons = []
    if len(pending) >= 3:
        reasons.append("delivery queue has three or more pending integrations")
    if len(active) >= 3:
        reasons.append("three implementation streams are already active")
    if invalid:
        reasons.append("delivery evidence needs reconciliation")
    return {
        "admission": "hold" if reasons else "allow",
        "reasons": reasons,
        "pending": pending,
        "active": active,
        "legacy": legacy,
        "invalid": invalid,
    }


_PARTICIPANT = re.compile(r"^(claude|codex|opencode|pi|cline|agent)--[A-Za-z0-9._-]+$")
_SESSION_NAME = re.compile(r"^(claude|codex|opencode|pi|cline)--[A-Za-z0-9._-]+--[a-z0-9]{8}$")
_UUID7 = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
_MSG_HEADER = re.compile(rb"(?m)^## \[")
_HEADER_TOKEN = re.compile(r"^[A-Za-z0-9._-]{1,40}$")
MAX_MESSAGE_BYTES = 2048
MESSAGES_SUBDIR = ".claude/messages"
COMMS_GROUPS_FILE = Path.home() / ".claude" / "comms-groups.json"
MESSAGE_KINDS = ("blocker", "question", "answer", "fyi")
WAKE_KINDS = frozenset({"blocker", "question", "answer"})  # fyi waits for the next prompt
STALE_MESSAGE_HOURS = 12.0
RECIPIENT_HOURS = 12.0  # a session that has not prompted for longer is not offered as a peer
RECEIPT_STATUSES = ("handled", "not-mine", "blocked")
MAX_LOG_NOTE_CHARS = 300
_ENTRY_HEADER = re.compile(rb"^## \[(\d{4}-\d\d-\d\d \d\d:\d\d)\]([^\n]*)")


class _Board(NamedTuple):
    """Where a session's messages live.

    A group board (comms-groups.json) is shared by several repos and folders. It keeps
    its locks beside the messages, so a sandboxed session in a member repo can write it
    without touching another repository's .git. A repo's own board keeps the lock in
    .git, where older repo-local copies of this helper also take it.
    """

    root: Path
    directory: Path
    shared: bool


def _comms_group_members() -> list[tuple[Path, Path]]:
    """(member folder, group home) pairs from the comms groups file; [] when absent."""
    path = Path(os.environ.get("COMMS_GROUPS_FILE") or COMMS_GROUPS_FILE)
    if not path.exists():
        return []
    try:
        pairs = []
        for group in json.loads(path.read_text(encoding="utf-8"))["groups"].values():
            home = Path(group["home"]).expanduser().resolve()
            pairs.extend((Path(m).expanduser().resolve(), home) for m in group["members"])
        return pairs
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
        raise ContextStateError(
            f"Could not read comms groups from {path}; it must be "
            '{"groups": {"<name>": {"home": "<dir>", "members": ["<dir>", ...]}}}.'
        ) from exc


def _board() -> _Board:
    """The board for the current folder: the most specific group member wins, else the
    repo's own board. Worktrees resolve through their main checkout."""
    in_git = subprocess.run(
        ["git", "rev-parse", "--git-common-dir"], capture_output=True
    ).returncode == 0
    here = _repository_paths()[0] if in_git else Path.cwd().resolve()
    matches = [
        (member, home)
        for member, home in _comms_group_members()
        if member == here or member in here.parents
    ]
    if matches:
        home = max(matches, key=lambda pair: len(pair[0].parts))[1]
        return _Board(home, home / MESSAGES_SUBDIR, True)
    if not in_git:
        raise ContextStateError(
            f"{here} is in neither a Git repository nor a comms group; start the session "
            f"inside one, or add this folder to {COMMS_GROUPS_FILE}."
        )
    main, _ = _repository_paths()
    return _Board(main, main / MESSAGES_SUBDIR, False)


def _board_lock(board: _Board, target: Path, timeout: float) -> contextlib.AbstractContextManager[None]:
    if not board.shared:
        return _exclusive_lock(target, timeout)
    lock_directory = board.directory / ".locks"
    _ensure_directory_durable(lock_directory, board.root)
    relative = target.relative_to(board.root).as_posix()
    digest = hashlib.sha256(relative.encode("utf-8")).hexdigest()
    return _exclusive_lock(target, timeout, lock_directory / f"{digest}.lock")


def entry_header(entry: bytes) -> tuple[float, dict[str, str]] | None:
    """(posted epoch, header fields) for one message entry, or None if unparseable.
    Public: the comms monitor reads boards through this same parser."""
    match = _ENTRY_HEADER.match(entry)
    if match is None:
        return None
    posted = time.mktime(time.strptime(match.group(1).decode(), "%Y-%m-%d %H:%M"))
    fields = dict(
        token.split(":", 1)
        for token in match.group(2).decode("utf-8", errors="replace").split()
        if ":" in token
    )
    return posted, fields


def is_wakeable(entry: bytes, now: float) -> bool:
    """True when a message may start a turn: a waking kind, and fresh."""
    header = entry_header(entry)
    if header is None:
        return False
    posted, fields = header
    return fields.get("kind") in WAKE_KINDS and now - posted <= STALE_MESSAGE_HOURS * 3600


def _validate_participant(name: str) -> str:
    if _PARTICIPANT.fullmatch(name) is None:
        raise ContextStateError(
            "Participant must be <tool>--<folder>--<session id> with tool one of "
            "claude|codex|opencode|pi|cline, or agent--<name>, e.g. claude--myrepo--fa87c106."
        )
    return name


def _validate_session_name(name: str, field: str) -> str:
    """The form mail is addressed with: a session is <tool>--<folder>--<8 chars of its session
    id>; service names (agent--*) carry no session. A bare <tool>--<folder> names nobody."""
    _validate_participant(name)
    if name.startswith("agent--") or _SESSION_NAME.fullmatch(name):
        return name
    raise ContextStateError(
        f"--{field} {name!r} names no session. A session is <tool>--<folder>--<8 chars of its "
        "session id>, e.g. claude--tiktok-monitor--fa87c106; your own name is in the "
        "session-comms primer, peers' names come from `context_state.py recipients`."
    )


def session_name(tool: str, folder: str, session_id: str) -> str:
    """A session's inbox name: <tool>--<folder it started in>--<8 chars of its session id>.
    The 8 chars are the id's first 8, except for a time-ordered UUIDv7 (Codex): its first 8
    are a ~65 s timestamp that sessions started together share (7 repeats in 45 Codex
    sessions, 2026-10-18/19), so its last 8, which are random, are used.
    Public: the drain hook builds it from the hook event; the OpenCode plugin copies the rule."""
    lowered = session_id.lower()
    source = lowered[-8:] if _UUID7.fullmatch(lowered) else lowered.removeprefix("ses_")
    sid = re.sub(r"[^a-z0-9]", "", source)[:8]
    if len(sid) < 8:
        raise ContextStateError(f"Session id {session_id!r} is too short to name a session.")
    return _validate_session_name(f"{tool}--{folder}--{sid}", "name")


def session_record(board_directory: Path, name: str) -> dict:
    """What a session's prompt hook last recorded on its board (comms-turn): auto_turns,
    updated, cwd, pane. {} when absent or unreadable. Public: the monitor and router read it."""
    try:
        record = json.loads((board_directory / ".state" / f"{name}.json").read_bytes())
    except (OSError, ValueError):
        return {}
    return record if isinstance(record, dict) else {}


def _validate_header_token(value: str, field: str) -> str:
    # model/sess ride in the single-line header; reject anything that could break it
    # (newlines, spaces, ':') rather than silently mangling the header format.
    if _HEADER_TOKEN.fullmatch(value) is None:
        raise ContextStateError(
            f"--{field} must be 1-40 chars of [A-Za-z0-9._-]; "
            f"got {value!r}. Pass a short tag or omit it."
        )
    return value


def superseded_by(board_directory: Path, name: str) -> str:
    """The session of the same tool that has prompted in `name`'s herdr pane since `name`
    last did, or ''. Herdr never reuses a pane id, so that means `name` ended (/clear, /new,
    exit) and its pane now runs another session. Same tool only: a `codex exec` started from
    a Claude session's shell inherits that pane id and must not end it.
    Claude only: Codex and OpenCode run every session's hooks in one shared background
    service, so the pane they record is wherever that service started (2026-10-19: every
    Codex record said w1:p179, a pane no Codex was running in).
    Public: the monitor bounces mail for an ended session; `recipients` hides it."""
    if not name.startswith("claude--"):
        return ""
    record = session_record(board_directory, name)
    pane, updated = record.get("pane"), record.get("updated")
    if not pane or not isinstance(updated, int):
        return ""
    tool = name.split("--", 1)[0]
    newest, newest_at = "", updated
    for path in (board_directory / ".state").glob(f"{tool}--*--*.json"):
        other = session_record(board_directory, path.stem)
        at = other.get("updated")
        if path.stem != name and other.get("pane") == pane and isinstance(at, int) and at > newest_at:
            newest, newest_at = path.stem, at
    return newest


def _whoami(tool: str, session_id: str) -> str:
    """This session's own inbox name, read from the record its prompt hook writes on every
    prompt. A shell's current folder is not the folder the session started in (worktrees),
    so a name rebuilt from $PWD can name an inbox nobody drains."""
    board = _board()
    sid = session_name(tool, "x", session_id).rsplit("--", 1)[1]
    names = [path.stem for path in (board.directory / ".state").glob(f"{tool}--*--{sid}.json")]
    if not names:
        raise ContextStateError(
            f"No record for this {tool} session on {board.directory}: it has not prompted on this "
            "board yet. Your name is also in the session-comms primer."
        )
    return max(names, key=lambda name: session_record(board.directory, name).get("updated", 0))


def _recipients(board: _Board, hours: float) -> list[dict]:
    """Sessions that prompted on this board within `hours` and have not ended, newest first."""
    now = time.time()
    rows = []
    for path in (board.directory / ".state").glob("*--*--*.json"):
        if _SESSION_NAME.fullmatch(path.stem) is None:
            continue
        record = session_record(board.directory, path.stem)
        try:
            seen = int(record["updated"])
        except (KeyError, ValueError, TypeError):
            continue
        if now - seen <= hours * 3600 and not superseded_by(board.directory, path.stem):
            rows.append({"name": path.stem, "seen": seen, "cwd": str(record.get("cwd", ""))})
    rows.sort(key=lambda row: -row["seen"])
    return rows


def _format_recipients(rows: list[dict]) -> str:
    now = time.time()
    lines = []
    for row in rows:
        age = now - row["seen"]
        ago = f"{age / 60:.0f} min" if age < 3600 else f"{age / 3600:.1f} h"
        lines.append(f"{row['name']}  seen {ago} ago  {row['cwd']}")
    return "\n".join(lines)


def _message_target(board: _Board, name: str) -> Path:
    return board.directory / f"{_validate_participant(name)}.md"


def _post_message(
    to: str,
    sender: str,
    content_file: str,
    lock_timeout: float,
    model: str | None = None,
    sess: str | None = None,
    kind: str | None = None,
    task: str | None = None,
) -> str:
    """Returns the message id. Every session has its own inbox, so a bare <tool>--<folder>
    is refused with the sessions seen lately listed; nothing is parked or routed."""
    _validate_session_name(sender, "from")
    try:
        _validate_session_name(to, "to")
    except ContextStateError as exc:
        peers = _format_recipients(_recipients(_board(), RECIPIENT_HOURS))
        raise ContextStateError(
            f"{exc}" + (f"\nSeen in the last {RECIPIENT_HOURS:g} h:\n{peers}" if peers else "")
        ) from None
    content = _read_input(content_file, "message")
    if len(content) > MAX_MESSAGE_BYTES:
        raise ContextStateError(
            f"Message is {len(content)} bytes; the cap is {MAX_MESSAGE_BYTES}. "
            "Shorten it or write a file and send its path instead."
        )
    board = _board()
    target = _message_target(board, to)
    _ensure_directory_durable(target.parent, board.root)
    message_id = os.urandom(16).hex()
    stamp = time.strftime("%Y-%m-%d %H:%M")
    extra = ""
    # Optional provenance fields, omitted from the header when the sender doesn't know
    # them — never faked. They ride in the single-line header, so validate as tokens.
    # A message without kind: is treated as fyi and never wakes anyone.
    if model:
        extra += f" model:{_validate_header_token(model, 'model')}"
    if sess:
        extra += f" sess:{_validate_header_token(sess, 'sess')}"
    if kind:
        extra += f" kind:{kind}"
    if task:
        extra += f" task:{_validate_header_token(task, 'task')}"
    entry = f"## [{stamp}] from:{sender}{extra} id:{message_id}\n".encode() + content
    if not entry.endswith(b"\n"):
        entry += b"\n"
    with _board_lock(board, target, lock_timeout):
        existing = target.read_bytes() if target.exists() else b""
        _atomic_replace(target, entry + existing, root=board.root)  # newest first
    return message_id


def _consume_message(name: str, message_id: str, lock_timeout: float) -> bytes:
    """Move one entry (by id) from an inbox to the archive; returns it, or b'' if absent."""
    board = _board()
    target = _message_target(board, name)
    wanted = _validate_header_token(message_id, "id")
    with _board_lock(board, target, lock_timeout):
        entries = _split_messages(target.read_bytes() if target.exists() else b"")
        keep, found = [], b""
        for entry in entries:
            header = entry_header(entry)
            if not found and header and header[1].get("id") == wanted:
                found = entry
            else:
                keep.append(entry)
        if not found:
            return b""
        archive = target.parent / "archive.md"
        with _board_lock(board, archive, lock_timeout):
            prior = archive.read_bytes() if archive.exists() else b""
            _atomic_replace(archive, prior + found, root=board.root)  # archive BEFORE rewrite
        _atomic_replace(target, b"".join(keep), root=board.root)
    return found


def _split_messages(data: bytes) -> list[bytes]:
    """Complete entries in file order (newest first). Pre-header junk rides with
    the first entry so consumption can never strand unparseable bytes."""
    if not data:
        return []
    starts = [m.start() for m in _MSG_HEADER.finditer(data)]
    if not starts:
        return [data]
    if starts[0] != 0:
        starts[0] = 0
    bounds = starts + [len(data)]
    return [data[bounds[i]:bounds[i + 1]] for i in range(len(starts))]


def _read_inbox(
    name: str, consume: bool, max_bytes: int, lock_timeout: float, if_wakeable: bool = False
) -> bytes:
    board = _board()
    target = _message_target(board, name)
    with _board_lock(board, target, lock_timeout):
        data = target.read_bytes() if target.exists() else b""
        entries = _split_messages(data)
        if if_wakeable and not any(is_wakeable(entry, time.time()) for entry in entries):
            return b""  # only fyi or stale mail: leave it for the next operator prompt
        selected: list[bytes] = []
        selected_indexes: set[int] = set()
        total = 0
        now = time.time()
        for index in range(len(entries) - 1, -1, -1):
            entry = entries[index]
            if if_wakeable and not is_wakeable(entry, now):
                continue
            if selected and total + len(entry) > max_bytes:
                break
            selected.append(entry)
            selected_indexes.add(index)
            total += len(entry)
            if total > max_bytes:                # single oversized entry: deliver alone
                break
        if not selected:
            return b""
        payload = b"".join(selected)
        if consume:
            archive = target.parent / "archive.md"
            with _board_lock(board, archive, lock_timeout):   # order: inbox, then archive
                prior = archive.read_bytes() if archive.exists() else b""
                # archive BEFORE inbox rewrite
                _atomic_replace(archive, prior + payload, root=board.root)
            remaining = [entry for index, entry in enumerate(entries) if index not in selected_indexes]
            _atomic_replace(target, b"".join(remaining), root=board.root)
        return payload


def _comms_rollover(old: str, new: str, lock_timeout: float) -> int:
    """Move every message in `old`'s inbox to the front of `new`'s and drop `old`'s turn record.
    For a handoff where the new session continues the old one's work (the foreman's /clear +
    /catchup); any other ended session's mail is bounced to its sender by the monitor."""
    _validate_session_name(old, "from")
    _validate_session_name(new, "to")
    board = _board()
    source, target = _message_target(board, old), _message_target(board, new)
    with _board_lock(board, source, lock_timeout):                      # order: old, then new
        entries = _split_messages(source.read_bytes() if source.exists() else b"")
        if entries:
            with _board_lock(board, target, lock_timeout):
                existing = target.read_bytes() if target.exists() else b""
                _atomic_replace(target, b"".join(entries) + existing, root=board.root)
            _atomic_replace(source, b"", root=board.root)               # new BEFORE old is emptied
        (board.directory / ".state" / f"{old}.json").unlink(missing_ok=True)
    _append_board_log(board, {"at": time.strftime("%Y-%m-%d %H:%M:%S"), "name": new, "event": "rollover",
                              "note": f"from {old}, {len(entries)} messages"}, lock_timeout)
    return len(entries)


def _comms_turn(name: str, event: str, lock_timeout: float) -> int:
    """Count turns started by peer messages since the operator last prompted: operator
    resets to 0, auto adds 1, peek only reads. Each write also records where the session
    is (cwd, herdr pane); `recipients` and the comms monitor find it by that record."""
    board = _board()
    target = board.directory / ".state" / f"{_validate_participant(name)}.json"
    _ensure_directory_durable(target.parent, board.root)
    with _board_lock(board, target, lock_timeout):
        try:
            count = int(json.loads(target.read_bytes())["auto_turns"]) if target.exists() else 0
        except (OSError, ValueError, KeyError, TypeError) as exc:
            raise ContextStateError(
                f"{target} is unreadable; delete it to reset the auto-turn count."
            ) from exc
        if event == "peek":
            return count
        count = count + 1 if event == "auto" else 0
        record = {"auto_turns": count, "updated": int(time.time()),
                  "cwd": str(Path.cwd()), "pane": os.environ.get("HERDR_PANE_ID", "")}
        _atomic_replace(target, json.dumps(record).encode(), root=board.root)
    return count


def _comms_sweep(days: float, lock_timeout: float) -> dict[str, int]:
    """Move messages older than `days` from every inbox on this board to archive.md, delete
    inboxes left empty, and drop session records not updated in that time."""
    board = _board()
    cutoff = time.time() - days * 86400
    counts = {"messages": 0, "inboxes": 0, "removed": 0, "records": 0}
    archive = board.directory / "archive.md"
    for target in sorted(board.directory.glob("*--*.md")):
        with _board_lock(board, target, lock_timeout):
            keep: list[bytes] = []
            old: list[bytes] = []
            for entry in _split_messages(target.read_bytes()):
                header = entry_header(entry)
                (old if header is None or header[0] < cutoff else keep).append(entry)
            if old:
                with _board_lock(board, archive, lock_timeout):   # archive BEFORE inbox rewrite
                    prior = archive.read_bytes() if archive.exists() else b""
                    _atomic_replace(archive, prior + b"".join(old), root=board.root)
                counts["messages"] += len(old)
                counts["inboxes"] += 1
                if keep:
                    _atomic_replace(target, b"".join(keep), root=board.root)
            if not keep:
                target.unlink(missing_ok=True)
                counts["removed"] += 1
    for path in (board.directory / ".state").glob("*--*--*.json"):
        if _SESSION_NAME.fullmatch(path.stem) is None:
            continue
        try:
            updated = int(session_record(board.directory, path.stem).get("updated", 0))
        except (ValueError, TypeError):
            updated = 0
        if updated < cutoff:
            path.unlink(missing_ok=True)
            counts["records"] += 1
    return counts


def _comms_log(
    name: str,
    event: str,
    message_id: str | None,
    status: str | None,
    note: str,
    lock_timeout: float,
) -> None:
    """Append one line to the board's activity log: receipts from sessions, wakes and
    escalations from the comms monitor."""
    _validate_participant(name)
    if event == "receipt" and status is None:
        raise ContextStateError("A receipt needs --status handled|not-mine|blocked.")
    if len(note) > MAX_LOG_NOTE_CHARS:
        raise ContextStateError(
            f"Note is {len(note)} chars; the cap is {MAX_LOG_NOTE_CHARS}. Shorten it."
        )
    record = {"at": time.strftime("%Y-%m-%d %H:%M:%S"), "name": name, "event": event}
    if message_id:
        record["id"] = _validate_header_token(message_id, "id")
    if status:
        record["status"] = status
    if note:
        record["note"] = " ".join(note.split())
    _append_board_log(_board(), record, lock_timeout)


def _append_board_log(board: _Board, record: dict, lock_timeout: float) -> None:
    """One JSON line on the board's activity log; comms-stats.py reads it back."""
    target = board.directory / ".log.jsonl"
    _ensure_directory_durable(target.parent, board.root)
    with _board_lock(board, target, lock_timeout):
        try:
            with target.open("ab") as handle:
                handle.write((json.dumps(record) + "\n").encode())
                handle.flush()
                os.fsync(handle.fileno())
        except OSError as exc:
            raise ContextStateError(
                f"Could not append to {target}; check disk space and permissions."
            ) from exc


def _log_finding(board: _Board, action: str, finding: _Finding, by: str, lock_timeout: float) -> None:
    note = {"claim": finding.claimed, "close": finding.ref, "add": finding.text}.get(action, "")
    _append_board_log(board, {
        "at": time.strftime("%Y-%m-%d %H:%M:%S"), "name": by, "event": "finding",
        "action": action, "id": finding.id, "scope": finding.scope, "note": note[:MAX_LOG_NOTE_CHARS],
    }, lock_timeout)


FINDINGS_FILE = "findings.md"
FINDINGS_ARCHIVE_FILE = "findings-archive.md"
FINDING_MARKS = {" ": "open", "~": "claimed", "x": "closed"}
FINDING_STATUSES = tuple(FINDING_MARKS.values())
MAX_FINDING_TEXT_CHARS = 240
MAX_FINDING_WHERE_CHARS = 200
MAX_FINDING_REF_CHARS = 120
FINDINGS_ARCHIVE_AFTER_DAYS = 30
SOUL_MAPS_SUBDIR = "docs/soul-maps"
# scope = <repo>[+<repo>...]/<area>[/<module>][#<task>]
#   repo   = basename of the git checkout the finding is about; '+' joins adjacent repos
#   area   = a soul-map section of the board's home repo (docs/soul-maps/<area>.md) or 'other'
#   module = a module-map name (docs/module-maps/<module>.md) or a path inside the repo
#   task   = a .claude/tasks/<task>.md name, when one already owns the area
_FINDING_SCOPE = re.compile(
    r"^(?P<repos>[A-Za-z0-9._-]+(?:\+[A-Za-z0-9._-]+)*)/(?P<area>[a-z0-9-]+)"
    r"(?:/(?P<module>[A-Za-z0-9._/-]+?))?(?:#(?P<task>[A-Za-z0-9._-]+))?$"
)
_FINDING_ID = re.compile(r"^f-[0-9a-f]{4}$")
_FINDING_LINE = re.compile(
    r"^- \[(?P<mark>[ ~x])\] (?P<id>f-[0-9a-f]{4}) (?P<date>\d{4}-\d\d-\d\d) (?P<scope>\S+)"
    r" \| (?P<text>.*?) \| where: (?P<where>.*?) \| from: (?P<from>\S+)"
    r" \| claimed: (?P<claimed>\S+) \| ref: (?P<ref>.*)$"
)


class _Finding(NamedTuple):
    mark: str
    id: str
    date: str
    scope: str
    text: str
    where: str
    sender: str
    claimed: str
    ref: str

    def render(self) -> str:
        return (
            f"- [{self.mark}] {self.id} {self.date} {self.scope} | {self.text}"
            f" | where: {self.where} | from: {self.sender} | claimed: {self.claimed}"
            f" | ref: {self.ref}"
        )

    def as_dict(self) -> dict[str, str]:
        parts = _FINDING_SCOPE.match(self.scope)
        record = {
            "id": self.id, "status": FINDING_MARKS[self.mark], "date": self.date,
            "scope": self.scope, "text": self.text, "where": self.where,
            "from": self.sender, "claimed": self.claimed, "ref": self.ref,
        }
        if parts:
            record.update(
                repos=parts.group("repos").split("+"), area=parts.group("area"),
                module=parts.group("module") or "", task=parts.group("task") or "",
            )
        return record


def _parse_finding(line: str) -> _Finding | None:
    match = _FINDING_LINE.match(line)
    if match is None:
        return None
    g = match.groupdict()
    return _Finding(
        g["mark"], g["id"], g["date"], g["scope"], g["text"], g["where"], g["from"],
        g["claimed"], g["ref"],
    )


def _findings_path(board: _Board, archive: bool = False) -> Path:
    return board.directory / (FINDINGS_ARCHIVE_FILE if archive else FINDINGS_FILE)


def _read_findings(path: Path) -> tuple[list[str], dict[str, int]]:
    """All lines of the file plus id -> line index for the lines that parse. Lines that
    do not parse are kept untouched so a hand edit never loses data."""
    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    index: dict[str, int] = {}
    for number, line in enumerate(lines):
        finding = _parse_finding(line)
        if finding is not None:
            index[finding.id] = number
    return lines, index


def _write_findings(board: _Board, path: Path, lines: list[str]) -> None:
    content = ("\n".join(lines) + "\n").encode("utf-8") if lines else b""
    _atomic_replace(path, content, root=board.root)


def _finding_field(value: str, field: str, cap: int) -> str:
    cleaned = " ".join(value.split())
    if not cleaned:
        raise ContextStateError(f"--{field} must not be empty.")
    if "|" in cleaned:
        raise ContextStateError(f"--{field} must not contain '|'; use ';' to separate parts.")
    if len(cleaned) > cap:
        raise ContextStateError(
            f"--{field} is {len(cleaned)} chars; the cap is {cap}. Point to a file for the rest."
        )
    return cleaned


def _allowed_areas(board: _Board) -> set[str] | None:
    """Soul-map section names of the board's home repo, or None when it keeps none
    (then any lowercase token is accepted)."""
    soul_maps = board.root / SOUL_MAPS_SUBDIR
    if not soul_maps.is_dir():
        return None
    names = {p.stem for p in soul_maps.glob("*.md") if p.stem.lower() != "readme"}
    return names | {"other"} if names else None


def _validate_scope(board: _Board, scope: str) -> str:
    match = _FINDING_SCOPE.match(scope)
    if match is None:
        raise ContextStateError(
            "Scope must be <repo>[+<repo>]/<area>[/<module>][#<task>], e.g. "
            "tiktok-monitor/accounts-and-acquisition/proxy-handling#proxy-data-plan. "
            "repo is the checkout's folder name; '+' joins adjacent repos."
        )
    allowed = _allowed_areas(board)
    area = match.group("area")
    if allowed is not None and area not in allowed:
        raise ContextStateError(
            f"Area {area!r} is not a soul-map section of {board.root.name}. "
            f"Use one of: {', '.join(sorted(allowed))}."
        )
    return scope


def _finding_matches(
    finding: _Finding, statuses: set[str], repo: str | None, area: str | None,
    module: str | None, task: str | None, mine: str | None,
) -> bool:
    if FINDING_MARKS[finding.mark] not in statuses:
        return False
    parts = _FINDING_SCOPE.match(finding.scope)
    repos = parts.group("repos").split("+") if parts else []
    if repo and repo not in repos:
        return False
    if area and (not parts or parts.group("area") != area):
        return False
    if module and (not parts or not (parts.group("module") or "").startswith(module)):
        return False
    if task and (not parts or parts.group("task") != task):
        return False
    if mine and not finding.claimed.startswith(f"{mine}#"):
        return False
    return True


def _current_repo_name() -> str:
    """Folder name of the main checkout around the cwd; a worktree reports its repo, not
    its own folder. Outside git: the cwd's folder name."""
    try:
        return _repository_paths()[0].name
    except ContextStateError:
        return Path.cwd().resolve().name


def _findings_add(
    scope: str, text: str, where: str, sender: str, sess: str | None, lock_timeout: float
) -> str:
    _validate_participant(sender)
    board = _board()
    scope = _validate_scope(board, scope)
    text = _finding_field(text, "text", MAX_FINDING_TEXT_CHARS)
    where = _finding_field(where, "where", MAX_FINDING_WHERE_CHARS)
    origin = sender + (f"/{_validate_header_token(sess, 'sess')}" if sess else "")
    path = _findings_path(board)
    _ensure_directory_durable(path.parent, board.root)
    with _board_lock(board, path, lock_timeout):
        lines, index = _read_findings(path)
        while True:
            finding_id = "f-" + hashlib.sha256(os.urandom(8)).hexdigest()[:4]
            if finding_id not in index:
                break
        finding = _Finding(
            " ", finding_id, time.strftime("%Y-%m-%d"), scope, text, where, origin, "-", "-"
        )
        lines.append(finding.render())
        _write_findings(board, path, lines)
    _log_finding(board, "add", finding, sender, lock_timeout)
    return finding_id


def _promote_loops(session_file: str, scope: str, by: str, lock_timeout: float) -> list[str]:
    """Record unfinished loops before atomically replacing their checkboxes."""
    root, _ = _repository_paths()
    path = Path(session_file)
    if path.is_absolute():
        try:
            path = path.relative_to(root)
        except ValueError as exc:
            raise ContextStateError("Session file must be below this repo's main checkout.") from exc
    target = _canonical_path(str(path))
    where = target.relative_to(root).as_posix()
    _validate_participant(by)
    _validate_scope(_board(), scope)
    _finding_field(where, "where", MAX_FINDING_WHERE_CHARS)
    with _exclusive_lock(target, lock_timeout):
        try:
            source = target.read_text(encoding="utf-8")
        except OSError as exc:
            raise ContextStateError(f"Cannot read {target}; check the session path and permissions.") from exc
        section = re.search(r"(?ms)^## Open Loops[ \t]*(?:\n|\Z)(.*?)(?=^#{1,2} |\Z)", source)
        if section is None:
            raise ContextStateError(f"{target} has no ## Open Loops section; add it before promoting.")
        body = section.group(1)
        loops = list(re.finditer(r"(?m)^- \[ \] ([^\n]*)", body))
        # Reject an invalid batch before recording any finding.
        for loop in loops:
            _finding_field(loop.group(1), "text", MAX_FINDING_TEXT_CHARS)
        # Plain saves used a trailing ID before wrap adopted arrow checkboxes.
        ids = [
            saved.group(1) if (saved := re.search(r"\((f-[0-9a-f]{4})\)[ \t]*$", loop.group(1)))
            else _findings_add(scope, loop.group(1), where, by, None, lock_timeout)
            for loop in loops
        ]
        replacements = iter(ids)
        updated = re.sub(r"(?m)^- \[ \] ", lambda _: f"- [→ {next(replacements)}] ", body)
        if ids:
            _atomic_replace(target, (source[:section.start(1)] + updated + source[section.end(1):]).encode())
        return ids


def _findings_update(
    finding_id: str, by: str, lock_timeout: float, action: str,
    task: str | None = None, ref: str | None = None,
) -> _Finding:
    _validate_participant(by)
    if _FINDING_ID.match(finding_id) is None:
        raise ContextStateError("Finding id looks like f-1a2b; copy it from `findings list`.")
    board = _board()
    path = _findings_path(board)
    with _board_lock(board, path, lock_timeout):
        lines, index = _read_findings(path)
        if finding_id not in index:
            raise ContextStateError(f"No finding {finding_id} in {path}.")
        current = _parse_finding(lines[index[finding_id]])
        assert current is not None
        status = FINDING_MARKS[current.mark]
        if action == "claim":
            if status != "open":
                raise ContextStateError(
                    f"{finding_id} is {status}"
                    + (f" by {current.claimed}" if status == "claimed" else "")
                    + "; only an open finding can be claimed."
                )
            task_name = _validate_header_token(task or "", "task")
            updated = current._replace(mark="~", claimed=f"{by}#{task_name}")
        elif action == "release":
            if status != "claimed":
                raise ContextStateError(f"{finding_id} is {status}; only a claimed finding can be released.")
            updated = current._replace(mark=" ", claimed="-")
        elif action == "close":
            if status == "closed":
                raise ContextStateError(f"{finding_id} is already closed: {current.ref}")
            reference = _finding_field(ref or "", "ref", MAX_FINDING_REF_CHARS)
            updated = current._replace(
                mark="x", ref=f"{reference} by:{by} on:{time.strftime('%Y-%m-%d')}"
            )
        else:  # pragma: no cover - callers pass a known action
            raise ContextStateError("Unknown findings action.")
        lines[index[finding_id]] = updated.render()
        _write_findings(board, path, lines)
    _log_finding(board, action, updated, by, lock_timeout)
    return updated


def _findings_list(
    statuses: set[str], repo: str | None, area: str | None, module: str | None,
    task: str | None, mine: str | None, limit: int, as_json: bool,
) -> str:
    board = _board()
    lines, _ = _read_findings(_findings_path(board))
    selected = []
    for line in reversed(lines):  # newest first
        finding = _parse_finding(line)
        if finding and _finding_matches(finding, statuses, repo, area, module, task, mine):
            selected.append(finding)
        if limit and len(selected) >= limit:
            break
    if as_json:
        return json.dumps([f.as_dict() for f in selected])
    return "".join(f.render() + "\n" for f in selected)


def _findings_archive(days: int, lock_timeout: float) -> int:
    """Move closed findings older than `days` to the archive file; returns how many."""
    board = _board()
    path = _findings_path(board)
    archive = _findings_path(board, archive=True)
    cutoff = time.strftime("%Y-%m-%d", time.localtime(time.time() - days * 86400))
    with _board_lock(board, path, lock_timeout):
        lines, _ = _read_findings(path)
        keep, move = [], []
        for line in lines:
            finding = _parse_finding(line)
            if finding and finding.mark == "x" and finding.date < cutoff:
                move.append(line)
            else:
                keep.append(line)
        if not move:
            return 0
        with _board_lock(board, archive, lock_timeout):  # order: findings, then archive
            prior = archive.read_text(encoding="utf-8").splitlines() if archive.exists() else []
            _write_findings(board, archive, prior + move)  # archive BEFORE the rewrite
        _write_findings(board, path, keep)
    return len(move)


def _positive_or_zero_float(value: str) -> float:
    try:
        parsed = float(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("must be a number") from exc
    if not math.isfinite(parsed) or parsed < 0:
        raise argparse.ArgumentTypeError("must be finite and non-negative")
    return parsed


def _positive_or_zero_int(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("must be an integer") from exc
    if parsed < 0:
        raise argparse.ArgumentTypeError("must be non-negative")
    return parsed


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("repo-main", help="print the canonical shared checkout path")
    stale = commands.add_parser("read-stale-tasks", help="report stale activity, not owner liveness")
    stale.add_argument("--hours", type=_positive_or_zero_float, default=DEFAULT_STALE_HOURS)
    heartbeat = commands.add_parser("heartbeat-task", help="touch only this participant's active tasks")
    heartbeat.add_argument("--session", default=None, help="this session's id; stamped as **Session:**")
    heartbeat.add_argument("--tool", choices=("claude", "codex", "opencode", "pi", "cline", "agent"), required=True)

    prepend = commands.add_parser("prepend", help="atomically prepend one complete record")
    prepend.add_argument("--path", required=True)
    prepend.add_argument("--record-file", required=True)
    prepend.add_argument(
        "--lock-timeout", type=_positive_or_zero_float, default=DEFAULT_LOCK_TIMEOUT_SECONDS
    )

    replace = commands.add_parser(
        "replace-if-hash", help="atomically replace a file if its expected SHA-256 matches"
    )
    replace.add_argument("--path", required=True)
    replace.add_argument("--expected-sha", required=True)
    replace.add_argument("--content-file", required=True)
    replace.add_argument(
        "--lock-timeout", type=_positive_or_zero_float, default=DEFAULT_LOCK_TIMEOUT_SECONDS
    )

    reserve_migration = commands.add_parser(
        "reserve-migration", help="atomically reserve a migration number for one task"
    )
    reserve_migration.add_argument("--task", required=True)
    reserve_migration.add_argument("--number", required=True)
    reserve_migration.add_argument(
        "--migration-root",
        required=True,
        help="repository-relative SQL migration directory for this project",
    )
    reserve_migration.add_argument(
        "--lock-timeout", type=_positive_or_zero_float, default=DEFAULT_LOCK_TIMEOUT_SECONDS
    )

    promote = commands.add_parser("promote-loops", help="record unfinished session loops as findings")
    promote.add_argument("--session-file", required=True)
    promote.add_argument("--scope", required=True)
    promote.add_argument("--by", required=True)
    promote.add_argument("--lock-timeout", type=_positive_or_zero_float, default=DEFAULT_LOCK_TIMEOUT_SECONDS)

    archive = commands.add_parser("archive-session", help="move and stage one live session")
    archive.add_argument("--session-file", required=True)
    archive.add_argument("--month", required=True)
    archive.add_argument(
        "--lock-timeout", type=_positive_or_zero_float, default=DEFAULT_LOCK_TIMEOUT_SECONDS
    )

    reader = commands.add_parser(
        "read-live-sessions", help="read bounded newest live session bytes"
    )
    reader.add_argument("--limit", type=_positive_or_zero_int, default=10)
    reader.add_argument("--max-bytes", type=_positive_or_zero_int, default=5120)

    post = commands.add_parser("post-message", help="post one message to a participant inbox")
    post.add_argument("--to", required=True)
    post.add_argument("--from", dest="sender", required=True)
    post.add_argument("--content-file", required=True)
    post.add_argument("--model", default=None, help="sender's model, e.g. claude-opus-4-8 (optional)")
    post.add_argument("--sess", default=None, help="short sender session tag (optional)")
    post.add_argument(
        "--kind", choices=MESSAGE_KINDS, default=None,
        help="blocker|question|answer wake an idle recipient; fyi (or none) waits",
    )
    post.add_argument("--task", default=None, help="task this message is about (optional)")
    post.add_argument(
        "--lock-timeout", type=_positive_or_zero_float, default=DEFAULT_LOCK_TIMEOUT_SECONDS
    )

    consume = commands.add_parser("consume-message", help="move one message (by id) to the archive")
    consume.add_argument("--name", required=True)
    consume.add_argument("--id", dest="message_id", required=True)
    consume.add_argument(
        "--lock-timeout", type=_positive_or_zero_float, default=DEFAULT_LOCK_TIMEOUT_SECONDS
    )

    inbox = commands.add_parser("read-inbox", help="read (optionally consume) a participant inbox")
    inbox.add_argument("--name", required=True)
    inbox.add_argument("--consume", action="store_true")
    inbox.add_argument("--max-bytes", type=_positive_or_zero_int, default=5120)
    inbox.add_argument(
        "--if-wakeable", action="store_true",
        help="return nothing unless a fresh blocker/question/answer is waiting",
    )
    inbox.add_argument(
        "--lock-timeout", type=_positive_or_zero_float, default=DEFAULT_LOCK_TIMEOUT_SECONDS
    )

    commands.add_parser("board-path", help="print the message board directory for this folder")

    recipients = commands.add_parser(
        "recipients", help="sessions that prompted on this board lately, newest first: who you can address"
    )
    recipients.add_argument("--hours", type=_positive_or_zero_float, default=RECIPIENT_HOURS)

    whoami = commands.add_parser("whoami", help="this session's own inbox name, from its turn record")
    whoami.add_argument("--tool", required=True, choices=("claude", "codex", "opencode", "pi", "cline"))
    whoami.add_argument("--session", required=True, help="$CLAUDE_CODE_SESSION_ID or $CODEX_THREAD_ID")

    sweep = commands.add_parser(
        "comms-sweep", help="archive messages older than --days, drop empty inboxes and stale session records"
    )
    sweep.add_argument("--days", type=_positive_or_zero_float, default=7.0)
    sweep.add_argument(
        "--lock-timeout", type=_positive_or_zero_float, default=DEFAULT_LOCK_TIMEOUT_SECONDS
    )

    turn = commands.add_parser("comms-turn", help="count peer-started turns since the operator")
    turn.add_argument("--name", required=True)
    turn.add_argument("--event", choices=("operator", "auto", "peek"), required=True)
    turn.add_argument(
        "--lock-timeout", type=_positive_or_zero_float, default=DEFAULT_LOCK_TIMEOUT_SECONDS
    )

    rollover = commands.add_parser("comms-rollover", help="move an ended session's inbox to the session continuing its work")
    rollover.add_argument("--from", dest="old", required=True)
    rollover.add_argument("--to", dest="new", required=True)
    rollover.add_argument(
        "--lock-timeout", type=_positive_or_zero_float, default=DEFAULT_LOCK_TIMEOUT_SECONDS
    )

    log = commands.add_parser("comms-log", help="append one receipt/wake/escalate log line")
    log.add_argument("--name", required=True)
    log.add_argument(
        "--event", choices=("receipt", "wake", "escalate", "bounce", "rollover", "route", "deliver", "triage"), required=True
    )
    log.add_argument("--id", dest="message_id", default=None)
    log.add_argument("--status", choices=RECEIPT_STATUSES, default=None)
    log.add_argument("--note", default="")
    log.add_argument(
        "--lock-timeout", type=_positive_or_zero_float, default=DEFAULT_LOCK_TIMEOUT_SECONDS
    )

    findings = commands.add_parser(
        "findings", help="shared findings list on this board: add/claim/close/release/list/archive"
    )
    findings_ops = findings.add_subparsers(dest="findings_action", required=True)
    f_add = findings_ops.add_parser("add", help="record one finding outside your task")
    f_add.add_argument("--scope", required=True, help="<repo>[+<repo>]/<area>[/<module>][#<task>]")
    f_add.add_argument("--text", required=True, help="what you saw, one line, no '|'")
    f_add.add_argument("--where", required=True, help="paths, log, job id that show it")
    f_add.add_argument("--from", dest="sender", required=True, help="<tool>--<folder>")
    f_add.add_argument("--sess", default=None, help="short sender session tag (optional)")
    f_claim = findings_ops.add_parser("claim", help="take an open finding into your task")
    f_claim.add_argument("finding_id")
    f_claim.add_argument("--by", required=True)
    f_claim.add_argument("--task", required=True, help="the .claude/tasks name that now owns it")
    f_close = findings_ops.add_parser("close", help="close with a PR/commit/decision ref, or disproved:/duplicate:")
    f_close.add_argument("finding_id")
    f_close.add_argument("--by", required=True)
    f_close.add_argument("--ref", required=True)
    f_release = findings_ops.add_parser("release", help="give a claimed finding back")
    f_release.add_argument("finding_id")
    f_release.add_argument("--by", required=True)
    f_list = findings_ops.add_parser("list", help="newest first; default status open,claimed")
    f_list.add_argument("--status", default="open,claimed", help="comma list of open,claimed,closed or all")
    f_list.add_argument("--repo", default=None, help="only findings naming this repo")
    f_list.add_argument("--here", action="store_true", help="only findings naming the repo around the cwd")
    f_list.add_argument("--area", default=None)
    f_list.add_argument("--module", default=None, help="module name or path prefix")
    f_list.add_argument("--task", default=None)
    f_list.add_argument("--mine", default=None, help="only findings claimed by this participant")
    f_list.add_argument("--limit", type=_positive_or_zero_int, default=0, help="0 = no limit")
    f_list.add_argument("--json", action="store_true")
    f_archive = findings_ops.add_parser("archive", help="move old closed findings to findings-archive.md")
    f_archive.add_argument("--days", type=_positive_or_zero_int, default=FINDINGS_ARCHIVE_AFTER_DAYS)
    for sub in (f_add, f_claim, f_close, f_release, f_archive):
        sub.add_argument(
            "--lock-timeout", type=_positive_or_zero_float, default=DEFAULT_LOCK_TIMEOUT_SECONDS
        )

    commands.add_parser(
        "task-queue",
        help="report delivery queue and cooperative admission facts as JSON",
    )

    complete = commands.add_parser(
        "complete-task", help="mark one accepted, validated task record done"
    )
    complete.add_argument("--task-file", required=True)
    complete.add_argument("--expected-sha", required=True)
    complete.add_argument("--implementation-sha", required=True)
    complete.add_argument("--verified-at", required=True)
    complete.add_argument("--reviewed-at", default="none")
    complete.add_argument("--review-required", action="store_true")
    complete.add_argument("--validation-passed", action="store_true")
    complete.add_argument(
        "--lock-timeout", type=_positive_or_zero_float, default=DEFAULT_LOCK_TIMEOUT_SECONDS
    )
    return parser


def _run_task_operation(args: argparse.Namespace) -> None:
    if args.command == "read-stale-tasks":
        print(json.dumps(_read_stale_tasks(args.hours), sort_keys=True))
        return
    if args.command == "heartbeat-task":
        print(json.dumps(_heartbeat_task(args.tool, getattr(args, "session", None)), sort_keys=True))
        return
    if args.command == "repo-main":
        print(_repository_paths()[0])
        return
    if args.command == "task-queue":
        print(json.dumps(_task_queue(), sort_keys=True))
        return
    _complete_task(
        args.task_file, args.expected_sha, args.implementation_sha,
        args.verified_at, args.reviewed_at, args.review_required,
        args.validation_passed, args.lock_timeout,
    )
    print(f"Completed {args.task_file}")


def _run_findings(args: argparse.Namespace) -> None:
    action = args.findings_action
    if action == "add":
        finding_id = _findings_add(
            args.scope, args.text, args.where, args.sender, args.sess, args.lock_timeout
        )
        print(f"Added {finding_id}")
    elif action in {"claim", "release", "close"}:
        updated = _findings_update(
            args.finding_id, args.by, args.lock_timeout, action,
            task=getattr(args, "task", None), ref=getattr(args, "ref", None),
        )
        print(updated.render())
    elif action == "list":
        statuses = set(FINDING_STATUSES) if args.status == "all" else {
            s.strip() for s in args.status.split(",") if s.strip()
        }
        unknown = statuses - set(FINDING_STATUSES)
        if unknown:
            raise ContextStateError(
                f"Unknown status {', '.join(sorted(unknown))}; use open, claimed, closed or all."
            )
        repo = _current_repo_name() if args.here else args.repo
        sys.stdout.write(
            _findings_list(
                statuses, repo, args.area, args.module, args.task, args.mine, args.limit,
                args.json,
            )
        )
    elif action == "archive":
        print(f"Archived {_findings_archive(args.days, args.lock_timeout)} closed findings")


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command in {"repo-main", "task-queue", "complete-task", "read-stale-tasks", "heartbeat-task"}:
            _run_task_operation(args)
        elif args.command == "prepend":
            _prepend(args.path, args.record_file, args.lock_timeout)
            print(f"Prepended record to {args.path}")
        elif args.command == "replace-if-hash":
            _replace_if_hash(args.path, args.expected_sha, args.content_file, args.lock_timeout)
            print(f"Replaced {args.path}")
        elif args.command == "reserve-migration":
            _reserve_migration(
                args.task, args.number, args.migration_root, args.lock_timeout
            )
            print(f"Reserved migration {int(args.number)} for {args.task}")
        elif args.command == "promote-loops":
            ids = _promote_loops(args.session_file, args.scope, args.by, args.lock_timeout)
            print(f"Promoted {len(ids)} open loops: {', '.join(ids)}")
        elif args.command == "archive-session":
            _archive_session(args.session_file, args.month, args.lock_timeout)
            print(f"Archived {args.session_file} into {args.month}")
        elif args.command == "read-live-sessions":
            sys.stdout.buffer.write(_read_live_sessions(args.limit, args.max_bytes))
        elif args.command == "post-message":
            message_id = _post_message(
                args.to, args.sender, args.content_file, args.lock_timeout,
                model=args.model, sess=args.sess, kind=args.kind, task=args.task,
            )
            print(f"Posted {message_id} to {args.to}")
        elif args.command == "consume-message":
            sys.stdout.buffer.write(_consume_message(args.name, args.message_id, args.lock_timeout))
        elif args.command == "read-inbox":
            sys.stdout.buffer.write(
                _read_inbox(
                    args.name, args.consume, args.max_bytes, args.lock_timeout,
                    if_wakeable=args.if_wakeable,
                )
            )
        elif args.command == "board-path":
            print(_board().directory)
        elif args.command == "recipients":
            listing = _format_recipients(_recipients(_board(), args.hours))
            print(listing if listing else f"No session has prompted on this board in {args.hours:g} h.")
        elif args.command == "whoami":
            print(_whoami(args.tool, args.session))
        elif args.command == "comms-sweep":
            counts = _comms_sweep(args.days, args.lock_timeout)
            print(f"Archived {counts['messages']} messages from {counts['inboxes']} inboxes; "
                  f"removed {counts['removed']} empty inboxes; dropped {counts['records']} stale session records")
        elif args.command == "comms-rollover":
            moved = _comms_rollover(args.old, args.new, args.lock_timeout)
            print(f"Moved {moved} messages from {args.old} to {args.new}")
        elif args.command == "comms-turn":
            print(_comms_turn(args.name, args.event, args.lock_timeout))
        elif args.command == "comms-log":
            _comms_log(
                args.name, args.event, args.message_id, args.status, args.note,
                args.lock_timeout,
            )
        elif args.command == "findings":
            _run_findings(args)
        else:  # pragma: no cover - argparse requires a known subcommand
            raise ContextStateError("Unknown context-state operation; choose a listed subcommand.")
    except ContextStateError as exc:
        print(f"context-state error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
