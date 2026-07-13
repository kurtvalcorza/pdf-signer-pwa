import { describe, it, expect } from 'vitest';
import {
  screenToNormalized,
  normalizedBoxToPdfRect,
  isWithinPage,
  type PageGeom,
} from '../../src/lib/coords';

describe('screenToNormalized', () => {
  const rect = { left: 100, top: 50, width: 400, height: 800 };

  it('maps a point to normalized coords', () => {
    expect(screenToNormalized({ x: 300, y: 450 }, rect)).toEqual({ nx: 0.5, ny: 0.5 });
  });

  it('clamps out-of-bounds points to [0,1]', () => {
    expect(screenToNormalized({ x: 0, y: 0 }, rect)).toEqual({ nx: 0, ny: 0 });
    expect(screenToNormalized({ x: 9999, y: 9999 }, rect)).toEqual({ nx: 1, ny: 1 });
  });
});

describe('normalizedBoxToPdfRect (rotation 0)', () => {
  const page: PageGeom = { widthPt: 200, heightPt: 400, rotation: 0 };

  it('converts a top-left-origin box to a bottom-left-origin PDF rect', () => {
    // Box at top-left quarter of the page.
    const r = normalizedBoxToPdfRect({ nx: 0, ny: 0, nw: 0.5, nh: 0.25 }, page);
    expect(r.w).toBe(100);
    expect(r.h).toBe(100);
    expect(r.x).toBe(0);
    // Top of page in PDF space: y = H - nh*H = 400 - 100 = 300.
    expect(r.y).toBe(300);
  });

  it('round-trips a centered placement stably', () => {
    const box = { nx: 0.25, ny: 0.375, nw: 0.5, nh: 0.25 };
    const r = normalizedBoxToPdfRect(box, page);
    expect(r).toEqual({ x: 50, y: 150, w: 100, h: 100 });
  });
});

describe('normalizedBoxToPdfRect (rotation 180)', () => {
  it('mirrors x and keeps size', () => {
    const page: PageGeom = { widthPt: 200, heightPt: 400, rotation: 180 };
    const r = normalizedBoxToPdfRect({ nx: 0, ny: 0, nw: 0.5, nh: 0.25 }, page);
    expect(r.w).toBe(100);
    expect(r.h).toBe(100);
    expect(r.x).toBe(100); // W - (0 + 0.5)*W = 100
  });
});

describe('isWithinPage', () => {
  it('accepts an in-bounds box and rejects an overflowing one', () => {
    expect(isWithinPage({ nx: 0.1, ny: 0.1, nw: 0.5, nh: 0.5 })).toBe(true);
    expect(isWithinPage({ nx: 0.8, ny: 0.1, nw: 0.5, nh: 0.5 })).toBe(false);
  });
});
