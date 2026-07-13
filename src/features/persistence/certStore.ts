import { get, set, del } from 'idb-keyval';

/**
 * Opt-in certificate persistence (contracts/persistence.md, Principle VI).
 * Stores ONLY the password-protected .p12 bytes — never the password or key.
 */
const KEY = 'pdf-signer:remembered-certificate';

interface StoredCert {
  p12Bytes: Uint8Array;
  label: string;
  savedAt: number;
}

export async function saveCertificate(p12Bytes: Uint8Array, label: string): Promise<void> {
  const record: StoredCert = { p12Bytes, label, savedAt: Date.now() };
  await set(KEY, record);
}

export async function loadCertificate(): Promise<{ p12Bytes: Uint8Array; label: string } | null> {
  const v = (await get(KEY)) as StoredCert | undefined;
  return v ? { p12Bytes: v.p12Bytes, label: v.label } : null;
}

export async function clearCertificate(): Promise<void> {
  await del(KEY);
}

export async function hasRememberedCertificate(): Promise<boolean> {
  return (await get(KEY)) != null;
}
