#!/usr/bin/env python3
"""Watermark geometry, ported from the upstream C++ engine.

Line-by-line port of the position/size logic in
GeminiWatermarkTool `src/core/watermark_engine.cpp` (v0.3.2, commit
7c6a99f). It lives in its own module because two generators depend on it
(`make_fixtures.py` places the watermark, `make_patches.py` derives the
regions the detector reads) and a disagreement between them would be an
invisible inconsistency in the oracle rather than a test failure.

Rounding follows C++ `std::round` (half away from zero), never Python's
banker's rounding — CLAUDE.md porting rule 1.
"""
import math
from typing import NamedTuple

# Detection ROI padding for the V2 small snap sweep (detect_one_variant).
SNAP_PAD = 3

# Canonical large-source widths the V2 small profile infers from
# (v2_small_config_from_dims).
V2_CANONICAL_SOURCES = (2752.0, 2816.0, 2848.0)


class WatermarkConfig(NamedTuple):
    """Port of `WatermarkPosition` (watermark_engine.hpp)."""

    margin_right: int
    margin_bottom: int
    logo_size: int


class Rect(NamedTuple):
    x: int
    y: int
    w: int
    h: int

    @property
    def x2(self) -> int:
        return self.x + self.w

    @property
    def y2(self) -> int:
        return self.y + self.h


def round_half_away(v: float) -> int:
    """C++ `std::round`: ties go away from zero.

    Python's built-in round() is banker's rounding and disagrees on .5
    boundaries — CLAUDE.md porting rule 1.
    """
    return int(math.floor(v + 0.5)) if v >= 0 else int(math.ceil(v - 0.5))


def get_watermark_size(width: int, height: int) -> str:
    """Port of `get_watermark_size`: Large only when BOTH dims exceed 1024."""
    return "large" if (width > 1024 and height > 1024) else "small"


def v2_small_config_from_dims(width: int, height: int) -> WatermarkConfig:
    """Port of `v2_small_config_from_dims`.

    Infers the canonical large source the output was downscaled from, then
    scales the 192 margin / 96 logo proportionally.
    """
    long_side, short_side = max(width, height), min(width, height)

    if long_side > 1100:
        # Half-scale outputs identify their canonical directly: twice the
        # long side lands on 2752/2816/2848.
        doubled = 2.0 * long_side
        source = min(V2_CANONICAL_SOURCES, key=lambda c: abs(doubled - c))
    elif short_side >= 566:
        source = 2752.0
    elif short_side >= 550:
        source = 2816.0
    else:
        source = 2848.0

    scale = long_side / source
    margin = round_half_away(192.0 * scale)
    # 1024-class outputs land at ~35-36 px, where the validated canonical
    # 36 template is kept; larger "small" outputs carry a proportional logo.
    ideal = round_half_away(96.0 * scale)
    logo = 36 if ideal <= 40 else ideal
    return WatermarkConfig(margin, margin, logo)


def get_watermark_config(width: int, height: int, variant: str) -> WatermarkConfig:
    """Port of `get_watermark_config`.

    Note this is **dims-based**: it never consults a forced size. That is
    what makes the forced-size runs misalign — see docs/plan/DEVIATIONS.md D3.
    """
    is_large = width > 1024 and height > 1024
    if variant == "V1":
        return WatermarkConfig(64, 64, 96) if is_large else WatermarkConfig(32, 32, 48)
    if is_large:
        return WatermarkConfig(192, 192, 96)
    return v2_small_config_from_dims(width, height)


def watermark_position(config: WatermarkConfig, width: int, height: int) -> tuple:
    """Port of `WatermarkPosition::get_position`: bottom-right anchored."""
    return (width - config.margin_right - config.logo_size,
            height - config.margin_bottom - config.logo_size)


def effective_alpha_size(size: str, variant: str, width: int, height: int) -> int:
    """Port of `effective_alpha_map`, reduced to the template's edge length.

    V2 small is the only branch that interpolates: the canonical 36x36
    template fits 1024-class outputs, and anything else is resampled from
    the 96px source to `config.logo_size`. Every other combination returns
    its base template (V1 small 48, V1/V2 large 96, V2 small 36).
    """
    if size == "small" and variant == "V2":
        # Upstream branches here on `config.logo_size != base.cols` (36):
        # unequal interpolates to config.logo_size, equal returns the 36px
        # base. Both arms yield config.logo_size, so the branch collapses --
        # kept as a comment rather than as dead code.
        return get_watermark_config(width, height, variant).logo_size
    if size == "large":
        return 96
    return 48 if variant == "V1" else 36


def detection_rects(width: int, height: int, variant: str,
                    force_size: str | None = None) -> list:
    """Every region `detect_one_variant` reads, for one (variant, size).

    Mirrors the function's own ROI arithmetic: the template ROI clamped to
    the image and widened by the snap pad for V2 small, plus the variance
    reference strip directly above it.
    """
    size = force_size or get_watermark_size(width, height)
    # Dims-based, exactly as the C++ does -- forced size does not move it.
    config = get_watermark_config(width, height, variant)
    pos_x, pos_y = watermark_position(config, width, height)
    alpha = effective_alpha_size(size, variant, width, height)

    needs_snap = variant == "V2" and size == "small"
    pad = SNAP_PAD if needs_snap else 0

    x1 = max(0, pos_x - pad)
    y1 = max(0, pos_y - pad)
    x2 = min(width, pos_x + alpha + pad)
    y2 = min(height, pos_y + alpha + pad)
    if x1 >= x2 or y1 >= y2:
        return []  # "Detection: ROI out of bounds" -- the detector returns early

    rects = [Rect(x1, y1, x2 - x1, y2 - y1)]

    # Variance reference strip. The C++ only scores it when ref_h > 8; we
    # include it from the first row so the patch is a superset of what the
    # detector reads rather than a near-miss.
    ref_h = min(y1, config.logo_size)
    if ref_h > 0:
        rects.append(Rect(x1, y1 - ref_h, x2 - x1, ref_h))
    return rects


def union_rects(rects: list) -> Rect:
    x1 = min(r.x for r in rects)
    y1 = min(r.y for r in rects)
    x2 = max(r.x2 for r in rects)
    y2 = max(r.y2 for r in rects)
    return Rect(x1, y1, x2 - x1, y2 - y1)


def expand_clamp(rect: Rect, pad: int, width: int, height: int) -> Rect:
    x1 = max(0, rect.x - pad)
    y1 = max(0, rect.y - pad)
    x2 = min(width, rect.x2 + pad)
    y2 = min(height, rect.y2 + pad)
    return Rect(x1, y1, x2 - x1, y2 - y1)


def contains(outer: Rect, inner: Rect) -> bool:
    return (outer.x <= inner.x and outer.y <= inner.y
            and outer.x2 >= inner.x2 and outer.y2 >= inner.y2)
