#!/usr/bin/env python3
"""Shared plumbing for the reference-kit generation scripts.

Every path these scripts touch is resolved from an environment variable or
an explicit command-line argument. There are deliberately **no default
paths**: a kit generated against an unknown checkout or an unknown binary
is not an oracle, so a missing variable is a hard error (exit 2) rather
than a silent fallback to someone's home directory.
"""
import hashlib
import os
import subprocess
import sys
from pathlib import Path
from typing import NoReturn

# Exit code for "the environment is not set up correctly" — matches the
# reference CLI's own convention (0 = processed, 1 = skipped, 2 = error;
# cli_app.cpp `run()`), so callers can treat 2 uniformly as "real failure".
EXIT_USAGE = 2

# Pinned toolchain identity. The kit is only reproducible against this exact
# binary; gen_golden.py refuses to run otherwise and records both values in
# the manifest. The hash is the macOS Universal `gwt-mini` from the v0.3.2
# release (see README.md for the download URL and the archive hash).
REFERENCE_BINARY_SHA256 = (
    "8f4796a1450a6471d29dc670627c73d6506c3fd686370c258b7d986b8de453d1"
)
REFERENCE_BINARY_VERSION = "0.3.2"
UPSTREAM_COMMIT = "7c6a99f"


def die(message: str) -> NoReturn:
    """Print an actionable error and exit 2."""
    print(f"error: {message}", file=sys.stderr)
    sys.exit(EXIT_USAGE)


def env_dir(var: str, purpose: str, example: str) -> Path:
    """Resolve a directory from an environment variable, or exit 2.

    Never falls back to a default location — see the module docstring.
    """
    raw = os.environ.get(var, "").strip()
    if not raw:
        die(
            f"{var} is not set.\n"
            f"  {var} must point at {purpose}.\n"
            f"  Example: export {var}={example}"
        )
    path = Path(raw).expanduser()
    if not path.is_dir():
        die(
            f"{var} does not point at a directory: {path}\n"
            f"  It must point at {purpose}."
        )
    return path


def upstream_dir() -> Path:
    """The GeminiWatermarkTool C++ checkout (v0.3.2, commit 7c6a99f)."""
    return env_dir(
        "GWT_UPSTREAM_DIR",
        f"the upstream GeminiWatermarkTool checkout at commit {UPSTREAM_COMMIT}",
        "$HOME/GeminiWatermarkTool",
    )


def reference_dir() -> Path:
    """The reference kit working directory (binary, alpha, fixtures, golden)."""
    return env_dir(
        "GWT_REFERENCE_DIR",
        "the reference kit directory (holds bin/, alpha/, fixtures/, golden/)",
        "$HOME/gwt-reference",
    )


def require_file(path: Path, what: str, hint: str) -> Path:
    """Exit 2 unless `path` exists as a file."""
    if not path.is_file():
        die(f"{what} not found: {path}\n  {hint}")
    return path


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_reference_binary(binary: Path) -> dict:
    """Check the binary against the pinned SHA256 and --version, or exit 2.

    Returns the measured values so callers can record them in the manifest.
    """
    require_file(
        binary,
        "reference binary",
        "Download gwt-mini from the v0.3.2 release (see tools/reference/README.md) "
        "or pass --binary <path>.",
    )
    if not os.access(binary, os.X_OK):
        die(f"reference binary is not executable: {binary}\n  Run: chmod +x {binary}")

    digest = sha256_file(binary)
    if digest != REFERENCE_BINARY_SHA256:
        die(
            f"reference binary SHA256 mismatch: {binary}\n"
            f"  expected {REFERENCE_BINARY_SHA256}\n"
            f"  actual   {digest}\n"
            "  The golden data is only reproducible against the pinned v0.3.2 "
            "build; re-download it rather than regenerating with another binary."
        )

    try:
        proc = subprocess.run(
            [str(binary), "--version", "--no-banner"],
            capture_output=True,
            text=True,
            timeout=60,
        )
    except OSError as exc:
        die(f"could not execute the reference binary {binary}: {exc}")

    version = (proc.stdout + proc.stderr).strip()
    if proc.returncode != 0 or version != REFERENCE_BINARY_VERSION:
        die(
            f"reference binary version mismatch: {binary}\n"
            f"  expected {REFERENCE_BINARY_VERSION} (exit 0)\n"
            f"  actual   {version!r} (exit {proc.returncode})"
        )

    return {"binary_sha256": digest, "binary_version": version}
