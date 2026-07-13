# Contract: Viewer & Placement

`src/features/viewer/` (render) + `src/features/placement/` (interaction). Owns the coordinate
transform between what the user sees and PDF user space.

## Rendering

```ts
renderPage(pdf: Uint8Array, pageIndex: number, cssWidth: number): Promise<{
  canvas: HTMLCanvasElement;
  viewport: { scale: number; rotation: 0|90|180|270; widthPt: number; heightPt: number };
}>
```

- Renders via pdf.js with a locally-bundled worker (no CDN, research R2).
- Reads from the in-memory ArrayBuffer only — no network.

## Coordinate transform (the contract that must hold)

The UI captures pointer positions in CSS pixels; the signing engine needs normalized page
coordinates (research R6).

```ts
screenToNormalized(pt: {x:number;y:number}, viewport): {nx:number; ny:number}   // 0..1
normalizedToPdfPoints(n: {nx;ny;nw;nh}, page: {widthPt;heightPt;rotation}): {x;y;w;h} // PDF pts
```

**Invariants**:
- `normalizedToPdfPoints` MUST account for pdf.js top-left origin vs PDF bottom-left origin and for
  page `rotation`.
- Round-trip stability: a placement captured at one zoom/DPR renders at the same page location at
  any other zoom/DPR (unit-tested).
- Normalized coords are clamped to `[0,1]` and rejected if the resulting box exceeds page bounds
  (FR-008).

## Interaction (gestures)

- Drag (`pointer`/`touch`) to move; pinch or corner handles to resize (FR-006/007).
- Target: 60 fps on a mid-range Android (plan Performance Goals).
- Placement produces a `Placement` (see data-model) with `mode: 'visual' | 'crypto'`.

## UI ordering rule surfaced here

- When any `crypto` placement exists, the UI MUST require `visual` placements to be committed first
  and communicate that later page edits would invalidate signatures (FR-014). The engine also
  enforces this; the viewer just makes it visible.
