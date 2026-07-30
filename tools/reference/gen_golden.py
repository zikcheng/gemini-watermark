#!/usr/bin/env python3
"""Run the reference C++ binary (gwt-mini v0.3.2) over all fixtures and
record golden outputs + detection scores + exit codes into manifest.json.

Runs per watermarked fixture:
  default : detection + auto legacy fallback   (the v0.3.1+ CLI default)
  force   : --force with the profile pinned    (pure reverse-alpha math path)
Negatives get a default run only and must exit 1 (skip, no output written).
Three designated cases additionally get a forced-size run, recording the
upstream size-override quirk exactly as the binary produces it (see
FORCED_SIZE_RUNS below).

The golden outputs and the parsed per-stage detection scores are the
equivalence targets for the TypeScript port, so the toolchain identity is
verified before anything runs: binary SHA256 + --version, and the upstream
checkout's commit. All three land in the manifest.

Inputs  (env):  GWT_REFERENCE_DIR/bin/gwt-mini  (override with --binary)
                GWT_REFERENCE_DIR/fixtures/     (run make_fixtures.py first)
                GWT_UPSTREAM_DIR                (commit identity only)
Outputs (env):  GWT_REFERENCE_DIR/golden/{default,force,forced_size}/*.png
                GWT_REFERENCE_DIR/golden/manifest.json
                plus an optional second copy via --manifest-out
"""
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import (cv2_version, decoded_pixel_sha256, die,  # noqa: E402
                     require_file, resolve_env_dirs, verify_reference_binary,
                     verify_upstream_checkout)

# Full three-stage detection log line (watermark_engine.cpp,
# detect_one_variant): "Detection: spatial={:.3f}, grad={:.3f}, var={:.3f}
# -> conf={:.3f} (DETECTED|not detected)" -- 3 decimals of precision.
# The scores are TM_CCOEFF_NORMED correlations over [-1, 1], so every
# numeric group must accept a leading minus: a clean image commonly scores
# negative, and a `[\d.]+` group silently drops the whole line (and with it
# an entire detection attempt) instead of failing loudly.
DETECT_RE = re.compile(
    r"Detection: spatial=(-?[\d.]+), grad=(-?[\d.]+), var=(-?[\d.]+) -> "
    r"conf=(-?[\d.]+) \((DETECTED|not detected)\)")
# Circuit-breaker early rejection (spatial NCC < 0.25) logs a different line
REJECT_RE = re.compile(r"Detection: spatial=(-?[\d.]+) < [\d.]+, rejected")
# remove_watermark(): "Removing watermark at ({}, {}) with {}x{} alpha map
# (size: {}, variant: {})". The only line reporting the position actually
# removed at (post-snap) and the template actually used -- together they
# are the evidence for the forced-size quirk.
REMOVE_RE = re.compile(
    r"Removing watermark at \((\d+), (\d+)\) with (\d+)x(\d+) alpha map "
    r"\(size: (Small|Large), variant: (V1|V2)\)")
# cli_app.cpp process_single(): the V2 -> V1 auto-fallback boundary, which
# is how each detection line gets attributed to a variant.
FALLBACK_RE = re.compile(r"retrying with legacy profile")

# Upstream size-override quirk (watermark_engine.cpp remove_watermark): the
# position comes from get_watermark_config(dims, variant), which ignores
# force_size, while the template comes from effective_alpha_map(force_size,
# ...). Each entry exercises a different mismatch direction: a large image
# forced small, a small image forced large, and a V1 case whose forced
# template overruns the image edge. Recorded exactly as produced, never
# "corrected" -- M0.md commit 2.
FORCED_SIZE_RUNS = {
    "v2-large-2752x1536": ["--force", "--no-legacy", "--force-small"],
    "v2-small-1024x572": ["--force", "--no-legacy", "--force-large"],
    "v1-small-800x600": ["--force", "--legacy", "--force-large"],
}


