# QC & metric improvements — 2026-10-19

Additive, non-destructive upgrades aimed at reducing the effect of monitor
recording settings on the computed metrics. **No existing default metric is
changed.** Every item below is either a new diagnostic or a new field reported
*alongside* the current output, so prior validation still holds.

## 1. Pre-filtering detection  (engine: `_prefilter_flag`, in `qc_flags`)
Detects a monitor high-pass that removed slow (delta) power before export.
On the RAW signal, the median 4 s Welch PSD is scanned upward; the reported
`hp_cutoff_hz` is the lowest frequency whose power recovers to half of the
2–8 Hz reference density. `prefiltered = cutoff ≥ 1.5 Hz`. Diagnostic only.
Ref: von Dincklage 2021; Bøgli 2024.

## 2. Sampling-rate / comparability report  (engine: `_fs_report`, in `qc_flags.comparability`)
Reports native fs, Nyquist, the band actually usable (≤ 0.95·Nyquist), a device
guess (BIS ~128 Hz / SedLine ~178 Hz), the common analysis rate (128 Hz), and
whether a resample would be needed to compare recordings across devices.
The composite already resamples to 128 Hz (polyphase, anti-aliased) in
`composite_series`.

## 3. Reference-/gain-robust ratios  (engine: `spectral_features`)
Adds `alpha_delta_ratio` and `slow_fast_ratio = (δ+θ)/(α+β)` next to the band
powers. Relative band power (`*_pct`) was already emitted in both the panel and
the per-30 s trends; these ratios are additional, scale-independent markers.

## 4. Noise-floor + adaptive BSR  (engine: `_noise_floor_uv`, `_adaptive_bsr`, `_attach_adaptive_bsr`)
Estimates a suppression-level noise floor (10th percentile of per-0.5 s RMS of
the filtered signal). BSR is recomputed with an amplitude gate of
`clamp(1.5 × floor, fixed 5 µV, 12 µV)` and reported as `result.bsr_adaptive`
with `noise_floor_uv`, `amplitude_uv`, `bsr_pct`, and a `divergence_pct_points`
/ `diverges` flag versus the fixed-threshold BSR. **The default `result.bsr` is
unchanged.** Ref: Bennett 1948 (quantization noise); Särkelä 2002.

## 5. Explicit recording-gap markers  (intake: `session.js`, `analysis.js`)
Stitching is already timestamp-based (blocks carry session-clock `t_start`;
overlaps dropped). A new `gaps` array lists each gap between kept blocks
(`after_min`, `gap_min`, `to_min`) so the timeline/DSA can mark discontinuities
instead of implying continuous time. Surfaced in the result via `attachMeta`.
Ref: von Dincklage 2021.

## Pyodide safety
Each new sub-flag is wrapped in its own try/except → `None` on failure; all
numpy run indices are cast to plain Python ints; no huge sentinels. A quirk in
the WASM runtime degrades to "no flag", never a crash.

## Verification (2026-10-19)
Run against synthetic multi-block data in a version-matched environment
(numpy 2.0.2 / scipy 1.14.1 / pandas 2.2.3): all new keys present; pre-filter
flags a 2 Hz-high-passed signal (cutoff 1.75 Hz) and leaves a normal one alone
(0.5 Hz); adaptive BSR runs with no error and matches the fixed BSR on clean
data; full result is JSON-serialisable. In-browser check on a real recording
(hard refresh to reload the engine asset) still required for final sign-off.

## UI (follow-up, needs a Razor rebuild)
Home.razor can surface: a "monitor pre-filtering" note, the comparability line,
the adaptive-BSR comparison when it diverges, and gap markers on the DSA/timeline.
Data plumbing is in place; rendering is the remaining step.
