#!/usr/bin/env python3
"""Shared plumbing for the reference-kit generation scripts.

Every path these scripts touch is resolved from an environment variable or
an explicit command-line argument. There are deliberately **no default
paths**: a kit generated against an unknown checkout or an unknown binary
is not an oracle, so a missing variable is a hard error (exit 2) rather
than a silent fallback to someone's home directory.

The same reasoning pins the toolchain identity: the reference binary's
SHA256/version and the upstream checkout's commit are verified before any
data is produced, and recorded in the manifest alongside the data.
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

_ENV_SPECS = {
    "GWT_UPSTREAM_DIR": (
        f"the upstream GeminiWatermarkTool checkout at commit {UPSTREAM_COMMIT}",
        "$HOME/GeminiWatermarkTool",
    ),
    "GWT_REFERENCE_DIR": (
        "the reference kit directory (holds bin/, alpha/, fixtures/, golden/)",
        "$HOME/gwt-reference",
    ),
}


def die(message: str) -> NoReturn:
    """Print an actionable error and exit 2."""
    print(f"error: {message}", file=sys.stderr)
    sys.exit(EXIT_USAGE)


def resolve_env_dirs(*names: str) -> dict:
    """Resolve several env-var directories at once, or exit 2.

    Reports **every** problem in one shot rather than one per rerun, so a
    fresh setup learns the whole story from a single failure. Never falls
    back to a default location — see the module docstring.
    """
    problems, resolved = [], {}
    for name in names:
        purpose, example = _ENV_SPECS[name]
        raw = os.environ.get(name, "").strip()
        if not raw:
            problems.append(
                f"{name} is not set.\n"
                f"  {name} must point at {purpose}.\n"
                f"  Example: export {name}={example}"
            )
            continue
        path = Path(raw).expanduser()
        if not path.is_dir():
            problems.append(
                f"{name} does not point at a directory: {path}\n"
                f"  It must point at {purpose}."
            )
            continue
        resolved[name] = path
    if problems:
        die("\n".join(problems))
    return resolved


def upstream_dir() -> Path:
    """The GeminiWatermarkTool C++ checkout (v0.3.2, commit 7c6a99f)."""
    return resolve_env_dirs("GWT_UPSTREAM_DIR")["GWT_UPSTREAM_DIR"]


def reference_dir() -> Path:
    """The reference kit working directory (binary, alpha, fixtures, golden)."""
    return resolve_env_dirs("GWT_REFERENCE_DIR")["GWT_REFERENCE_DIR"]


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


def decoded_pixel_sha256(path: Path) -> str:
    """SHA256 over decoded RGB pixels, not container bytes.

    Normalization: cv2.imread(IMREAD_COLOR) -> BGR->RGB -> contiguous uint8
    HxWx3 -> .tobytes(). Two properties make this the right identity for a
    pixel oracle: it is the exact decode the reference binary sees
    (process_image() reads via cv::imread(..., IMREAD_COLOR)), and it is
    immune to PNG encoder drift across Pillow/zlib versions, which changes
    file bytes without changing a single pixel (docs/plan/DEVIATIONS.md).
    """
    import cv2  # local: only the golden/patch scripts need OpenCV
    import numpy as np

    img = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if img is None:
        die(f"could not decode image: {path}")
    rgb = np.ascontiguousarray(img[:, :, ::-1])
    return hashlib.sha256(rgb.tobytes()).hexdigest()


def cv2_version() -> str:
    """The cv2 build in use — part of the manifest's toolchain identity."""
    import cv2

    return cv2.__version__


def verify_upstream_checkout(upstream: Path) -> str:
    """Check the checkout sits on the pinned commit, or exit 2.

    Returns the full HEAD sha so the manifest records a measured value
    rather than echoing the pin (which is only a prefix).
    """
    try:
        proc = subprocess.run(
            ["git", "-C", str(upstream), "rev-parse", "HEAD"],
            capture_output=True, text=True, timeout=60,
        )
    except OSError as exc:
        die(f"could not run git in {upstream}: {exc}")
    if proc.returncode != 0:
        die(
            f"{upstream} is not a git checkout "
            f"(git rev-parse HEAD failed: {proc.stderr.strip()})\n"
            f"  GWT_UPSTREAM_DIR must point at a GeminiWatermarkTool clone "
            f"checked out at {UPSTREAM_COMMIT}."
        )
    head = proc.stdout.strip()
    if not head.startswith(UPSTREAM_COMMIT):
        die(
            f"upstream checkout is on the wrong commit: {upstream}\n"
            f"  expected {UPSTREAM_COMMIT}... (v0.3.2)\n"
            f"  actual   {head}\n"
            f"  Run: git -C {upstream} checkout {UPSTREAM_COMMIT}"
        )
    return head


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
