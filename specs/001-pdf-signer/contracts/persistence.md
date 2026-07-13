# Contract: Persistence (opt-in certificate only)

`src/features/persistence/`. The ONLY module allowed to touch on-device storage, and only for the
opt-in "remember certificate" convenience (Principle VI, research R7). Backed by `idb-keyval`
(IndexedDB).

## Interface

```ts
saveCertificate(p12Bytes: Uint8Array, label: string): Promise<void>   // only on explicit opt-in
loadCertificate(): Promise<{ p12Bytes: Uint8Array; label: string } | null>
clearCertificate(): Promise<void>                                     // user-invokable
hasRememberedCertificate(): Promise<boolean>
```

## Hard invariants (blocked in review — constitution Data-minimization gate)

1. **Only `p12Bytes` may be written.** The stored value is the password-protected container and
   nothing else.
2. **Never persist the password** (`Certificate.password`) — not even encrypted (FR-022).
3. **Never persist decrypted key material** (`Certificate.unlocked`).
4. **Never persist documents or signature images** in v1 (FR-020/021).
5. **No network.** IndexedDB is local; no sync (Principle I).

## Behavior

- `saveCertificate` is called ONLY after an explicit, disclosed user opt-in.
- On load, the app pre-fills the certificate but STILL requires the password to be entered before
  any signing (FR-015/022).
- `clearCertificate` fully removes the entry; the UI exposes this control.
- Storage-unavailable (private mode / denied / quota): degrade to memory-only silently; the app
  remains fully functional (edge case).
