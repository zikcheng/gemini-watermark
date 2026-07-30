#!/usr/bin/env python3
"""Validate a reference manifest against the schema and its invariants.

Two layers, because a JSON Schema can only check shape:

1. Structural validation against manifest.schema.json.
2. Cross-field invariants that encode how the reference binary actually
   behaves -- exit-code/output agreement, the circuit-breaker confidence
   law, the fusion weights, fixture geometry, and eligible_for derivation.
   A violation here means the generator or the binary changed semantics,
   which is exactly the drift this file exists to catch.

Needs no environment variables: it validates a committed artifact.

Usage:  python3 tools/reference/validate_manifest.py test/data/manifest.json
Exits:  0 valid · 2 invalid (or usage error)
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import (REFERENCE_BINARY_SHA256,  # noqa: E402
                     REFERENCE_BINARY_VERSION, UPSTREAM_COMMIT, die,
                     require_file)

# PLAN.md tolerance budget for manifest-derived scores: the log carries 3
# decimals, so anything recomputed from those values inherits ~1e-3 of
# rounding noise. Never widen this to make a check pass.
SCORE_TOL = 2e-3

# watermark_engine.cpp detect_one_variant(): fusion weights and the gates.
W_SPATIAL, W_GRADIENT, W_VARIANCE = 0.50, 0.30, 0.20
SPATIAL_RESCUE = 0.30
INTERNAL_LABEL_THRESHOLD = 0.35


def check_toolchain(where: str, tc: dict, problems: list) -> None:
    if tc["binary_sha256"] != REFERENCE_BINARY_SHA256:
        problems.append(f"{where}: binary_sha256 is not the pinned build")
    if tc["binary_version"] != REFERENCE_BINARY_VERSION:
        problems.append(
            f"{where}: binary_version {tc['binary_version']!r} != "
            f"{REFERENCE_BINARY_VERSION!r}")
    if not tc["upstream_commit"].startswith(UPSTREAM_COMMIT):
        problems.append(
            f"{where}: upstream_commit {tc['upstream_commit'][:12]}... does "
            f"not start with the pin {UPSTREAM_COMMIT}")


def check_detection(where: str, det: dict, problems: list) -> None:
    if det["circuit_breaker"]:
        # Breaker path returns spatial*0.5 unclamped.
        expected = det["spatial"] * 0.5
        if abs(det["confidence"] - expected) > SCORE_TOL:
            problems.append(
                f"{where}: circuit-breaker confidence {det['confidence']} != "
                f"spatial*0.5 ({expected:.4f})")
        if det["detected"]:
            problems.append(f"{where}: circuit-breaker path cannot be detected")
        return

    fused = (det["spatial"] * W_SPATIAL + det["gradient"] * W_GRADIENT
             + det["variance"] * W_VARIANCE)
    fused = min(max(fused, 0.0), 1.0)
    if det["spatial"] >= SPATIAL_RESCUE:  # position-anchored spatial rescue
        fused = max(fused, det["spatial"])
    if abs(det["confidence"] - fused) > SCORE_TOL:
        problems.append(
            f"{where}: confidence {det['confidence']} != fused/rescued "
            f"{fused:.4f} (weights {W_SPATIAL}/{W_GRADIENT}/{W_VARIANCE})")

    # The 0.35 label; skip the check when rounding puts us on the boundary.
    if abs(det["confidence"] - INTERNAL_LABEL_THRESHOLD) > SCORE_TOL:
        expected = det["confidence"] >= INTERNAL_LABEL_THRESHOLD
        if det["detected"] != expected:
            problems.append(
                f"{where}: detected={det['detected']} disagrees with "
                f"confidence {det['confidence']} vs {INTERNAL_LABEL_THRESHOLD}")


def check_run(where: str, run: dict, problems: list) -> None:
    wrote = run["output_written"]
    if wrote != (run["output_decoded_sha256"] is not None):
        problems.append(
            f"{where}: output_written={wrote} disagrees with "
            f"output_decoded_sha256={run['output_decoded_sha256']!r}")
    # cli_app.cpp run(): 0 processed, 1 single-file skip (no output), 2 error.
    if run["exit_code"] == 0 and not wrote:
        problems.append(f"{where}: exit 0 but no output written")
    if run["exit_code"] == 1 and wrote:
        problems.append(f"{where}: exit 1 (skip) but an output was written")
    if run["exit_code"] == 2:
        problems.append(f"{where}: exit 2 (real failure) recorded")
    if wrote and "removal_position" not in run:
        problems.append(f"{where}: wrote an output but logged no removal position")
    for i, det in enumerate(run.get("detections", [])):
        check_detection(f"{where}.detections[{i}]", det, problems)


def check_case(case: dict, top_toolchain: dict, problems: list) -> None:
    name = case["name"]
    check_toolchain(f"{name}.toolchain", case["toolchain"], problems)
    if case["toolchain"] != top_toolchain:
        problems.append(f"{name}: per-case toolchain differs from the top-level one")

    fx, inp, runs = case["fixture"], case["input"], case["runs"]

    if fx is not None:
        # get_watermark_config(): bottom-right anchored position.
        for axis, dim in (("x", "width"), ("y", "height")):
            expected = inp[dim] - fx["margin"] - fx["logo_size"]
            if fx["position"][axis] != expected:
                problems.append(
                    f"{name}: fixture position.{axis}={fx['position'][axis]} != "
                    f"{dim}-margin-logo_size ({expected})")

    for run_name, run in runs.items():
        check_run(f"{name}.runs.{run_name}", run, problems)
        # The template must match the fixture geometry on every run except
        # forced_size, whose whole point is that it does not.
        amap = run.get("alpha_map")
        if run_name != "forced_size" and amap and fx is not None:
            if amap["width"] != fx["logo_size"] or amap["height"] != fx["logo_size"]:
                problems.append(
                    f"{name}.runs.{run_name}: alpha map "
                    f"{amap['width']}x{amap['height']} != fixture logo_size "
                    f"{fx['logo_size']}")

    if "forced_size" in runs and "force" in runs:
        fs, force = runs["forced_size"], runs["force"]
        same = fs["output_decoded_sha256"] == force["output_decoded_sha256"]
        fs_map, force_map = fs.get("alpha_map"), force.get("alpha_map")
        # Not an error either way; both outcomes are real upstream behavior
        # (see DEVIATIONS). Flag only the self-contradiction.
        if same and fs_map != force_map:
            problems.append(
                f"{name}: forced_size output identical to force but the "
                f"templates differ ({fs_map} vs {force_map})")

    # eligible_for must be reproducible from the recorded runs.
    expected = {"detection", "default_e2e"}
    force = runs.get("force")
    if force and force["exit_code"] == 0 and force["output_written"]:
        expected.add("force_remove")
    if fx is not None and inp["format"] != "jpg":
        expected.add("add_v1" if fx["variant"] == "V1" else "add_v2_ext")
    if "forced_size" in runs:
        expected.add("forced_size")
    if set(case["eligible_for"]) != expected:
        problems.append(
            f"{name}: eligible_for {sorted(case['eligible_for'])} is not "
            f"derivable from the runs (expected {sorted(expected)})")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path, help="path to manifest.json")
    parser.add_argument(
        "--schema", type=Path,
        default=Path(__file__).resolve().parent / "manifest.schema.json",
        help="path to manifest.schema.json (default: alongside this script)")
    args = parser.parse_args()

    manifest_path = require_file(args.manifest, "manifest", "Run gen_golden.py first.")
    schema_path = require_file(args.schema, "schema", "Expected next to this script.")

    try:
        import jsonschema
    except ModuleNotFoundError:
        die("jsonschema is not installed.\n"
            "  Run: pip install -r tools/reference/requirements.txt")

    manifest = json.loads(manifest_path.read_text())
    schema = json.loads(schema_path.read_text())

    validator = jsonschema.Draft202012Validator(schema)
    errors = sorted(validator.iter_errors(manifest), key=lambda e: list(e.path))
    if errors:
        lines = [f"{len(errors)} schema violation(s) in {manifest_path}:"]
        for err in errors[:20]:
            where = "/".join(str(p) for p in err.path) or "<root>"
            lines.append(f"  {where}: {err.message}")
        if len(errors) > 20:
            lines.append(f"  ... and {len(errors) - 20} more")
        die("\n".join(lines))

    problems: list[str] = []
    check_toolchain("toolchain", manifest["toolchain"], problems)

    names = [c["name"] for c in manifest["cases"]]
    if len(names) != len(set(names)):
        problems.append("case names are not unique")
    for case in manifest["cases"]:
        check_case(case, manifest["toolchain"], problems)

    if problems:
        die(f"{len(problems)} invariant violation(s) in {manifest_path}:\n  "
            + "\n  ".join(problems))

    tally: dict[str, int] = {}
    for case in manifest["cases"]:
        for tag in case["eligible_for"]:
            tally[tag] = tally.get(tag, 0) + 1

    print(f"OK  {manifest_path}")
    print(f"    {len(manifest['cases'])} cases, schema + invariants clean")
    print(f"    binary {manifest['toolchain']['binary_version']} "
          f"upstream {manifest['toolchain']['upstream_commit'][:7]} "
          f"cv2 {manifest['toolchain']['cv2_version']}")
    print("    eligible_for tally:")
    for tag, count in sorted(tally.items()):
        print(f"      {tag:<14} {count}")


if __name__ == "__main__":
    main()
