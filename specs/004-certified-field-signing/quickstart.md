# Quickstart: validating certified-field signing (004)

Types and reasons: [data-model.md](data-model.md). Gate modes:
[contracts/signature-gate.md](contracts/signature-gate.md).

## Prerequisites

```bash
npm ci
pip install --require-hashes -r scripts/requirements-verify.txt   # pyHanko 0.36.2
```

Baseline to compare against (`a6f4eef`): lint 0, `tsc` 0, 160 unit tests, signature gate passing.

## 1. Fixtures

```bash
python scripts/make_policy_fixtures.py
git status --short tests/signing/fixtures/policy
```

Expected: every existing fixture prints "kept"; `git status` shows additions only (SC-007).

## 2. Unit and signing tests

```bash
npm run lint && npx tsc --noEmit && npx vitest run
```

Expected: exit 0. The count is 160 plus the tests this feature adds; none of the original 160 is
removed except the two `signingBlock` assertions, which are rewritten against the classification.

## 3. Signature gate

```bash
npm run verify:signatures
```

Expected, in the output:

- fill outputs at P=2 and P=3 (and the xref-stream variant): `OK [expect-certification-level]`,
  with `sig[0]` showing `modification=ModificationLevel.FORM_FILLING`;
- the three-signature chain output: OK, three `sig[...]` lines;
- forced add-a-field and tampered fill: `OK [expect-policy-violation]`;
- final line `✓ signature gate passed`, exit 0.

## 4. In the app (web)

```bash
npm run dev
```

1. Open `tests/signing/fixtures/policy/certified-p2-empty-field.pdf`. The certified notice shows;
   there is no way to draw a box; one outlined field is listed and nothing is selected.
2. Pick the field, add a signature image and a certificate, sign, download.
3. `python scripts/validate_pdf.py --expect-certification-level FORM_FILLING <download>` exits 0.
4. Open `certified-p1.pdf`, `certified-p2.pdf` and `certified-p2-later-annotation.pdf`: each is
   refused with its own message; the second suggests asking the sender for a field.
5. Open `certified-p2-two-empty-fields.pdf`, sign `Approver`, reopen the download, sign `Witness`,
   validate: three signatures pass.
6. Open `approval.pdf`: behaviour is unchanged (free placement).

## 5. Per distribution

```bash
npx playwright test tests/e2e/us7-certified-field.spec.ts          # web
npm run e2e:desktop                                                # desktop case included
node scripts/android-gate.mjs <signed.apk> --certified-field       # Android, emulator running
```

Each run validates the file that distribution produced.

## 6. Before the release is published (owner)

Open the P=2 and P=3 fill outputs in Acrobat Reader. The certification and the new signature both
show as valid. Record the Reader version and the result in `docs/audit.md` (SEC-02).

Then, in order (T045, T040, T046):

1. **T045.** Do the Acrobat check above and replace the SEC-02 placeholder in `docs/audit.md`
   (_version and result not yet recorded_) with the Reader version and the result. Merge that.
2. **Pick the commit.** Use the `main` head that includes step 1. `package.json` already says
   `0.3.0`, and the release job refuses a tag that doesn't match it.
3. **Tag it** (`v0.3.0`, pushed: an outward step, owner's yes). This runs `release-desktop.yml`:
   desktop builds, the Windows egress gate, and the `android` job. The `android` job runs
   `android-gate.mjs --certified-field` on the emulator for the first time (T040). If any gate
   fails, `publish` is blocked and no release is made.
4. **Check the release.** Its notes are `docs/desktop.md` followed by `docs/android.md`, so they
   start with *What's new in v0.3.0*. Run `sha256sum -c SHA256SUMS` and the
   `gh attestation verify` command from `docs/desktop.md`, with `--source-digest` set to the
   tagged commit.
5. **Web.** Confirm that Vercel's production deployment is the tagged commit.
6. **Tick the tasks.** Mark T040 (with the run ID), T045 and T046 done in `tasks.md`, and update
   the status line in `spec.md`. The audit's SEC-02 *Pending: Android* clause goes too.
