/**
 * Coordinate transforms between screen space and PDF user space (research R6).
 *
 * - Screen: CSS pixels, origin top-left, y down.
 * - Normalized: 0..1 relative to the *displayed* page box, origin top-left.
 * - PDF user space: points, origin bottom-left, y up.
 *
 * Placements are stored normalized so they survive zoom / device-pixel-ratio and
 * map deterministically to pdf-lib page geometry at export time.
 */

export type Rotation = 0 | 90 | 180 | 270;

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface NormBox {
  nx: number;
  ny: number;
  nw: number;
  nh: number;
}

export interface PageGeom {
  widthPt: number;
  heightPt: number;
  rotation: Rotation;
}

export interface PdfRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Screen point (within a rendered page element `rect`) → normalized 0..1 (top-left origin). */
export function screenToNormalized(point: { x: number; y: number }, rect: Rect): { nx: number; ny: number } {
  return {
    nx: clamp01((point.x - rect.left) / rect.width),
    ny: clamp01((point.y - rect.top) / rect.height),
  };
}

/** True if a normalized box lies fully within the page (FR-008). */
export function isWithinPage(box: NormBox): boolean {
  return (
    box.nx >= 0 &&
    box.ny >= 0 &&
    box.nw > 0 &&
    box.nh > 0 &&
    box.nx + box.nw <= 1 + 1e-9 &&
    box.ny + box.nh <= 1 + 1e-9
  );
}

/** Clamp a normalized box so it fits within the page (FR-008), preserving size where possible. */
export function clampBox(box: NormBox): NormBox {
  const nw = Math.min(Math.max(box.nw, 0), 1);
  const nh = Math.min(Math.max(box.nh, 0), 1);
  const nx = Math.min(Math.max(box.nx, 0), 1 - nw);
  const ny = Math.min(Math.max(box.ny, 0), 1 - nh);
  return { nx, ny, nw, nh };
}

/**
 * Normalized box (top-left origin, relative to the displayed page) → PDF rect
 * (bottom-left origin, points), accounting for page rotation.
 */
export function normalizedBoxToPdfRect(box: NormBox, page: PageGeom): PdfRect {
  const { widthPt: W, heightPt: H, rotation } = page;

  // For 90/270 the displayed page is rotated, so displayed width maps to page height.
  if (rotation === 90 || rotation === 270) {
    const w = box.nh * W;
    const h = box.nw * H;
    // Map displayed top-left box into unrotated page space.
    const x = rotation === 90 ? box.ny * W : W - (box.ny + box.nh) * W;
    const y = rotation === 90 ? box.nx * H : H - (box.nx + box.nw) * H;
    return { x, y, w, h };
  }

  const w = box.nw * W;
  const h = box.nh * H;
  if (rotation === 180) {
    return { x: W - (box.nx + box.nw) * W, y: (box.ny) * H, w, h };
  }
  // rotation 0: flip y (top-left → bottom-left)
  return { x: box.nx * W, y: H - (box.ny + box.nh) * H, w, h };
}
