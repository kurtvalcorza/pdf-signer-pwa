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

/** Parameters for pdf-lib `drawImage` that place an upright box on a (possibly rotated) page. */
export interface DrawParams {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Rotation to pass to pdf-lib (degrees), so the drawn content reads upright to the viewer. */
  rotate: Rotation;
}

/** Layout for a signature-widget appearance form XObject on a (possibly rotated) page. */
export interface AppearanceLayout {
  /** Natural (upright) content width in points. */
  widthPt: number;
  /** Natural (upright) content height in points. */
  heightPt: number;
  /** Form XObject `/Matrix` that pre-rotates the appearance so page `/Rotate` renders it upright. */
  matrix: [number, number, number, number, number, number];
}

/** Displayed (post-`/Rotate`) page dimensions in points. */
function displayDims(page: PageGeom): { Wd: number; Hd: number } {
  return page.rotation === 90 || page.rotation === 270
    ? { Wd: page.heightPt, Hd: page.widthPt }
    : { Wd: page.widthPt, Hd: page.heightPt };
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

/**
 * Draw parameters for a signature IMAGE placed as page content (Tier A / stampVisual).
 *
 * The box is upright in *display* space; on a rotated page the drawn content must be
 * counter-rotated so the viewer sees it upright. Returns the pivot, size and rotation
 * for pdf-lib's `drawImage` (whose CTM is translate(x,y)·rotate(θ)·scale(w,h)).
 */
export function normalizedBoxToDrawParams(box: NormBox, page: PageGeom): DrawParams {
  const { widthPt: W, heightPt: H, rotation } = page;
  const { Wd, Hd } = displayDims(page);

  const dw = box.nw * Wd; // box size in display points
  const dh = box.nh * Hd;
  const dx0 = box.nx * Wd; // box lower-left in display points (top-left origin flipped)
  const dy0 = Hd - (box.ny + box.nh) * Hd;

  switch (rotation) {
    case 90:
      return { x: W - dy0, y: dx0, width: dw, height: dh, rotate: 90 };
    case 180:
      return { x: W - dx0, y: H - dy0, width: dw, height: dh, rotate: 180 };
    case 270:
      return { x: dy0, y: H - dx0, width: dw, height: dh, rotate: 270 };
    default:
      return { x: dx0, y: dy0, width: dw, height: dh, rotate: 0 };
  }
}

/**
 * Appearance layout for a signature WIDGET (Tier B / signFirst). The widget `/Rect`
 * is axis-aligned in user space (use {@link normalizedBoxToPdfRect}); when the page
 * is displayed with `/Rotate`, that widget rotates with it. To keep the appearance
 * upright we draw the content in an upright box of `widthPt × heightPt` and set the
 * form XObject `/Matrix` to a pre-rotation that cancels the page rotation.
 */
export function appearanceLayout(box: NormBox, page: PageGeom): AppearanceLayout {
  const { Wd, Hd } = displayDims(page);
  const widthPt = box.nw * Wd;
  const heightPt = box.nh * Hd;
  const w = widthPt;
  const h = heightPt;

  // Rotate the content +rotation° CCW so it appears upright after the viewer applies
  // the page's clockwise /Rotate. Each matrix also carries a translation term that
  // shifts the rotated content box [0,w]×[0,h] back into positive space so the
  // transformed BBox is [0,rotatedW]×[0,rotatedH]. A spec-compliant reader re-fits
  // the transformed BBox into the widget /Rect regardless, but keeping it positive
  // avoids clipping/offset in readers that don't implement that fit precisely.
  const matrix: Record<Rotation, AppearanceLayout['matrix']> = {
    0: [1, 0, 0, 1, 0, 0],
    90: [0, 1, -1, 0, h, 0],
    180: [-1, 0, 0, -1, w, h],
    270: [0, -1, 1, 0, 0, w],
  };
  return { widthPt, heightPt, matrix: matrix[page.rotation] };
}
