#!/usr/bin/env python3
"""Run the reference C++ binary (gwt-mini v0.3.2) over all fixtures and
record golden outputs + detection scores + exit codes into manifest.json.

Runs per watermarked fixture:
  default : detection + auto legacy fallback   (the v0.3.1+ CLI default)
  force   : --force with the profile pinned    (pure reverse-alpha math path)
Negatives get a default run only and must exit 1 (skip, no output written).

The golden outputs and the parsed per-stage detection scores are the
equivalence targets for the TypeScript port, so the binary identity is
pinned: SHA256 and --version are verified before anything runs, and both
are recorded per case.

Inputs  (env):  GWT_REFERENCE_DIR/bin/gwt-mini  (override with --binary)
                GWT_REFERENCE_DIR/fixtures/     (run make_fixtures.py first)
Outputs (env):  GWT_REFERENCE_DIR/golden/{default,force}/*.png
                GWT_REFERENCE_DIR/golden/manifest.json
"""
import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path

from _common import (UPSTREAM_COMMIT, reference_dir, require_file,
                     verify_reference_binary)

# Full three-stage detection log line (watermark_engine.cpp,
# detect_one_variant): "Detection: spatial={:.3f}, grad={:.3f}, var={:.3f}
# -> conf={:.3f} (DETECTED|not detected)" -- 3 decimals of precision.
DETECT_RE = re.compile(
    r"Detection: spatial=([\d.]+), grad=([\d.]+), var=([\d.]+) -> "
    r"conf=([\d.]+) \((DETECTED|not detected)\)")
# Circuit-breaker early rejection (spatial NCC < 0.25) logs a different line
REJECT_RE = re.compile(r"Detection: spatial=([\d.]+) < [\d.]+, rejected")


def sha256(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def run(binary: Path, args: list[str]) -> tuple[int, str]:
    r = subprocess.run([str(binary), "--no-banner", "-v", *args],
                       capture_output=True, text=True, timeout=120)
    return r.returncode, r.stdout + r.stderr


def parse_detections(log: str) -> list[dict]:
    """Parse all detection lines in order.

    Sequence for a default run: V2 gate detection first; if it passes, a
    second identical-variant detection follows (remove_watermark re-detects
    internally for position snap). If V2 skips, the V1 fallback gate (and
    on success its remove-internal re-detection) follows.
    """
    out = []
    for line in log.splitlines():
        m = DETECT_RE.search(line)
        if m:
            out.append({
                "spatial": float(m[1]), "gradient": float(m[2]),
                "variance": float(m[3]), "confidence": float(m[4]),
                "detected": m[5] == "DETECTED",
            })
            continue
        m = REJECT_RE.search(line)
        if m:
            spatial = float(m[1])
            out.append({
                "spatial": spatial, "circuit_breaker": True,
                "confidence": round(spatial * 0.5, 4), "detected": False,
            })
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--binary", type=Path, default=None,
        help="reference gwt-mini binary (default: $GWT_REFERENCE_DIR/bin/gwt-mini)")
    args = parser.parse_args()

    ref = reference_dir()
    binary = args.binary.expanduser() if args.binary else ref / "bin/gwt-mini"
    toolchain = verify_reference_binary(binary)
    print(f"reference binary: {binary}\n"
          f"  version {toolchain['binary_version']} "
          f"sha256 {toolchain['binary_sha256']}")

    wm = ref / "fixtures/watermarked"
    golden = ref / "golden"
    fixtures_json = require_file(
        ref / "fixtures/fixtures.json", "fixtures.json",
        "Run tools/reference/make_fixtures.py first.")
    fixtures = json.loads(fixtures_json.read_text())
    (golden / "default").mkdir(parents=True, exist_ok=True)
    (golden / "force").mkdir(parents=True, exist_ok=True)

    manifest = {
        "reference_binary": "gwt-mini v0.3.2 (macOS Universal, release build)",
        "source_commit": UPSTREAM_COMMIT,
        "cases": [],
    }

    for fx in fixtures["fixtures"]:
        name = fx["name"]
        ext = ".jpg" if fx.get("jpeg_quality") else ".png"
        inp = wm / f"{name}{ext}"
        case = {"fixture": fx, "toolchain": dict(toolchain), "runs": {}}

        # --- default run: detection + auto legacy fallback ---
        out = golden / "default" / f"{name}.png"
        code, log = run(binary, ["-i", str(inp), "-o", str(out)])
        case["runs"]["default"] = {
            "args": ["-i", "<in>", "-o", "<out>"],
            "exit_code": code,
            "detections": parse_detections(log),
            "output_sha256": sha256(out) if out.exists() else None,
        }

        # --- force run: pure math path, profile pinned ---
        pin = "--legacy" if fx["variant"] == "V1" else "--no-legacy"
        out_f = golden / "force" / f"{name}.png"
        code_f, log_f = run(binary, ["--force", pin, "-i", str(inp), "-o", str(out_f)])
        case["runs"]["force"] = {
            "args": ["--force", pin, "-i", "<in>", "-o", "<out>"],
            "exit_code": code_f,
            "output_sha256": sha256(out_f) if out_f.exists() else None,
        }

        det = case["runs"]["default"]["detections"]
        conf = f"{det[-1]['confidence']:.3f}" if det else "?"
        print(f"{name}: default exit={code} conf={conf} | force exit={code_f}")
        manifest["cases"].append(case)

    for fx in fixtures["negatives"]:
        name = fx["name"]
        inp = wm / f"{name}.png"
        out = golden / "default" / f"{name}.png"
        code, log = run(binary, ["-i", str(inp), "-o", str(out)])
        case = {"fixture": fx, "negative": True, "toolchain": dict(toolchain),
                "runs": {"default": {
                    "exit_code": code,
                    "detections": parse_detections(log),
                    "output_written": out.exists(),
                }}}
        det = case["runs"]["default"]["detections"]
        confs = ",".join(f"{d['confidence']:.3f}" for d in det)
        print(f"{name}: exit={code} (expect 1) confs=[{confs}] "
              f"output_written={out.exists()} (expect False)")
        manifest["cases"].append(case)

    (golden / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"\nWrote manifest with {len(manifest['cases'])} cases")


if __name__ == "__main__":
    main()