def run(binary: Path, argv: list[str]) -> tuple[int, str]:
    r = subprocess.run([str(binary), *argv],
                       capture_output=True, text=True, timeout=120)
    return r.returncode, r.stdout + r.stderr


def parse_log(log: str, start_variant: str) -> dict:
    """Parse detections and the removal position out of one -v run.

    Sequence for a default run: V2 gate detection first; if it passes, a
    second identical-variant detection follows (remove_watermark re-detects
    internally for position snap). If V2 skips, the V1 fallback gate (and
    on success its remove-internal re-detection) follows. The variant is
    tracked across the fallback boundary; the removal line attributes back
    to the detection that produced its position.
    """
    detections: list[dict] = []
    removal = None
    variant = start_variant

    for line in log.splitlines():
        if FALLBACK_RE.search(line):
            variant = "V1"
            continue

        m = DETECT_RE.search(line)
        if m:
            detections.append({
                "variant": variant,
                "spatial": float(m[1]), "gradient": float(m[2]),
                "variance": float(m[3]), "confidence": float(m[4]),
                "circuit_breaker": False,
                "detected": m[5] == "DETECTED",
            })
            continue

        m = REJECT_RE.search(line)
        if m:
            spatial = float(m[1])
            detections.append({
                "variant": variant,
                "spatial": spatial, "circuit_breaker": True,
                # The breaker returns confidence = spatial * 0.5 and never
                # reaches the gradient/variance stages.
                "confidence": round(spatial * 0.5, 4), "detected": False,
            })
            continue

        if "Detection:" in line:
            # Never let an unrecognized shape drop an attempt silently --
            # a missing detection is indistinguishable from one that never
            # ran, which would quietly corrupt the manifest oracle.
            #
            # One legitimate upstream shape is deliberately not parsed:
            # "Detection: ROI out of bounds" (watermark_engine.cpp:398),
            # which returns an all-zero result before stage 1. No fixture
            # in the current set can trigger it, so there is no data to
            # pin its manifest representation against. M4 must decide
            # whether it counts as an attempt when it adds the synthetic
            # edge fixtures -- add the regex together with that fixture,
            # not before it.
            die(f"unrecognized detection log line, refusing to record a "
                f"partial manifest:\n  {line.strip()}\n"
                f"  If this is 'Detection: ROI out of bounds', a new fixture "
                f"reached an upstream branch the manifest has no shape for: "
                f"decide how it is recorded (see the comment at this check) "
                f"before regenerating.")

        m = REMOVE_RE.search(line)
        if m:
            x, y, aw, ah = int(m[1]), int(m[2]), int(m[3]), int(m[4])
            removal = {
                "removal_position": {"x": x, "y": y},
                "alpha_map": {"width": aw, "height": ah},
                "size": m[5], "variant": m[6],
            }
            # The immediately preceding detection is remove_watermark's
            # internal re-detection; its (possibly snapped) region is the
            # position used here.
            if detections:
                detections[-1]["snap_region"] = {"x": x, "y": y, "w": aw, "h": ah}
                detections[-1]["removal_position"] = {"x": x, "y": y}
            continue

        if "Removing watermark at" in line:
            die(f"unrecognized removal log line, refusing to record a "
                f"partial manifest:\n  {line.strip()}")

    return {"detections": detections, "removal": removal}


def record_run(binary: Path, argv: list[str], inp: Path, out: Path,
               start_variant: str) -> dict:
    """Execute one run and turn it into a manifest run entry.

    The recorded `argv` keeps the `<in>`/`<out>` placeholders: the manifest
    is committed, so it must carry no machine-local paths.
    """
    concrete = [a.replace("<in>", str(inp)).replace("<out>", str(out))
                for a in argv]
    code, log = run(binary, concrete)
    parsed = parse_log(log, start_variant)

    entry: dict = {"argv": list(argv), "exit_code": code}
    if parsed["detections"]:
        entry["detections"] = parsed["detections"]
    if parsed["removal"]:
        entry["removal_position"] = parsed["removal"]["removal_position"]
        entry["alpha_map"] = parsed["removal"]["alpha_map"]
        entry["removal_size"] = parsed["removal"]["size"]
        entry["removal_variant"] = parsed["removal"]["variant"]
    entry["output_written"] = out.exists()
    entry["output_decoded_sha256"] = (
        decoded_pixel_sha256(out) if out.exists() else None)
    return entry


