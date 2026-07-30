import { describe, expect, it } from 'vitest';

import {
  getWatermarkConfig,
  getWatermarkSize,
  getWatermarkTopLeft,
  roundHalfAwayFromZero,
} from '../src/position.js';
import fixtures from './data/fixtures.json';

describe('roundHalfAwayFromZero', () => {
  it('matches C++ std::round semantics', () => {
    expect(roundHalfAwayFromZero(0.5)).toBe(1);
    expect(roundHalfAwayFromZero(-0.5)).toBe(-1);
    expect(roundHalfAwayFromZero(1.5)).toBe(2);
    expect(roundHalfAwayFromZero(2.5)).toBe(3);
    expect(roundHalfAwayFromZero(-2.5)).toBe(-3);
    expect(roundHalfAwayFromZero(71.44)).toBe(71);
    expect(roundHalfAwayFromZero(69.82)).toBe(70);
    expect(roundHalfAwayFromZero(0)).toBe(0);
  });

  it('diverges from Math.round only on negative halves (documenting why it exists)', () => {
    expect(Math.round(-0.5)).toBe(-0);
    expect(roundHalfAwayFromZero(-0.5)).toBe(-1);
  });
});

describe('getWatermarkSize', () => {
  it('is large only when BOTH dimensions exceed 1024', () => {
    expect(getWatermarkSize(1025, 1025)).toBe('large');
    expect(getWatermarkSize(1024, 1024)).toBe('small');
    expect(getWatermarkSize(2752, 1024)).toBe('small');
    expect(getWatermarkSize(1024, 2752)).toBe('small');
    expect(getWatermarkSize(800, 600)).toBe('small');
  });
});

describe('getWatermarkConfig — equivalence with C++ reference fixtures', () => {
  // Each fixture's margin/logoSize/position were produced by the reference
  // pipeline and validated against the C++ binary (gwt-mini v0.3.2): the
  // binary's --force removal at these exact positions restores the ground
  // truth originals within ±1 quantization.
  for (const fx of fixtures.fixtures) {
    it(`${fx.name} (${fx.variant} ${fx.width}x${fx.height})`, () => {
      const config = getWatermarkConfig(fx.width, fx.height, fx.variant as 'V1' | 'V2');
      expect(config.logoSize).toBe(fx.logo_size);
      expect(config.marginRight).toBe(fx.margin);
      expect(config.marginBottom).toBe(fx.margin);
      const pos = getWatermarkTopLeft(config, fx.width, fx.height);
      expect(pos).toEqual(fx.position);
    });
  }
});

describe('getWatermarkConfig — V2 small canonical-source inference branches', () => {
  it('selects 2752 canonical for short side >= 566', () => {
    expect(getWatermarkConfig(1024, 572, 'V2')).toEqual({
      marginRight: 71,
      marginBottom: 71,
      logoSize: 36,
    });
  });

  it('selects 2816 canonical for short side in [550, 566)', () => {
    expect(getWatermarkConfig(1024, 559, 'V2')).toEqual({
      marginRight: 70,
      marginBottom: 70,
      logoSize: 36,
    });
  });

  it('selects 2848 canonical for short side < 550', () => {
    expect(getWatermarkConfig(1024, 540, 'V2')).toEqual({
      marginRight: 69,
      marginBottom: 69,
      logoSize: 36,
    });
  });

  it('half-scale outputs (long side > 1100) double back to their canonical', () => {
    // 1376x768 = exactly half of canonical 2752x1536 -> scale 0.5
    expect(getWatermarkConfig(1376, 768, 'V2')).toEqual({
      marginRight: 96,
      marginBottom: 96,
      logoSize: 48,
    });
    // 1408-class and 1424-class free-tier variants
    expect(getWatermarkConfig(1408, 768, 'V2').logoSize).toBe(48);
    expect(getWatermarkConfig(1424, 768, 'V2').logoSize).toBe(48);
  });

  it('is orientation-agnostic (portrait mirrors landscape)', () => {
    const landscape = getWatermarkConfig(1024, 572, 'V2');
    const portrait = getWatermarkConfig(572, 1024, 'V2');
    expect(portrait).toEqual(landscape);
  });
});

describe('getWatermarkConfig — V1 legacy profile', () => {
  it('uses fixed margins regardless of aspect', () => {
    expect(getWatermarkConfig(800, 600, 'V1')).toEqual({
      marginRight: 32,
      marginBottom: 32,
      logoSize: 48,
    });
    expect(getWatermarkConfig(1500, 1200, 'V1')).toEqual({
      marginRight: 64,
      marginBottom: 64,
      logoSize: 96,
    });
  });
});

describe('getWatermarkConfig — defaults', () => {
  it('defaults to the V2 (current) profile', () => {
    expect(getWatermarkConfig(1500, 1200)).toEqual(getWatermarkConfig(1500, 1200, 'V2'));
  });
});
