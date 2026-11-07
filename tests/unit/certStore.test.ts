import { describe, it, expect, beforeEach, vi } from 'vitest';

// In-memory stand-in for idb-keyval (no real IndexedDB in the Node test env).
const store = new Map<string, unknown>();
const fail = { get: false, set: false, del: false, delSilently: false };

vi.mock('idb-keyval', () => ({
  get: async (k: string) => {
    if (fail.get) throw new Error('storage unavailable');
    return store.get(k);
  },
  set: async (k: string, v: unknown) => {
    if (fail.set) throw new Error('quota');
    store.set(k, v);
  },
  del: async (k: string) => {
    if (fail.del) throw new Error('storage unavailable');
    if (!fail.delSilently) store.delete(k);
  },
}));

import {
  saveCertificate,
  loadCertificate,
  clearCertificate,
  hasRememberedCertificate,
} from '../../src/features/persistence/certStore';

const A = Uint8Array.from([1, 2, 3]);
const B = Uint8Array.from([4, 5, 6]);

describe('certStore (SEC-04)', () => {
  beforeEach(() => {
    store.clear();
    Object.assign(fail, { get: false, set: false, del: false, delSilently: false });
    vi.stubGlobal('window', {});
  });

  it('reports a successful save and keeps only the .p12 and its label', async () => {
    expect(await saveCertificate(A, 'a.p12')).toBe(true);
    expect(await loadCertificate()).toEqual({ p12Bytes: A, label: 'a.p12' });
  });

  it('reports a failed save and leaves the earlier record in place', async () => {
    await saveCertificate(A, 'a.p12');
    fail.set = true;
    expect(await saveCertificate(B, 'b.p12')).toBe(false);
    expect((await loadCertificate())?.label).toBe('a.p12');
  });

  it('confirms removal', async () => {
    await saveCertificate(A, 'a.p12');
    expect(await clearCertificate()).toBe(true);
    expect(await hasRememberedCertificate()).toBe(false);
  });

  it('reports failure when the delete throws', async () => {
    await saveCertificate(A, 'a.p12');
    fail.del = true;
    expect(await clearCertificate()).toBe(false);
  });

  it('reports failure when the delete resolves but the record is still there', async () => {
    await saveCertificate(A, 'a.p12');
    fail.delSilently = true;
    expect(await clearCertificate()).toBe(false);
  });

  it('writes nothing on desktop read-only media (FR-011b)', async () => {
    vi.stubGlobal('window', { desktopShell: { persistenceEnabled: false, mode: 'ephemeral' } });
    expect(await saveCertificate(A, 'a.p12')).toBe(false);
    expect(store.size).toBe(0);
  });
});
