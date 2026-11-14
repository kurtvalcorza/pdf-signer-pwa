import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadBytes } from '../../src/features/signing/export';

// dist/ is shared by every distribution, and the Android shell intercepts blob: downloads only
// through HTMLAnchorElement.prototype.click() (specs/003-android-packaging/contracts/shell-bridge.md).
// A dispatched MouseEvent would bypass it and the save would silently do nothing there, so the
// shared export path must keep calling click() on a download anchor.
describe('shared download path', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('downloads through anchor.click(), never a dispatched event', () => {
    vi.useFakeTimers();
    const anchor = {
      href: '',
      download: '',
      rel: '',
      click: vi.fn(),
      dispatchEvent: vi.fn(),
    };
    vi.stubGlobal('document', { createElement: vi.fn(() => anchor) });
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');

    downloadBytes(new Uint8Array([1, 2, 3]), 'out.pdf', 'application/pdf');

    expect(anchor.click).toHaveBeenCalledTimes(1);
    expect(anchor.dispatchEvent).not.toHaveBeenCalled();
    expect(anchor.href).toBe('blob:test');
    expect(anchor.download).toBe('out.pdf');
    vi.runAllTimers();
    expect(revoke).toHaveBeenCalledWith('blob:test');
  });
});
