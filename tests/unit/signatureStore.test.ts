import { describe, it, expect, beforeEach, vi } from 'vitest';

// In-memory stand-in for idb-keyval (no real IndexedDB in the Node test env).
const store = new Map<string, unknown>();
let failing = false;

vi.mock('idb-keyval', () => ({
  get: async (k: string) => {
    if (failing) throw new Error('storage unavailable');
    return store.get(k);
  },
  set: async (k: string, v: unknown) => {
    if (failing) throw new Error('storage unavailable');
    store.set(k, v);
  },
  del: async (k: string) => {
    if (failing) throw new Error('storage unavailable');
    store.delete(k);
  },
}));

import {
  saveSignature,
  loadSignature,
  clearSignature,
  hasRememberedSignature,
} from '../../src/features/persistence/signatureStore';

const BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

describe('signatureStore (opt-in signature-image persistence)', () => {
  beforeEach(() => {
    store.clear();
    failing = false;
  });

  it('round-trips the image bytes and format', async () => {
    expect(await hasRememberedSignature()).toBe(false);
    await saveSignature(BYTES, 'png');
    expect(await hasRememberedSignature()).toBe(true);
    const loaded = await loadSignature();
    expect(loaded?.format).toBe('png');
    expect(Array.from(loaded!.bytes)).toEqual(Array.from(BYTES));
  });

  it('stores only bytes + format + savedAt — never a password or document', async () => {
    await saveSignature(BYTES, 'jpeg');
    const raw = store.get('pdf-signer:remembered-signature') as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual(['bytes', 'format', 'savedAt']);
  });

  it('clears the remembered signature', async () => {
    await saveSignature(BYTES, 'png');
    await clearSignature();
    expect(await hasRememberedSignature()).toBe(false);
    expect(await loadSignature()).toBeNull();
  });

  it('degrades to memory-only silently when storage is unavailable', async () => {
    failing = true;
    await expect(saveSignature(BYTES, 'png')).resolves.toBeUndefined();
    await expect(loadSignature()).resolves.toBeNull();
    await expect(hasRememberedSignature()).resolves.toBe(false);
    await expect(clearSignature()).resolves.toBeUndefined();
  });
});
