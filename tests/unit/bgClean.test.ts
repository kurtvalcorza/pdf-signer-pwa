import { describe, it, expect } from 'vitest';
import { removeBackground } from '../../src/features/ingest/backgroundClean';

describe('removeBackground', () => {
  it('makes near-white pixels transparent and keeps dark ones opaque', () => {
    // Two pixels: white, then near-black.
    const rgba = new Uint8ClampedArray([255, 255, 255, 255, 10, 10, 10, 255]);
    const out = removeBackground(rgba, 240);
    expect(out[3]).toBe(0); // white → transparent
    expect(out[7]).toBe(255); // dark → opaque
    // Colour channels are preserved.
    expect(Array.from(out.slice(4, 7))).toEqual([10, 10, 10]);
  });

  it('respects the threshold', () => {
    const grey = new Uint8ClampedArray([200, 200, 200, 255]);
    expect(removeBackground(grey, 240)[3]).toBe(255); // 200 < 240 → kept
    expect(removeBackground(grey, 150)[3]).toBe(0); // 200 >= 150 → transparent
  });

  it('does not mutate the input', () => {
    const rgba = new Uint8ClampedArray([255, 255, 255, 255]);
    removeBackground(rgba, 240);
    expect(rgba[3]).toBe(255);
  });
});
