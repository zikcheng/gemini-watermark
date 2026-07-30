#!/usr/bin/env python3
"""Extract the four embedded BG-capture PNGs from embedded_assets.hpp.

The C++ project embeds its calibrated watermark background captures
(watermark rendered on pure black) as byte arrays. These are the source
of truth for the alpha maps:  alpha = max(R,G,B) / 255.

Inputs  (env):  GWT_UPSTREAM_DIR/assets/embedded_assets.hpp
Outputs (env):  GWT_REFERENCE_DIR/alpha/{bg_48,bg_96,bg_b_36,bg_b_96}.png
                (V1 small, V1 large, V2 small, V2 large)
"""
import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import (die, require_file, resolve_env_dirs,  # noqa: E402
                     verify_upstream_checkout)

ARRAYS = {
    "bg_48_png": "bg_48.png",      # V1 small (48x48)
    "bg_96_png": "bg_96.png",      # V1 large (96x96)
    "bg_b_36_png": "bg_b_36.png",  # V2 small (36x36)
    "bg_b_96_png": "bg_b_96.png",  # V2 large (96x96)
}


def main() -> None:
    argparse.ArgumentParser(description=__doc__).parse_args()

    env = resolve_env_dirs("GWT_UPSTREAM_DIR", "GWT_REFERENCE_DIR")
    verify_upstream_checkout(env["GWT_UPSTREAM_DIR"])

    hpp = require_file(
        env["GWT_UPSTREAM_DIR"] / "assets" / "embedded_assets.hpp",
        "embedded_assets.hpp",
        "GWT_UPSTREAM_DIR must point at the GeminiWatermarkTool checkout root.",
    )
    out = env["GWT_REFERENCE_DIR"] / "alpha"
    out.mkdir(parents=True, exist_ok=True)

    text = hpp.read_text()
    for array_name, out_name in ARRAYS.items():
        m = re.search(
            rf"unsigned char {re.escape(array_name)}\[\]\s*=\s*\{{(.*?)\}};",
            text, re.DOTALL)
        if not m:
            die(f"array {array_name} not found in {hpp}")
        data = bytes(int(tok, 16)
                     for tok in re.findall(r"0x[0-9a-fA-F]{2}", m.group(1)))
        if data[:8] != b"\x89PNG\r\n\x1a\n":
            die(f"{array_name} does not start with a PNG signature")
        (out / out_name).write_bytes(data)
        print(f"{out_name}: {len(data)} bytes")

    print(f"Extracted {len(ARRAYS)} PNGs to {out}")


if __name__ == "__main__":
    main()
