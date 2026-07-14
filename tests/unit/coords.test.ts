import { describe, it, expect } from 'vitest';
import {
  screenToNormalized,
  normalizedBoxToPdfRect,
  normalizedBoxToDrawParams,
  appearanceLayout,
  isWithinPage,
  type PageGeom,
  type NormBox,
  type DrawParams,
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

// The axis-aligned bounding box of the drawImage transform, in unrotated user space.
function aabbOfDraw(dp: DrawParams) {
  const { x, y, width: w, height: h, rotate } = dp;
  // CTM = translate(x,y)·rotate(θ)·scale(w,h) = [w·cosθ, w·sinθ, -h·sinθ, h·cosθ, x, y]
  const m: Record<number, [number, number, number, number, number, number]> = {
    0: [w, 0, 0, h, x, y],
    90: [0, w, -h, 0, x, y],
    180: [-w, 0, 0, -h, x, y],
    270: [0, -w, h, 0, x, y],
  };
  const [a, b, c, d, e, f] = m[rotate];
  const corners = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ].map(([s, t]) => [a * s + c * t + e, b * s + d * t + f]);
  const xs = corners.map((p) => p[0]);
  const ys = corners.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  return { x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 };
}

describe('normalizedBoxToDrawParams', () => {
  const box: NormBox = { nx: 0.15, ny: 0.62, nw: 0.4, nh: 0.1 };

  it('matches the plain rect for an unrotated page', () => {
    const page: PageGeom = { widthPt: 200, heightPt: 400, rotation: 0 };
    const dp = normalizedBoxToDrawParams(box, page);
    expect(dp.rotate).toBe(0);
    const r = normalizedBoxToPdfRect(box, page);
    expect(dp).toMatchObject({ x: r.x, y: r.y, width: r.w, height: r.h });
  });

  it.each([0, 90, 180, 270] as const)(
    'draws content whose bounding box equals the widget rect (rotation %i)',
    (rotation) => {
      const page: PageGeom = { widthPt: 200, heightPt: 400, rotation };
      const dp = normalizedBoxToDrawParams(box, page);
      const aabb = aabbOfDraw(dp);
      const rect = normalizedBoxToPdfRect(box, page);
      expect(aabb.x).toBeCloseTo(rect.x, 6);
      expect(aabb.y).toBeCloseTo(rect.y, 6);
      expect(aabb.w).toBeCloseTo(rect.w, 6);
      expect(aabb.h).toBeCloseTo(rect.h, 6);
    },
  );
});

describe('appearanceLayout', () => {
  const box: NormBox = { nx: 0.15, ny: 0.62, nw: 0.4, nh: 0.1 };

  it('uses upright content size and identity matrix at rotation 0', () => {
    const page: PageGeom = { widthPt: 200, heightPt: 400, rotation: 0 };
    const a = appearanceLayout(box, page);
    expect(a.widthPt).toBeCloseTo(0.4 * 200);
    expect(a.heightPt).toBeCloseTo(0.1 * 400);
    expect(a.matrix).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it('swaps display dims and rotates the matrix at rotation 90', () => {
    const page: PageGeom = { widthPt: 200, heightPt: 400, rotation: 90 };
    const a = appearanceLayout(box, page);
    // Displayed width maps to page height (400), displayed height to page width (200).
    expect(a.widthPt).toBeCloseTo(0.4 * 400); // 160
    expect(a.heightPt).toBeCloseTo(0.1 * 200); // 20
    // Rotation with a translation term (h) that keeps the rotated BBox positive.
    expect(a.matrix).toEqual([0, 1, -1, 0, 20, 0]);
  });

  it.each([
    [0, [1, 0, 0, 1, 0, 0]],
    [90, [0, 1, -1, 0, 20, 0]],
    [180, [-1, 0, 0, -1, 80, 40]],
    [270, [0, -1, 1, 0, 0, 160]],
  ] as const)('matrix rotates and keeps the BBox positive for rotation %i', (rotation, expected) => {
    const page: PageGeom = { widthPt: 200, heightPt: 400, rotation };
    expect(appearanceLayout(box, page).matrix).toEqual(expected);
  });

  it.each([0, 90, 180, 270] as const)(
    'transformed content BBox stays in positive space at origin (rotation %i)',
    (rotation) => {
      const page: PageGeom = { widthPt: 200, heightPt: 400, rotation };
      const { widthPt: w, heightPt: h, matrix } = appearanceLayout(box, page);
      const [a, b, c, d, e, f] = matrix;
      // Transform the four content-box corners [0,w]×[0,h] by the matrix.
      const corners = [
        [0, 0],
        [w, 0],
        [0, h],
        [w, h],
      ].map(([x, y]) => [a * x + c * y + e, b * x + d * y + f]);
      const xs = corners.map((p) => p[0]);
      const ys = corners.map((p) => p[1]);
      expect(Math.min(...xs)).toBeCloseTo(0, 6);
      expect(Math.min(...ys)).toBeCloseTo(0, 6);
      // Rotated extents: 0/180 keep w×h, 90/270 swap to h×w.
      const swap = rotation === 90 || rotation === 270;
      expect(Math.max(...xs)).toBeCloseTo(swap ? h : w, 6);
      expect(Math.max(...ys)).toBeCloseTo(swap ? w : h, 6);
    },
  );
});
