import {
  appearanceLayout,
  clampBox,
  type AppearanceLayout,
  type NormBox,
  type Rotation,
} from '../../lib/coords';

export type PlacementMode = 'visual' | 'crypto';

export interface Placement {
  id: string;
  imageId: string;
  pageIndex: number;
  nx: number;
  ny: number;
  nw: number;
  nh: number;
  mode: PlacementMode;
}

let seq = 0;
const nextId = () => `pl_${++seq}`;

/** Create a placement centered on a page, clamped in-bounds (FR-006/008). */
export function createPlacement(
  imageId: string,
  pageIndex: number,
  init?: Partial<Pick<Placement, 'nx' | 'ny' | 'nw' | 'nh' | 'mode'>>,
): Placement {
  const nw = init?.nw ?? 0.4;
  const nh = init?.nh ?? 0.12;
  const box = clampBox({
    nx: init?.nx ?? (1 - nw) / 2,
    ny: init?.ny ?? (1 - nh) / 2,
    nw,
    nh,
  });
  return { id: nextId(), imageId, pageIndex, mode: init?.mode ?? 'visual', ...box };
}

/** Move a placement to a new normalized position, staying in-bounds. */
export function movePlacement(p: Placement, nx: number, ny: number): Placement {
  return { ...p, ...clampBox({ nx, ny, nw: p.nw, nh: p.nh }) };
}

/** Resize a placement, staying in-bounds. */
export function resizePlacement(p: Placement, nw: number, nh: number): Placement {
  return { ...p, ...clampBox({ nx: p.nx, ny: p.ny, nw, nh }) };
}

/** The visible page box (CropBox) in PDF points, and the page's /Rotate. */
export interface PageBox {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: Rotation;
}

/**
 * A prepared signature field's `/Rect` → the normalized box it occupies on the DISPLAYED page
 * (top-left origin, page rotation applied). The exact inverse of `normalizedBoxToPdfRect`, so the
 * box the preview outlines is the box the stamp is laid into, and the existing appearance maths
 * applies unchanged. The rect is never clamped or moved: the field decides (spec 004, D6).
 */
export function fieldRectToNormBox(
  rect: [number, number, number, number],
  page: PageBox,
): NormBox {
  const { width: W, height: H } = page;
  const x = Math.min(rect[0], rect[2]) - page.x;
  const y = Math.min(rect[1], rect[3]) - page.y;
  const w = Math.abs(rect[2] - rect[0]);
  const h = Math.abs(rect[3] - rect[1]);
  switch (page.rotation) {
    case 90:
      return { nx: y / H, ny: x / W, nw: h / H, nh: w / W };
    case 180:
      return { nx: (W - x - w) / W, ny: y / H, nw: w / W, nh: h / H };
    case 270:
      return { nx: (H - y - h) / H, ny: (W - x - w) / W, nw: h / H, nh: w / W };
    default:
      return { nx: x / W, ny: (H - y - h) / H, nw: w / W, nh: h / H };
  }
}

/**
 * Appearance layout for a stamp drawn into a prepared field: the upright content box is the
 * field's box as the viewer shows it, and the matrix undoes the page rotation. The image is then
 * fitted inside that box with its aspect ratio kept and centred (`containIn`, in
 * `buildAppearance`), so a wide image in a tall field letterboxes; it is never stretched.
 */
export function fieldAppearanceLayout(
  rect: [number, number, number, number],
  page: PageBox,
): AppearanceLayout {
  return appearanceLayout(fieldRectToNormBox(rect, page), {
    widthPt: page.width,
    heightPt: page.height,
    rotation: page.rotation,
  });
}
