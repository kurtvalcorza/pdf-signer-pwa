# Performance benchmark (T050)

Measures the app against the plan's **Performance Goals** and **SC-001**.

Run it yourself:

```bash
npm run perf     # builds, serves the production build, runs tests/e2e-perf
```

## Method

- **Production build** served via `vite preview` (dev-server timings are not representative).
- **Pixel 7** device profile in Playwright.
- **4× CPU throttling** via CDP (`Emulation.setCPUThrottlingRate`) to approximate a
  mid-range Android from a fast dev machine.
- **Large document**: a generated 60-page A4 text PDF (`sample-large.pdf`).
- Drag smoothness is measured by counting `requestAnimationFrame` ticks during a
  60-step pointer drag: if the main thread stalls under the `pointermove` → React
  re-render load, the frame rate collapses.
- Not run in CI — timings on shared runners are too noisy to gate on. This is an
  on-demand measurement; the assertions in the spec are loose guard-rails (catch a
  real stall, not run-to-run jitter).

## Results

Measured 2026-07-16 (Windows dev machine, production build, Pixel 7 profile, 4× CPU throttle):

| Metric | Result | Goal |
|---|---|---|
| Large PDF (60 pp) open + first render | **301 ms** | responsive |
| Placement drag | **60.4 fps** | 60 fps |
| Sign + download (60 pp) | **421 ms** | ~2 s |
| Full flow: open → place → sign → download | **977 ms** | **SC-001: < 60 s** |

**Verdict: all goals met**, with large margins — the full signing flow is ~60× inside
the SC-001 budget, and signing is ~5× inside the 2 s goal.

## Honest caveats

- **60 fps is the display cap, not a ceiling.** The 60.4 fps figure means the drag did
  *not* drop frames or block the main thread — not that it could go faster.
- **4× CPU throttle approximates a mid-range phone; it is not a real device.** GPU,
  memory pressure, and thermal throttling on actual hardware are not modelled. A real
  mid-range Android measurement would be strictly better evidence.
- **Page count is not the hard case.** pdf.js renders one page at a time, so a 60-page
  *text* PDF is cheaper than it sounds. A large **scanned/image-heavy** PDF (tens of MB)
  would stress rendering and memory far more, and is **not** measured here.
- Signing time scales with document size (the whole file is hashed); 421 ms is for a
  66 KB document. A multi-MB file will take proportionally longer.
