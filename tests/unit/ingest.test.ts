import { describe, it, expect } from 'vitest';
import { detectImageFormat } from '../../src/features/ingest/imageInput';
import { createPlacement, movePlacement, resizePlacement } from '../../src/features/placement/placement';

describe('detectImageFormat', () => {
  it('detects PNG from magic bytes', () => {
    expect(detectImageFormat(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0, 0))).toBe('png');
  });
  it('detects JPEG from magic bytes', () => {
    expect(detectImageFormat(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0))).toBe('jpeg');
  });
  it('falls back to MIME when bytes are ambiguous', () => {
    expect(detectImageFormat(Uint8Array.of(0, 0, 0), 'image/png')).toBe('png');
  });
  it('throws on unsupported input', () => {
    expect(() => detectImageFormat(Uint8Array.of(0, 0, 0), 'image/gif')).toThrow(/PNG or JPEG/);
  });
});

describe('placement model', () => {
  it('creates a centered, in-bounds placement', () => {
    const p = createPlacement('img1', 0);
    expect(p.pageIndex).toBe(0);
    expect(p.nx + p.nw).toBeLessThanOrEqual(1 + 1e-9);
    expect(p.mode).toBe('visual');
  });
  it('keeps moves and resizes in-bounds', () => {
    const p = createPlacement('img1', 0);
    const moved = movePlacement(p, 0.95, 0.95);
    expect(moved.nx + moved.nw).toBeLessThanOrEqual(1 + 1e-9);
    const resized = resizePlacement(p, 2, 2);
    expect(resized.nw).toBeLessThanOrEqual(1);
    expect(resized.nh).toBeLessThanOrEqual(1);
  });
});
