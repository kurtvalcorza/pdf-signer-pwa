import { useRef, type PointerEvent as ReactPointerEvent } from 'react';
import type { Placement } from '../features/placement/placement';
import { movePlacement, resizePlacement } from '../features/placement/placement';

interface Props {
  placement: Placement;
  imageUrl: string;
  /** Rendered page size in CSS pixels (the canvas box the overlay sits on). */
  pageW: number;
  pageH: number;
  selected: boolean;
  onChange: (p: Placement) => void;
  onSelect: () => void;
  onRemove: () => void;
}

/**
 * Draggable + resizable signature image over the rendered page (FR-006/007).
 * Position/size are stored normalized; here we project to CSS pixels.
 */
export function SignatureOverlay({
  placement,
  imageUrl,
  pageW,
  pageH,
  selected,
  onChange,
  onSelect,
  onRemove,
}: Props) {
  const drag = useRef<{ startX: number; startY: number; nx: number; ny: number } | null>(null);
  const resize = useRef<{ startX: number; startY: number; nw: number; nh: number } | null>(null);

  const left = placement.nx * pageW;
  const top = placement.ny * pageH;
  const width = placement.nw * pageW;
  const height = placement.nh * pageH;

  function onDragDown(e: ReactPointerEvent) {
    e.preventDefault();
    onSelect();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startY: e.clientY, nx: placement.nx, ny: placement.ny };
  }
  function onDragMove(e: ReactPointerEvent) {
    if (!drag.current) return;
    const dnx = (e.clientX - drag.current.startX) / pageW;
    const dny = (e.clientY - drag.current.startY) / pageH;
    onChange(movePlacement(placement, drag.current.nx + dnx, drag.current.ny + dny));
  }
  function endDrag() {
    drag.current = null;
  }

  function onResizeDown(e: ReactPointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    resize.current = { startX: e.clientX, startY: e.clientY, nw: placement.nw, nh: placement.nh };
  }
  function onResizeMove(e: ReactPointerEvent) {
    if (!resize.current) return;
    const dnw = (e.clientX - resize.current.startX) / pageW;
    const dnh = (e.clientY - resize.current.startY) / pageH;
    onChange(
      resizePlacement(
        placement,
        Math.max(0.05, resize.current.nw + dnw),
        Math.max(0.03, resize.current.nh + dnh),
      ),
    );
  }
  function endResize() {
    resize.current = null;
  }

  return (
    <div
      className={`absolute touch-none select-none ${selected ? 'ring-2 ring-blue-400' : 'ring-1 ring-white/40'}`}
      style={{ left, top, width, height }}
      onPointerDown={onDragDown}
      onPointerMove={onDragMove}
      onPointerUp={endDrag}
    >
      <img src={imageUrl} alt="signature" className="pointer-events-none h-full w-full object-contain" />

      {selected && (
        <>
          <button
            type="button"
            aria-label="Remove signature"
            onPointerDown={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            className="absolute -left-3 -top-3 h-6 w-6 rounded-full bg-red-500 text-xs text-white"
          >
            ✕
          </button>
          <div
            role="slider"
            aria-label="Resize signature"
            aria-valuenow={Math.round(placement.nw * 100)}
            tabIndex={0}
            onPointerDown={onResizeDown}
            onPointerMove={onResizeMove}
            onPointerUp={endResize}
            className="absolute -bottom-2 -right-2 h-5 w-5 cursor-se-resize rounded-full bg-blue-400"
          />
        </>
      )}
    </div>
  );
}
