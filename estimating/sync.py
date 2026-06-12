"""Push library raw costs into chest tool presets (verify-then-write)."""
import glob
import os

from . import btx


class SyncVerifyError(RuntimeError):
    """Raised when post-write verification fails for a chest file.

    Files listed in `verified_changes` were written AND re-read successfully
    before the failure; the file at `failed_path` is suspect and any later
    chests were not touched."""

    def __init__(self, message, verified_changes, failed_path):
        super().__init__(message)
        self.verified_changes = verified_changes
        self.failed_path = failed_path


def sync_presets(chest_dir, rows):
    """Returns list of (subject, old, new) actually changed and verified.

    Skips provisional and retired rows and tools not in the library.
    Verification scope: every tool in this chest whose subject is in the
    active library is re-read after writing; tools not in the library are
    neither modified nor verified. On verification failure raises
    SyncVerifyError carrying the changes already verified in earlier files."""
    rates = {r.subject: f"{float(r.raw_cost):.2f}"
             for r in rows if r.status == "active"}
    verified = []
    pattern = os.path.join(str(chest_dir), btx.CHEST_GLOB)
    for path in sorted(glob.glob(pattern)):
        ts = btx.read_toolset(path)
        file_changes = []
        for tool in ts.tools:
            new = rates.get(tool.subject)
            old = tool.preset_unit_cost
            if new is None or old == new:
                continue
            btx.set_preset_unit_cost(tool, new)
            file_changes.append((tool.subject, old, new))
        if not file_changes:
            continue
        btx.write_toolset(ts, path)
        try:
            verify_ts = btx.read_toolset(path)
        except Exception as e:
            raise SyncVerifyError(
                f"post-write re-read failed for {path}: {e}",
                verified_changes=verified, failed_path=path) from e
        for tool in verify_ts.tools:
            expected = rates.get(tool.subject)
            if expected is not None and tool.preset_unit_cost != expected:
                raise SyncVerifyError(
                    f"post-write verification failed for {tool.subject!r} "
                    f"in {path}", verified_changes=verified,
                    failed_path=path)
        verified.extend(file_changes)
    return verified
