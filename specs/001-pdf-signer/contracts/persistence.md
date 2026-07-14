# Contract: Persistence (opt-in certificate + signature image)

`src/features/persistence/`. The ONLY module allowed to touch on-device storage, and only for the
opt-in "remember certificate" and "remember signature" conveniences (Principle VI, research R7).
Backed by `idb-keyval` (IndexedDB).

## Interface

```ts
saveCertificate(p12Bytes: Uint8Array, label: string): Promise<void>   // only on explicit opt-in
loadCertificate(): Promise<{ p12Bytes: Uint8Array; label: string } | null>
clearCertificate(): Promise<void>                                     // user-invokable
hasRememberedCertificate(): Promise<boolean>

saveSignature(bytes: Uint8Array, format: 'png' | 'jpeg'): Promise<void>   // only on explicit opt-in
loadSignature(): Promise<{ bytes: Uint8Array; format: 'png' | 'jpeg' } | null>
clearSignature(): Promise<void>                                          // user-invokable
hasRememberedSignature(): Promise<boolean>
```

## Hard invariants (blocked in review — constitution Data-minimization gate)

1. **Certificate: only `p12Bytes` may be written.** The stored value is the password-protected
   container and nothing else.
2. **Never persist the password** (`Certificate.password`) — not even encrypted (FR-022).
3. **Never persist decrypted key material** (`Certificate.unlocked`).
4. **Signature: only the image bytes + format may be written**, and only on explicit opt-in
   (FR-021). **Never persist documents** in v1 (FR-020/021).
5. **No network.** IndexedDB is local; no sync (Principle I).

## Behavior

- `saveCertificate` / `saveSignature` are called ONLY after an explicit, disclosed user opt-in,
  and are never auto-saved.
- On load, the app pre-fills the certificate but STILL requires the password to be entered before
  any signing (FR-015/022). A remembered signature is offered via an explicit "Use saved
  signature" action, not placed automatically.
- `clearCertificate` / `clearSignature` fully remove the entry; the UI exposes both controls.
- Storage-unavailable (private mode / denied / quota): degrade to memory-only silently; the app
  remains fully functional (edge case).
