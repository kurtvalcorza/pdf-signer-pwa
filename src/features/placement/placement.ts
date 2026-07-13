import { clampBox } from '../../lib/coords';

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