def eligible_tags(fx: dict, runs: dict, is_jpeg: bool) -> list[str]:
    """Derive eligible_for from measured run results, never hand-assigned.

    - detection   : every case has a default run whose decisions M4 must
                    reproduce (negatives included -- a skip is a decision)
    - default_e2e : every case is a default-path e2e case; processed ones
                    compare against golden-default, skipped ones assert the
                    buffer came back untouched (M5.md commit 1)
    - force_remove: the force run produced an output to compare (M2.md)
    - add_v1 /    : forward-blend targets. Upstream add only implements the
      add_v2_ext    V1 geometry, so V2 cases are the documented TS
                    extension whose oracle is C++ remove (PLAN.md matrix).
                    JPEG is excluded: recompression breaks exact math.
    - forced_size : this case has a size-override run recorded
    """
    tags = ["detection", "default_e2e"]
    if runs["force"]["exit_code"] == 0 and runs["force"]["output_written"]:
        tags.append("force_remove")
    if not is_jpeg:
        tags.append("add_v1" if fx["variant"] == "V1" else "add_v2_ext")
    if "forced_size" in runs:
        tags.append("forced_size")
    return tags


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--binary", type=Path, default=None,
        help="reference gwt-mini binary (default: $GWT_REFERENCE_DIR/bin/gwt-mini)")
    parser.add_argument(
        "--manifest-out", type=Path, default=None,
        help="write a second copy of the manifest here (used to refresh the "
             "committed test/data/manifest.json)")
    args = parser.parse_args()

    env = resolve_env_dirs("GWT_UPSTREAM_DIR", "GWT_REFERENCE_DIR")
    ref = env["GWT_REFERENCE_DIR"]
    binary = args.binary.expanduser() if args.binary else ref / "bin/gwt-mini"

    toolchain = verify_reference_binary(binary)
    toolchain["upstream_commit"] = verify_upstream_checkout(env["GWT_UPSTREAM_DIR"])
    toolchain["cv2_version"] = cv2_version()
    print(f"reference binary: {binary}\n"
          f"  version {toolchain['binary_version']} "
          f"sha256 {toolchain['binary_sha256'][:16]}...\n"
          f"  upstream {toolchain['upstream_commit'][:7]} "
          f"cv2 {toolchain['cv2_version']}")

    wm = ref / "fixtures/watermarked"
    golden = ref / "golden"
    fixtures_json = require_file(
        ref / "fixtures/fixtures.json", "fixtures.json",
        "Run tools/reference/make_fixtures.py first.")
    fixtures = json.loads(fixtures_json.read_text())
    for sub in ("default", "force", "forced_size"):
        (golden / sub).mkdir(parents=True, exist_ok=True)

    manifest = {
        "reference_binary": "gwt-mini v0.3.2 (macOS Universal, release build)",
        "toolchain": dict(toolchain),
        "cases": [],
    }

    for fx in fixtures["fixtures"]:
        name = fx["name"]
        is_jpeg = bool(fx.get("jpeg_quality"))
        inp = require_file(wm / f"{name}{'.jpg' if is_jpeg else '.png'}",
                           f"fixture {name}",
                           "Run tools/reference/make_fixtures.py first.")
        runs = {}

        # --- default run: detection + auto legacy fallback ---
        runs["default"] = record_run(
            binary, ["--no-banner", "-v", "-i", "<in>", "-o", "<out>"],
            inp, golden / "default" / f"{name}.png", "V2")

        # --- force run: pure math path, profile pinned ---
        pin = "--legacy" if fx["variant"] == "V1" else "--no-legacy"
        runs["force"] = record_run(
            binary,
            ["--no-banner", "-v", "--force", pin, "-i", "<in>", "-o", "<out>"],
            inp, golden / "force" / f"{name}.png", fx["variant"])

        # --- forced-size run: the upstream size-override quirk, as-is ---
        if name in FORCED_SIZE_RUNS:
            flags = FORCED_SIZE_RUNS[name]
            entry = record_run(
                binary, ["--no-banner", "-v", *flags, "-i", "<in>", "-o", "<out>"],
                inp, golden / "forced_size" / f"{name}.png",
                "V1" if "--legacy" in flags else "V2")
            entry["flag"] = ("force-small" if "--force-small" in flags
                             else "force-large")
            runs["forced_size"] = entry

        manifest["cases"].append({
            "name": name,
            "input": {
                "format": "jpg" if is_jpeg else "png",
                "width": fx["width"], "height": fx["height"],
                "decoded_pixel_sha256": decoded_pixel_sha256(inp),
            },
            "fixture": {
                "variant": fx["variant"], "margin": fx["margin"],
                "logo_size": fx["logo_size"], "position": fx["position"],
            },
            "eligible_for": eligible_tags(fx, runs, is_jpeg),
            "runs": runs,
            "toolchain": dict(toolchain),
        })

        det = runs["default"].get("detections", [])
        # Every attempt, in order: a single number would hide the V2->V1
        # fallback and, on a skip, which attempt upstream actually reports.
        conf = ",".join(f"{d['confidence']:.3f}" for d in det) or "?"
        extra = ""
        if "forced_size" in runs:
            fs = runs["forced_size"]
            pos, amap = fs.get("removal_position"), fs.get("alpha_map")
            extra = f" | forced_size exit={fs['exit_code']}"
            if pos and amap:
                extra += (f" pos=({pos['x']},{pos['y']}) "
                          f"alpha={amap['width']}x{amap['height']}")
        print(f"{name}: default exit={runs['default']['exit_code']} conf={conf} "
              f"| force exit={runs['force']['exit_code']}{extra}")

    for fx in fixtures["negatives"]:
        name = fx["name"]
        inp = require_file(wm / f"{name}.png", f"fixture {name}",
                           "Run tools/reference/make_fixtures.py first.")
        entry = record_run(
            binary, ["--no-banner", "-v", "-i", "<in>", "-o", "<out>"],
            inp, golden / "default" / f"{name}.png", "V2")

        manifest["cases"].append({
            "name": name,
            "input": {
                "format": "png", "width": fx["width"], "height": fx["height"],
                "decoded_pixel_sha256": decoded_pixel_sha256(inp),
            },
            "fixture": None,
            "eligible_for": ["detection", "default_e2e"],
            "runs": {"default": entry},
            "toolchain": dict(toolchain),
        })

        confs = ",".join(f"{d['confidence']:.3f}"
                         for d in entry.get("detections", []))
        print(f"{name}: exit={entry['exit_code']} (expect 1) confs=[{confs}] "
              f"output_written={entry['output_written']} (expect False)")

    payload = json.dumps(manifest, indent=2) + "\n"
    (golden / "manifest.json").write_text(payload)
    if args.manifest_out:
        out_path = args.manifest_out.expanduser()
        out_path.write_text(payload)
        print(f"manifest copy -> {out_path}")

    tally: dict[str, int] = {}
    for case in manifest["cases"]:
        for tag in case["eligible_for"]:
            tally[tag] = tally.get(tag, 0) + 1
    print(f"\nWrote manifest with {len(manifest['cases'])} cases")
    print("eligible_for tally: "
          + ", ".join(f"{k}={v}" for k, v in sorted(tally.items())))


if __name__ == "__main__":
    main()
