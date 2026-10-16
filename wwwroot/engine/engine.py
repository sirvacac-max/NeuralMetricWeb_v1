"""
NeuralMetricWeb_v1 engine, step 4 (corrected to match the desktop engine).
Source: NeuralMetricsCore/engine/nmcore (config.py, qc.py, spectral.py).
Phase 1 runs in Pyodide: numpy and scipy only.
"""
import numpy as np
import math
from scipy.signal import butter, sosfiltfilt, iirnotch, filtfilt

ENGINE_VERSION = "0.2.0-step4"

CFG = {
    # Spectral filter (desktop qc.clean): zero-phase Butterworth band-pass, then notch.
    "bandpass_hz": (0.5, 40.0),
    "bandpass_order": 4,
    "notch_hz": 60.0,          # Mexico. Use 50.0 for 50 Hz mains.
    "notch_q": 30.0,
    # QC windows: 4 s, 50 % overlap.
    "qc_win_s": 4.0,
    "qc_overlap": 0.5,
    "qc_min_sd_uv": 0.5,       # flat gate
    "qc_max_uv": 150.0,        # amplitude gate
    "qc_stuck_s": 1.0,         # stuck gate: identical raw run of at least 1 s
    # Burst-suppression ratio (desktop bsr.py, v3: line length + amplitude).
    "bsr_ll_window_s": 0.2807,    # centred line-length window (v2 value, seconds)
    "bsr_ll_threshold_uv": 40.0,  # line-length threshold
    "bsr_min_episode_s": 1.0,     # minimum suppression episode
    "bsr_amp_uv": 5.0,            # |amplitude| <= 5 uV; None = pure v2 line length
    "presets": {
        "v3_default": ("flat", "saturation", "stuck", "amplitude"),
        "study_replication": ("flat", "amplitude"),
    },
    # Band edges as in the desktop engine.
    "bands": {
        "delta": (0.5, 4.0),   # [0.5, 4)
        "theta": (4.0, 8.0),   # [4, 8)
        "alpha": (8.0, 12.0),  # [8, 12]
        "beta": (12.0, 30.0),  # (12, 30]
        "total": (0.5, 30.0),  # [0.5, 30]
    },
}

CHUNK = 512  # windows per chunk, to bound memory in the browser


def clean(x, fs, cfg=CFG):
    """Zero-phase band-pass, then notch (desktop qc.clean)."""
    x = np.asarray(x, dtype=float)
    lo, hi = cfg["bandpass_hz"]
    nyq = fs / 2.0
    hi = min(hi, 0.95 * nyq)      # clamp high edge below Nyquist for low-fs files
    lo = max(lo, 1e-6)
    if not (0.0 < lo < hi):       # fs too low for any band-pass: de-mean only
        return x - np.mean(x)
    sos = butter(cfg["bandpass_order"], [lo, hi], "band", fs=fs, output="sos")
    y = sosfiltfilt(sos, x)
    if cfg["notch_hz"] and cfg["notch_hz"] < fs / 2:
        b, a = iirnotch(cfg["notch_hz"], cfg["notch_q"], fs)
        y = filtfilt(b, a, y)
    return y


def stuck_mask(x, sat, fs, min_s):
    """Samples inside runs of identical raw values lasting at least min_s seconds,
    excluding saturated samples (desktop qc.stuck_mask)."""
    x = np.asarray(x)
    n = len(x)
    mask = np.zeros(n, dtype=bool)
    if n == 0:
        return mask
    change = np.flatnonzero(np.diff(x) != 0) + 1
    starts = np.concatenate(([0], change))
    ends = np.concatenate((change, [n]))
    min_len = int(np.ceil(min_s * fs))
    for k in np.flatnonzero((ends - starts) >= min_len):
        mask[starts[k]:ends[k]] = True
    return mask & ~sat


def saturation_mask(x, phys_min, phys_max, resolution):
    """Samples within half a resolution step of the file's range limits (desktop loader)."""
    x = np.asarray(x, dtype=float)
    half = resolution / 2
    return (x <= phys_min + half) | (x >= phys_max - half)


def prepare_block(x_raw, sat, fs, cfg=CFG):
    """Filtered signal plus the QC masks computed from the raw signal."""
    x_raw = np.asarray(x_raw, dtype=float)
    sat = np.asarray(sat, dtype=bool)
    return {
        "x": clean(x_raw, fs, cfg),
        "sat": sat,
        "stuck": stuck_mask(x_raw, sat, fs, cfg["qc_stuck_s"]),
    }


def _window_geometry(fs, cfg=CFG):
    nw = int(cfg["qc_win_s"] * fs)
    step = int(nw * (1 - cfg["qc_overlap"]))
    return nw, step


def qc_block(b, fs, active, cfg=CFG):
    """Return (starts, ok) for every window of one prepared block, in chunks."""
    nw, step = _window_geometry(fs, cfg)
    n = len(b["x"])
    starts = np.arange(0, n - nw + 1, step) if n >= nw else np.array([], dtype=int)
    ok = np.ones(len(starts), dtype=bool)
    for c in range(0, len(starts), CHUNK):
        s = starts[c:c + CHUNK]
        idx = s[:, None] + np.arange(nw)[None, :]
        W = b["x"][idx]
        W = W - W.mean(axis=1, keepdims=True)
        fails = {
            "flat": W.std(axis=1) < cfg["qc_min_sd_uv"],
            "saturation": b["sat"][idx].any(axis=1),
            "stuck": b["stuck"][idx].any(axis=1),
            "amplitude": np.abs(W).max(axis=1) > cfg["qc_max_uv"],
        }
        bad = np.zeros(len(s), dtype=bool)
        for g in active:
            bad |= fails[g]
        ok[c:c + CHUNK] = ~bad
    return starts, ok


def welch_valid(blocks, fs, active, cfg=CFG):
    """Summed one-sided PSD (µV²/Hz) over QC-valid windows, pooled across blocks.
    Symmetric Hann taper, as in the desktop engine (np.hanning)."""
    nw, _ = _window_geometry(fs, cfg)
    w = np.hanning(nw)
    scale = fs * (w ** 2).sum()
    psum = np.zeros(nw // 2 + 1)
    n_valid = n_total = 0
    for b in blocks:
        starts, ok = qc_block(b, fs, active, cfg)
        n_total += len(ok)
        n_valid += int(ok.sum())
        keep = starts[ok]
        for c in range(0, len(keep), CHUNK):
            s = keep[c:c + CHUNK]
            W = b["x"][s[:, None] + np.arange(nw)[None, :]]
            W = W - W.mean(axis=1, keepdims=True)
            P = np.abs(np.fft.rfft(W * w, axis=1)) ** 2 / scale
            P[:, 1:-1] *= 2  # one-sided: double all bins except DC and Nyquist
            psum += P.sum(axis=0)
    return np.fft.rfftfreq(nw, 1 / fs), psum, n_valid, n_total


def _band_masks(f, bands):
    d0, d1 = bands["delta"]
    t0, t1 = bands["theta"]
    a0, a1 = bands["alpha"]
    b0, b1 = bands["beta"]
    return {
        "delta": (f >= d0) & (f < d1),
        "theta": (f >= t0) & (f < t1),
        "alpha": (f >= a0) & (f <= a1),
        "beta": (f > b0) & (f <= b1),
    }


def spectral_features(f, P, bands=CFG["bands"]):
    """Absolute band power (µV²), relative power (%), and SEF95 (Hz).
    Matches the desktop spectral_features, with absolute power in µV² instead of dB."""
    df = f[1] - f[0]
    tm = (f >= bands["total"][0]) & (f <= bands["total"][1])
    tot = float(P[tm].sum())
    out = {"total_uv2": tot * df}
    for k, s in _band_masks(f, bands).items():
        p = float(P[tm & s].sum())
        out[f"{k}_uv2"] = p * df
        out[f"{k}_pct"] = 100.0 * p / tot if tot > 0 else float("nan")
    cs = np.cumsum(P[tm])
    i = min(int(np.searchsorted(cs, 0.95 * tot)), int(tm.sum()) - 1)
    out["sef95_hz"] = float(f[tm][i])
    return out


def analyze_blocks(blocks, fs, preset="v3_default", cfg=CFG):
    """Biomarker panel for prepared blocks (see prepare_block)."""
    if preset not in cfg["presets"]:
        raise ValueError(f"unknown preset '{preset}'; options: {list(cfg['presets'])}")
    active = cfg["presets"][preset]
    f, psum, n_valid, n_total = welch_valid(blocks, fs, active, cfg)
    if n_valid == 0:
        raise ValueError("No QC-valid windows: nothing to analyze")
    P = psum / n_valid
    tm = (f >= cfg["bands"]["total"][0]) & (f <= cfg["bands"]["total"][1])
    psd = {"freq_hz": [round(float(v), 4) for v in f[tm]],
           "power_uv2_hz": [round(float(v), 6) for v in P[tm]]}
    return {
        "engine_version": ENGINE_VERSION,
        "preset": preset,
        "n_windows": n_total,
        "n_valid": n_valid,
        "valid_pct": 100.0 * n_valid / n_total,
        "resolution_hz": float(f[1] - f[0]),
        "psd": psd,
        **spectral_features(f, P, cfg["bands"]),
    }


def _dsa_psd_rows(xf, starts, nw, w, scale):
    out = []
    for c in range(0, len(starts), CHUNK):
        sidx = starts[c:c + CHUNK]
        W = xf[sidx[:, None] + np.arange(nw)[None, :]]
        W = W - W.mean(axis=1, keepdims=True)
        P = np.abs(np.fft.rfft(W * w, axis=1)) ** 2 / scale
        P[:, 1:-1] *= 2
        out.append(P)
    return np.vstack(out) if out else np.empty((0, nw // 2 + 1))


def dsa(blocks, fs, preset="v3_default", bin_s=30.0, cfg=CFG):
    """Spectrogram: median PSD (dB re uV2/Hz) of QC-valid 4-s windows per 30-s bin,
    over the preset's Total band. Columns: 'valid', 'rejected' or 'no_data'.
    Ported from desktop spectral.dsa."""
    active = cfg["presets"][preset]
    lo, hi = cfg["bands"]["total"]
    nw, step = _window_geometry(fs, cfg)
    w = np.hanning(nw)
    scale = fs * (w ** 2).sum()
    f = np.fft.rfftfreq(nw, 1 / fs)
    fsel = (f >= lo) & (f <= hi)

    allP, alltc, allta = [], [], []
    for b in blocks:
        p = prepare_block(np.asarray(b["x"], dtype=float), np.asarray(b["sat"], dtype=bool), fs, cfg)
        starts, ok = qc_block(p, fs, active, cfg)
        if len(starts) == 0:
            continue
        tc_all = b["t_start"] + (starts + nw / 2) / fs
        allta.append(tc_all)
        keep = starts[ok]
        if len(keep):
            P = _dsa_psd_rows(p["x"], keep, nw, w, scale)
            allP.append(P[:, fsel])
            alltc.append(tc_all[ok])
    if not alltc:
        raise ValueError("no valid windows for the DSA")

    P = np.vstack(allP)
    tc = np.concatenate(alltc)
    t_all = np.concatenate(allta)
    bins = np.floor(tc / bin_s).astype(int)
    bins_all = np.floor(t_all / bin_s).astype(int)
    n_bins = int(max(bins.max(), bins_all.max())) + 1
    recorded = np.bincount(bins_all, minlength=n_bins) > 0

    columns, status = [], []
    for k in range(n_bins):
        rows = P[bins == k]
        if len(rows):
            columns.append([round(float(v), 2) for v in 10 * np.log10(np.median(rows, axis=0))])
            status.append("valid")
        else:
            columns.append(None)
            status.append("rejected" if recorded[k] else "no_data")

    return {
        "bin_s": bin_s, "units": "dB re uV2/Hz", "n_bins": n_bins,
        "time_min": [round((k + 0.5) * bin_s / 60, 3) for k in range(n_bins)],
        "freq_hz": [round(float(v), 4) for v in f[fsel]],
        "power_db": columns, "column_status": status,
    }


def spectral_trends(blocks, fs, preset="v3_default", bin_s=30.0, cfg=CFG):
    """Per-30-s trends over the whole recording: DSA columns and band powers
    (absolute uV2 and relative %) per time bin. Band-power trend = desktop trends.bands."""
    active = cfg["presets"][preset]
    lo, hi = cfg["bands"]["total"]
    nw, step = _window_geometry(fs, cfg)
    w = np.hanning(nw)
    scale = fs * (w ** 2).sum()
    f = np.fft.rfftfreq(nw, 1 / fs)
    df = f[1] - f[0]
    total_mask = (f >= lo) & (f <= hi)
    bmask = {
        "Delta": (f >= 0.5) & (f < 4),
        "Theta": (f >= 4) & (f < 8),
        "Alpha": (f >= 8) & (f <= 12),
        "Beta": (f > 12) & (f <= 30),
    }
    core = ["Delta", "Theta", "Alpha", "Beta"]

    allP, alltc, allta = [], [], []
    for b in blocks:
        p = prepare_block(np.asarray(b["x"], dtype=float), np.asarray(b["sat"], dtype=bool), fs, cfg)
        starts, ok = qc_block(p, fs, active, cfg)
        if len(starts) == 0:
            continue
        tc_all = b["t_start"] + (starts + nw / 2) / fs
        allta.append(tc_all)
        keep = starts[ok]
        if len(keep):
            allP.append(_dsa_psd_rows(p["x"], keep, nw, w, scale))
            alltc.append(tc_all[ok])
    if not alltc:
        raise ValueError("no valid windows for trends")

    P = np.vstack(allP)
    tc = np.concatenate(alltc)
    t_all = np.concatenate(allta)
    bins = np.floor(tc / bin_s).astype(int)
    bins_all = np.floor(t_all / bin_s).astype(int)
    n_bins = int(max(bins.max(), bins_all.max())) + 1
    recorded = np.bincount(bins_all, minlength=n_bins) > 0

    dsa_cols, status, sef95 = [], [], []
    ftot = f[total_mask]
    absu = {b: [] for b in core}
    rel = {b: [] for b in core}
    totu = []
    for k in range(n_bins):
        rows = P[bins == k]
        if len(rows):
            pm = np.median(rows, axis=0)
            dsa_cols.append([round(float(v), 2) for v in 10 * np.log10(pm[total_mask])])
            status.append("valid")
            tot = float(pm[total_mask].sum() * df)
            totu.append(round(tot, 4))
            pt = pm[total_mask]
            cs = np.cumsum(pt)
            ei = min(int(np.searchsorted(cs, 0.95 * cs[-1])), len(pt) - 1) if cs[-1] > 0 else 0
            sef95.append(round(float(ftot[ei]), 2))
            for b in core:
                bp = float(pm[bmask[b]].sum() * df)
                absu[b].append(round(bp, 4))
                rel[b].append(round(100 * bp / tot, 2) if tot > 0 else None)
        else:
            dsa_cols.append(None)
            status.append("rejected" if recorded[k] else "no_data")
            totu.append(None)
            sef95.append(None)
            for b in core:
                absu[b].append(None)
                rel[b].append(None)

    time_min = [round((k + 0.5) * bin_s / 60, 3) for k in range(n_bins)]
    return {
        "dsa": {"bin_s": bin_s, "units": "dB re uV2/Hz", "n_bins": n_bins, "time_min": time_min,
                "freq_hz": [round(float(v), 4) for v in f[total_mask]],
                "power_db": dsa_cols, "column_status": status, "sef95_hz": sef95},
        "bands": {"bin_s": bin_s, "time_min": time_min, "bands": core,
                  "abs_uv2": absu, "relative_pct": rel, "total_uv2": totu, "column_status": status},
    }


def _sweep_step_flag(dsa):
    # Point 1: flag an abrupt, sustained ~2x step in SEF95 across the DSA,
    # i.e. a likely mid-recording sweep-speed change (frequency axis unreliable).
    if not dsa:
        return None
    t = dsa.get("time_min") or []
    s = dsa.get("sef95_hz") or []
    pts = [(float(a), float(b)) for a, b in zip(t, s) if b is not None and b > 1.0]
    if len(pts) < 12:
        return None
    tm = np.array([p[0] for p in pts])
    sef = np.array([p[1] for p in pts])
    sm = sef.copy()
    for i in range(1, sef.size - 1):
        sm[i] = np.median(sef[i - 1:i + 2])
    half = 6
    best = None
    for i in range(half, sm.size - half):
        before = float(np.median(sm[i - half:i]))
        after = float(np.median(sm[i:i + half]))
        if before <= 0:
            continue
        ratio = after / before
        if (1.7 <= ratio <= 2.3) or (0.43 <= ratio <= 0.59):
            score = min(abs(ratio - 2.0), abs(ratio - 0.5))
            if best is None or score < best[0]:
                best = (score, float(tm[i]), ratio, before, after)
    if best is None:
        return None
    _, at, ratio, before, after = best
    return {"at_min": round(at, 1), "ratio": round(ratio, 2),
            "from_hz": round(before, 1), "to_hz": round(after, 1)}


def _clip_epoch_flag(blocks, fs, thresh_pct=25.0):
    # Point 2: per-1-min clipped-sample percentage and how many epochs exceed the threshold.
    mins, sats = [], []
    for b in blocks:
        x = np.asarray(b["x"], dtype=float)
        sat = np.asarray(b["sat"], dtype=float)
        n = x.size
        if n == 0:
            continue
        t = b["t_start"] + np.arange(n) / fs
        mins.append((t / 60.0).astype(int))
        sats.append(sat)
    if not mins:
        return None
    mn = np.concatenate(mins)
    sat = np.concatenate(sats)
    nbins = int(mn.max()) + 1
    tot = np.bincount(mn, minlength=nbins).astype(float)
    clp = np.bincount(mn, weights=sat, minlength=nbins)
    valid = tot > 0
    pct = np.zeros(nbins)
    pct[valid] = 100.0 * clp[valid] / tot[valid]
    over = int(np.sum(pct[valid] > thresh_pct))
    return {"max_epoch_pct": round(float(pct[valid].max()) if valid.any() else 0.0, 1),
            "epochs_over_pct": over, "n_epochs": int(valid.sum()),
            "thresh_pct": thresh_pct, "high": bool(over > 0)}


def _quant_flag(blocks, fs, step_coarse_uv=2.0):
    # Point 3: coarse amplitude quantization -> inflated high-frequency/beta power.
    parts = [np.asarray(b["x"], dtype=float) for b in blocks if len(b["x"])]
    if not parts:
        return None
    xs = np.concatenate(parts)
    if xs.size > 600000:
        xs = xs[:600000]
    if xs.size < int(fs * 4):
        return None
    u = np.unique(np.round(xs, 3))
    d = np.diff(u)
    d = d[d > 1e-6]
    step = float(np.median(d)) if d.size else 0.0
    nw = int(fs * 4)
    k = xs.size // nw if nw else 0
    if k:
        W = xs[:k * nw].reshape(k, nw)
        states = np.array([np.unique(np.round(W[j], 3)).size for j in range(k)])
        med_states = int(np.median(states))
    else:
        med_states = int(u.size)
    zeroline = float(100.0 * np.mean(np.abs(xs) < max(step, 1e-6) / 2))
    return {"step_uv": round(step, 3), "distinct_states": med_states,
            "zeroline_pct": round(zeroline, 2), "coarse": bool(step >= step_coarse_uv)}


def qc_flags(blocks, fs, resolution_uv, dsa=None):
    # SedLine display-export QC screens (detect-and-flag only; no data is altered).
    out = {"sweep_step": None, "clip": None, "quant": None}
    try:
        out["sweep_step"] = _sweep_step_flag(dsa)
    except Exception:
        out["sweep_step"] = None
    try:
        out["clip"] = _clip_epoch_flag(blocks, fs)
    except Exception:
        out["clip"] = None
    try:
        out["quant"] = _quant_flag(blocks, fs)
    except Exception:
        out["quant"] = None
    return out

def self_test(fs=256.0, seconds=120.0):
    """Synthetic check: 10 µV sine at 10 Hz plus white noise.
    Expected: alpha_pct close to 100 and sef95_hz close to 10 Hz."""
    t = np.arange(int(fs * seconds)) / fs
    rng = np.random.default_rng(0)
    x = 10.0 * np.sin(2 * np.pi * 10.0 * t) + rng.normal(0.0, 1.0, t.size)
    sat = np.zeros(t.size, dtype=bool)
    r = analyze_blocks([prepare_block(x, sat, fs)], fs)
    return {k: (round(v, 3) if isinstance(v, float) else v) for k, v in r.items()}

def _json_safe(d):
    """Replace NaN/inf with None so the result is valid JSON."""
    return {k: (None if isinstance(v, float) and not math.isfinite(v) else v)
            for k, v in d.items()}


def run_analysis(x, fs, resolution_uv, phys_min, phys_max, preset="v3_default"):
    """One channel in physical units (µV) -> biomarker panel as a JSON-safe dict."""
    x = np.asarray(x, dtype=float)
    sat = saturation_mask(x, phys_min, phys_max, resolution_uv)
    block = prepare_block(x, sat, fs)
    result = analyze_blocks([block], fs, preset)
    result.update({
        "fs": float(fs),
        "channel_resolution_uv": float(resolution_uv),
        "duration_min": round(len(x) / fs / 60, 2),
    })
    return _json_safe(result)

def slice_prepared(blocks, fs, window_min):
    """Parts of each prepared block inside [start, end) minutes from session start
    (desktop spectral.slice_blocks)."""
    a, z = window_min[0] * 60, window_min[1] * 60
    out = []
    for b in blocks:
        t = b["t_start"] + np.arange(len(b["x"])) / fs
        m = (t >= a) & (t < z)
        if m.any():
            out.append({"t_start": float(t[m][0]), "x": b["x"][m],
                        "sat": b["sat"][m], "stuck": b["stuck"][m]})
    return out


COMP_WARMUP_S = 63.0     # config comp_warmup_s: the composite has no values in the first 63 s of a block
COMP_MIN_BLOCK_S = 90.0  # config comp_min_block_s: shorter blocks are skipped


def clip_manual_window(window_min, blocks, fs):
    """A manual window clipped to the span where the pEEG composite has values
    (desktop maintenance.analyze_session), rounded to 0.1 min."""
    starts, ends = [], []
    for b in blocks:
        n = len(b["x"])
        if n / fs < COMP_MIN_BLOCK_S:
            continue
        starts.append(b["t_start"] + COMP_WARMUP_S)
        ends.append(b["t_start"] + n / fs)
    if not starts:
        raise ValueError("no block is long enough for the composite")
    lo = round(max(window_min[0], min(starts) / 60), 1)
    hi = round(min(window_min[1], max(ends) / 60), 1)
    return [lo, hi]


def run_session(blocks, fs, preset="v3_default", window_min=None, cfg=CFG):
    """Stitched and trimmed blocks from the browser intake -> biomarker panel.
    Filtering runs on each full block before slicing, as in the desktop engine."""
    requested = list(window_min) if window_min is not None else None
    if window_min is not None:
        window_min = clip_manual_window(window_min, blocks, fs)

    prepared = []
    for b in blocks:
        p = prepare_block(np.asarray(b["x"], dtype=float),
                          np.asarray(b["sat"], dtype=bool), fs, cfg)
        p["t_start"] = float(b["t_start"])
        prepared.append(p)

    if window_min is not None:
        prepared = slice_prepared(prepared, fs, window_min)
        if not prepared:
            raise ValueError(f"no signal inside the window {window_min} min")

    n_samples = sum(len(b["x"]) for b in prepared)
    clipped = sum(int(np.sum(b["sat"])) for b in prepared)
    result = analyze_blocks(prepared, fs, preset, cfg)
    result.update({
        "fs": float(fs),
        "manual_window_min": requested,
        "window_min": window_min,
        "analysed_min": round(n_samples / fs / 60, 2),
        "clipped_pct_window": round(100.0 * clipped / n_samples, 2),
        "n_blocks": len(prepared),
    })
    return _json_safe(result)

# ---- Step 10 (web): pEEG composite, maintenance detection and refinement, completeness ----
# Port of composite.py (Connor 2022 method), maintenance.py (detect_maintenance,
# refine_window, completeness) with the same settings as config.py.

import warnings
from fractions import Fraction

import numpy as np
import pandas as pd
from numpy.lib.stride_tricks import sliding_window_view
from scipy.signal import butter, detrend, lfilter, resample_poly
from scipy.stats import trim_mean

MAINT_CFG = {
    "comp_fs": 128, "comp_stride_s": 0.5, "comp_epoch_s": 2.0, "comp_supp_uv": 5.0,
    "comp_bsr_window_s": 63.0, "comp_history_s": 30.0, "comp_highpass_hz": 0.65,
    "comp_min_block_s": 90.0, "comp_warmup_s": 63.0, "comp_trend_bin_s": 10.0,
    "comp_mixer": {
        "sed_scurve": [104.4, 49.4, -13.9, 5.29],
        "gen_linear": [[-60.89, -30.0], [-40.0, 43.1]],
        "gen_scurve": [61.3, 72.6, -24.0, 3.55],
        "gen_weight": [[0.0, 5.0], [0.5, 1.0]],
        "bsr_score": [[0.0, 100.0], [50.0, 0.0]],
        "bsr_weight": [[10.0, 50.0], [0.0, 1.0]],
        "compress": [[-40.0, 10.0, 97.0, 110.0], [0.0, 10.0, 97.0, 100.0]],
    },
    "maint_low": 65, "maint_high": 75, "maint_sustain_min": 3, "maint_induction_skip_min": 7,
    "maint_emergence_margin_min": 2, "maint_smooth_s": 60,
    "refine_tol": 10, "refine_smooth_min": 5, "refine_core_frac": 0.5,
    "refine_floor": {"study_replication": None, "v3_default": 60},
    "min_maint_min": 20, "max_gap_in_maint_s": 60,
    "require_emergence": True, "require_induction": True,
    "allow_emergence_at_end": True, "maint_emergence_end_level": 60,
}

STRIDE_S = 0.5


def _num(v, digits=4):
    return round(float(v), digits) if v is not None and np.isfinite(v) else None


def _piecewise(x, xp, yp):
    return np.interp(np.clip(x, xp[0], xp[-1]), xp, yp)


def _scurve(x, e0, emax, x50, width):
    return e0 - emax / (1 + np.exp((x - x50) / width))


def mix(c_sed, c_gen, c_w, bsr, M):
    sed = _scurve(c_sed, *M["sed_scurve"])
    gen = _piecewise(c_gen, *M["gen_linear"]) + _scurve(c_gen, *M["gen_scurve"]) * (c_gen >= -30)
    w_gen = _piecewise(c_w, *M["gen_weight"]) * (gen < sed)
    w_bsr = _piecewise(bsr, *M["bsr_weight"])
    x = sed * (1 - w_gen) + gen * w_gen
    y = _piecewise(x, *M["compress"]) * (1 - w_bsr) + _piecewise(bsr, *M["bsr_score"]) * w_bsr
    return np.where(w_bsr >= 1, _piecewise(bsr, *M["bsr_score"]), y)


def _suppression_flags(x, ns, uv):
    n_str = len(x) // ns
    chunks = x[: n_str * ns].reshape(n_str, ns)
    S = np.concatenate([chunks[:-1], chunks[1:]], axis=1)   # == sliding_window_view(x, 2*ns)[::ns]
    A = np.column_stack([np.ones(2 * ns), np.arange(2 * ns)])
    H = A @ np.linalg.solve(A.T @ A, A.T)
    resid = S - S @ H.T
    flags = np.zeros(len(S) + 1, dtype=bool)
    flags[1:] = np.abs(resid).max(axis=1) <= uv
    return flags


def _sawtooth_hits(x, ns):
    saw = np.concatenate([np.zeros(ns - 5), np.arange(1, 6)]).astype(float)
    saw = (saw - saw.mean()) / saw.std()
    saw_r = saw[::-1].copy()
    n_out = len(x) - ns + 1
    out = np.zeros(n_out, dtype=bool)
    step = 200_000                                          # view <= 200000*ns*8 bytes
    for a in range(0, n_out, step):
        b = min(a + step, n_out)
        W = sliding_window_view(x[a: b + ns - 1], ns)
        var = W.var(axis=1)
        r_up = (W @ saw / ns) ** 2
        r_down = (W @ saw_r / ns) ** 2
        with np.errstate(divide="ignore", invalid="ignore"):
            score = np.maximum(r_up, r_down) / var
        out[a:b] = (var > 10) & (score > 0.63)
    return out


def composite_block(x, fs, cfg):
    ns = int(cfg["comp_stride_s"] * fs)
    ne = int(cfg["comp_epoch_s"] * fs)
    k_ep = ne // ns
    n_str = len(x) // ns
    x = x[: n_str * ns]

    flags = _suppression_flags(x, ns, cfg["comp_supp_uv"])
    nb = int(cfg["comp_bsr_window_s"] / cfg["comp_stride_s"])
    c = np.cumsum(flags, dtype=float)
    lo = np.maximum(np.arange(n_str) - nb + 1, 0)
    bsr = 100 * (c - np.concatenate([[0.0], c])[lo]) / (np.arange(n_str) - lo + 1)

    b, a = butter(2, cfg["comp_highpass_hz"], "high", fs=fs)
    xh = lfilter(b, a, x)
    hits = _sawtooth_hits(x, ns)
    f = np.arange(ne // 2) * fs / ne
    sawfilter = _piecewise(f, [0, 3, 6], [0, 0.25, 1]) ** 2
    w = np.blackman(ne)
    scale = fs * (w ** 2).sum()

    P = np.full((n_str, ne // 2), np.nan)
    saw_flag = np.zeros(n_str, dtype=bool)
    for k in range(k_ep, n_str):
        if flags[k - k_ep + 1: k + 1].any():
            continue
        s0 = (k - k_ep + 1) * ns
        seg = detrend(xh[s0: s0 + ne])
        P[k] = 2 * np.abs(np.fft.rfft(seg * w)[: ne // 2]) ** 2 / scale
        if hits[s0: s0 + ne - ns].any():
            P[k] *= sawfilter
            saw_flag[k] = True

    def band(lo_hz, hi_hz):
        return (f >= lo_hz) & (f <= hi_hz)

    vh_a, vh_b = band(39.5, 46.5), band(40, 47)
    wh_a, wh_b = band(0.5, 46.5), band(1, 47)
    mid, high, low = band(11, 20), band(30, 47), band(0.5, 4)
    nh = int(cfg["comp_history_s"] / cfg["comp_stride_s"])

    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        conc = 10 * np.log10(np.sqrt(np.mean(P[:, vh_a] * P[:, vh_b], axis=1))
                             / np.sqrt(np.mean(P[:, wh_a] * P[:, wh_b], axis=1)))
        logP = 10 * np.log10(P)

    comps = np.full((n_str, 3), np.nan)
    for k in range(k_ep, n_str):
        rows = slice(max(0, k - nh + 1), k + 1)
        ok = ~np.isnan(P[rows, 0])
        if not ok.any():
            continue
        L = logP[rows][ok]
        mid_bins = L[:, mid].mean(axis=0)
        mid_pow = mid_bins[mid_bins >= np.percentile(mid_bins, 50)].mean()
        comps[k, 0] = L[:, high].mean() - mid_pow
        comps[k, 1] = trim_mean(conc[rows][ok], 0.25)
        comps[k, 2] = L[:, low].mean() - mid_pow

    M = cfg["comp_mixer"]
    return {"t_end_s": (np.arange(n_str) + 1) * cfg["comp_stride_s"],
            "composite": mix(comps[:, 0], comps[:, 1], comps[:, 2], bsr, M),
            "composite_no_bsr": mix(comps[:, 0], comps[:, 1], comps[:, 2], np.zeros(n_str), M),
            "bsr": bsr, "psd_valid": ~np.isnan(P[:, 0]), "sawtooth": saw_flag}


def composite_series(sess, cfg=MAINT_CFG):
    """Per-stride composite over all blocks (resampled to 128 Hz), on the session clock.
    Blocks shorter than 90 s are skipped; the first 63 s of each block are discarded."""
    fs_t = cfg["comp_fs"]
    frac = Fraction(fs_t / sess["fs"]).limit_denominator(1000)
    parts, skipped = [], []
    for b in sess["blocks"]:
        x = resample_poly(np.asarray(b["x"], dtype=float), frac.numerator, frac.denominator)
        if len(x) < cfg["comp_min_block_s"] * fs_t:
            skipped.append(round(b["t_start"] / 60, 2))
            continue
        r = composite_block(x, fs_t, cfg)
        keep = r["t_end_s"] >= cfg["comp_warmup_s"]
        parts.append({"t": b["t_start"] + r["t_end_s"][keep],
                      "comp": r["composite"][keep], "nobsr": r["composite_no_bsr"][keep],
                      "bsr": r["bsr"][keep], "valid": r["psd_valid"][keep],
                      "saw": r["sawtooth"][keep]})
    if not parts:
        raise ValueError("no block long enough for the composite (>= 90 s)")
    cat = {k: np.concatenate([p[k] for p in parts]) for k in parts[0]}
    cat["skipped"] = skipped
    return cat


def _sustained(mask, n):
    return pd.Series(mask).rolling(n).min().shift(-(n - 1)).fillna(0).astype(bool).values


def detect_maintenance(t_min, comp, cfg=MAINT_CFG):
    b = pd.Series(comp).rolling(int(cfg["maint_smooth_s"] / STRIDE_S),
                                center=True, min_periods=1).median().values
    n = int(cfg["maint_sustain_min"] * 60 / STRIDE_S)
    below = _sustained(b < cfg["maint_low"], n)
    above = _sustained(b > cfg["maint_high"], n)
    if not below.any():
        return None
    i_start = int(np.argmax(below))
    i_last = len(below) - 1 - int(np.argmax(below[::-1]))
    after = np.flatnonzero(above[i_last:])
    emerged = after.size > 0
    at_end = False
    if emerged:
        i_end = i_last + after[0]
    else:
        i_end = len(t_min) - 1
        if cfg.get("allow_emergence_at_end"):
            rise = _sustained(b > cfg["maint_emergence_end_level"], n)
            candidates = np.flatnonzero(rise[i_last + n:])
            if candidates.size:
                at_end = True
                i_end = i_last + n + int(candidates[0])
    return {"start": round(float(t_min[i_start]) + cfg["maint_induction_skip_min"], 1),
            "end": round(float(t_min[i_end]) - cfg["maint_emergence_margin_min"], 1),
            "transition_min": round(float(t_min[i_start]), 1),
            "emergence_onset_min": round(float(t_min[i_end]), 1) if (emerged or at_end) else None,
            "awake_before_found": bool((b[:i_start] > cfg["maint_high"]).any()),
            "emergence_found": bool(emerged or at_end),
            "emergence_at_recording_end": at_end}


def refine_window(t_min, comp, win, cfg=MAINT_CFG, floor=None):
    r = pd.Series(comp).rolling(int(cfg["refine_smooth_min"] * 60 / STRIDE_S),
                                center=True, min_periods=1).median().values
    s, e = win
    inw = (t_min >= s) & (t_min <= e)
    ti, ri = t_min[inw], r[inw]
    if ti.size == 0:
        return None, None, None
    q = cfg["refine_core_frac"]
    lo, hi = np.quantile(ti, [(1 - q) / 2, 1 - (1 - q) / 2])
    core = float(np.nanmedian(ri[(ti >= lo) & (ti <= hi)]))
    threshold = core + cfg["refine_tol"]
    if floor is not None:
        threshold = max(threshold, floor)
    ok = ri <= threshold
    if not ok.any():
        return None, core, threshold
    return (round(float(ti[np.argmax(ok)]), 1),
            round(float(ti[len(ok) - 1 - np.argmax(ok[::-1])]), 1)), core, threshold


def _gaps_inside(sess, win):
    fs = sess["fs"]
    spans = sorted((b["t_start"], b["t_start"] + len(b["x"]) / fs) for b in sess["blocks"])
    a, z = win[0] * 60, win[1] * 60
    gaps, cursor = [], a
    for s, e in spans:
        if s > cursor and cursor < z:
            gaps.append(min(s, z) - cursor)
        cursor = max(cursor, e)
        if cursor >= z:
            break
    if cursor < z:
        gaps.append(z - cursor)
    return [g for g in gaps if g > 0]


def completeness(sess, win, det, source, cfg=MAINT_CFG):
    """Agreed v3 rules without a clinical record: reasons reject the window."""
    reasons = []
    data_start = min(b["t_start"] for b in sess["blocks"]) / 60
    duration = win[1] - win[0]
    if duration < cfg["min_maint_min"]:
        reasons.append(f"maintenance window {duration:.1f} min is shorter than {cfg['min_maint_min']} min")
    gaps = _gaps_inside(sess, win)
    longest = max(gaps) if gaps else 0.0
    if longest > cfg["max_gap_in_maint_s"]:
        reasons.append(f"signal gap of {longest:.0f} s inside the window "
                       f"(limit {cfg['max_gap_in_maint_s']} s)")
    if source == "auto":
        if cfg["require_induction"] and det is not None and not det["awake_before_found"]:
            reasons.append("induction not recorded: the recording starts with the composite "
                           f"already below {cfg['maint_low']}")
        if cfg["require_emergence"] and det is not None and not det["emergence_found"]:
            reasons.append("emergence not detected: the recording ends before a sustained "
                           f"rise above {cfg['maint_high']}")
    return {"verdict": "complete" if not reasons else "rejected", "reasons": reasons,
            "duration_min": round(duration, 1), "n_gaps": len(gaps),
            "longest_gap_s": round(longest, 1),
            "ended_during_emergence": bool(det and det["emergence_at_recording_end"])}


def _composite_trend(t, comp, bin_s=10.0):
    """Per-bin median composite on the session clock (desktop composite_session trend_10s)."""
    bins = np.floor(t / bin_s).astype(int)
    time_min, composite = [], []
    for k in np.unique(bins):
        m = bins == k
        v = comp[m]
        v = v[~np.isnan(v)]
        time_min.append(round(float((k + 0.5) * bin_s / 60), 3))
        composite.append(_num(np.median(v), 1) if v.size else None)
    return {"time_min": time_min, "composite": composite}


def find_maintenance(sess, manual_window=None, preset="v3_default", cfg=MAINT_CFG):
    """Maintenance window: manual (clipped to the composite span) or automatic.
    Returns a dict with source, window, verdict, reasons and the detection details."""
    cat = composite_series(sess, cfg)
    t_min, comp = cat["t"] / 60, cat["comp"]
    out = {"source": "manual" if manual_window else "auto", "skipped_blocks_at_min": cat["skipped"],
           "composite_span_min": [round(float(t_min.min()), 2), round(float(t_min.max()), 2)]}
    out["composite_trend"] = _composite_trend(cat["t"], cat["comp"], cfg.get("comp_trend_bin_s", 10.0))
    if manual_window:
        win = (round(max(manual_window[0], float(t_min.min())), 1),
               round(min(manual_window[1], float(t_min.max())), 1))
        out.update(window=list(win), verdict="manual", reasons=[], detected=None,
                   refined=list(win), flags=[])
        return out

    det = detect_maintenance(t_min, comp, cfg)
    out["detected"] = det
    if det is None:
        out.update(window=None, verdict="rejected", reasons=[
            f"no sustained period ({cfg['maint_sustain_min']} min) below {cfg['maint_low']}"])
        out["flags"] = ["no maintenance detected"]
        return out

    win, core, thr = refine_window(t_min, comp, (det["start"], det["end"]), cfg,
                                   cfg["refine_floor"].get(preset))
    out.update(core_level=_num(core, 1), refine_threshold=_num(thr, 1))
    if win is None:
        out.update(window=None, verdict="rejected", reasons=["refinement left no usable window"])
        out["flags"] = ["no maintenance detected"]
        return out
    out["window"] = list(win)
    out["refined"] = list(win)
    out.update(completeness(sess, win, det, "auto", cfg))
    out["flags"] = [] if out["verdict"] == "complete" else ["no maintenance detected"]
    return out


def line_length_suppression(x_filtered, fs, cfg=CFG):
    """Candidate suppression: centred line length below threshold (desktop bsr)."""
    n_w = int(round(cfg["bsr_ll_window_s"] * fs))
    absdiff = np.abs(np.diff(x_filtered, prepend=x_filtered[0]))
    ll = np.convolve(absdiff, np.ones(n_w), mode="same")
    return ll <= cfg["bsr_ll_threshold_uv"]


def _runs(mask):
    """Start and end indices of True runs."""
    d = np.diff(np.concatenate(([0], mask.astype(np.int8), [0])))
    return np.flatnonzero(d == 1), np.flatnonzero(d == -1)


def drop_short_runs(mask, min_len):
    """Discard True runs shorter than min_len samples (desktop ApplyMinimumDuration)."""
    out = mask.copy()
    for s, e in zip(*_runs(mask)):
        if e - s < min_len:
            out[s:e] = False
    return out


def bsr_analysis(sess, window_min=None, cfg=CFG):
    """BSR over the whole session or a [start, end) minute window, with a per-minute
    trend and amplitude diagnostics of the detected episodes (desktop bsr.bsr_analysis)."""
    fs = sess["fs"]
    min_len = int(round(cfg["bsr_min_episode_s"] * fs))
    a, z = (window_min[0] * 60, window_min[1] * 60) if window_min else (-np.inf, np.inf)

    times, supp_all, det_all, episodes, pp, rms = [], [], [], [], [], []
    for b in sess["blocks"]:
        x = np.asarray(b["x"], dtype=float)
        sat = np.asarray(b["sat"], dtype=bool)
        indet = sat | stuck_mask(x, sat, fs, cfg["qc_stuck_s"])
        xf = clean(x, fs, cfg)
        cand = line_length_suppression(xf, fs, cfg) & ~indet
        if cfg.get("bsr_amp_uv") is not None:
            cand &= np.abs(xf) <= cfg["bsr_amp_uv"]
        supp = drop_short_runs(cand, min_len)

        t = b["t_start"] + np.arange(len(x)) / fs
        m = (t >= a) & (t < z)
        if not m.any():
            continue
        times.append(t[m])
        supp_all.append(supp[m])
        det_all.append(~indet[m])
        xm = xf[m]
        for st, en in zip(*_runs(supp[m])):
            episodes.append((en - st) / fs)
            pp.append(float(xm[st:en].max() - xm[st:en].min()))
            rms.append(float(np.sqrt(np.mean(xm[st:en] ** 2))))

    if not times:
        raise ValueError("no signal inside the BSR window")

    t = np.concatenate(times)
    supp = np.concatenate(supp_all)
    det = np.concatenate(det_all)
    n_det = int(det.sum())

    minute = np.floor(t / 60).astype(int)
    det_per_min = np.bincount(minute, weights=det.astype(float))
    supp_per_min = np.bincount(minute, weights=supp.astype(float))
    trend = [round(100 * sv / dv, 2) if dv else None for sv, dv in zip(supp_per_min, det_per_min)]

    pp = np.array(pp)
    return {
        "method": "line length + amplitude (v3): R1, filtered, centred window",
        "window_min": window_min,
        "settings": {"window_s": cfg["bsr_ll_window_s"], "threshold_uv": cfg["bsr_ll_threshold_uv"],
                     "amplitude_uv": cfg.get("bsr_amp_uv"), "min_episode_s": cfg["bsr_min_episode_s"]},
        "bsr_pct": _num(100 * supp.sum() / n_det, 3) if n_det else None,
        "suppression_min": _num(float(supp.sum()) / fs / 60, 2),
        "analysed_min": _num(float(n_det) / fs / 60, 2),
        "indeterminate_pct": _num(100 * (1 - det.mean()), 3),
        "n_episodes": len(episodes),
        "episode_median_s": _num(np.median(episodes), 2) if episodes else None,
        "episode_longest_s": _num(max(episodes), 2) if episodes else None,
        "episode_pp_uv": ({"median": _num(np.median(pp), 2), "p90": _num(np.percentile(pp, 90), 2),
                           "max": _num(pp.max(), 2), "pct_within_10uv": _num(100 * np.mean(pp <= 10), 1)}
                          if len(pp) else None),
        "episode_rms_uv": ({"median": _num(np.median(rms), 2), "p90": _num(np.percentile(rms, 90), 2)}
                           if rms else None),
        "trend_per_min_pct": trend,
    }


def _bsr_trend_obj(per_min):
    """Wrap a per-minute BSR list as a timeline object for the chart."""
    return {"bin_s": 60, "time_min": [k + 0.5 for k in range(len(per_min))], "pct_per_min": per_min}


def run_report(blocks, fs, resolution_uv, preset="v3_default", manual_window=None):
    """Maintenance window (manual or automatic). When it is accepted, all biomarkers
    inside it. verdict is 'complete', 'manual' or 'rejected'; maintenance holds the details."""
    sess = {"fs": fs, "resolution_uv": resolution_uv, "blocks": blocks}
    m = find_maintenance(sess, manual_window, preset)
    if m.get("verdict") not in ("complete", "manual"):
        return {"verdict": "rejected", "maintenance": m, "reasons": m.get("reasons", [])}
    result = run_session(blocks, fs, preset, m["window"])
    result.update(verdict=m["verdict"], maintenance=m)
    try:
        tr = spectral_trends(blocks, fs, preset)
        result["dsa"] = tr["dsa"]
        result["band_trend"] = tr["bands"]
    except Exception:
        result["dsa"] = None
        result["band_trend"] = None
    try:
        result["bsr"] = bsr_analysis(sess, m["window"], CFG)
    except Exception:
        result["bsr"] = None
    try:
        result["bsr_trend"] = _bsr_trend_obj(bsr_analysis(sess, None, CFG)["trend_per_min_pct"])
    except Exception:
        result["bsr_trend"] = None
    try:
        result["qc_flags"] = qc_flags(blocks, fs, resolution_uv, result.get("dsa"))
    except Exception:
        result["qc_flags"] = None
    return result



def run_review(blocks, fs, resolution_uv, preset="v3_default"):
    """Single-file / no-maintenance review: spectral biomarkers over the whole recording,
    with no maintenance detection or window clipping. A composite trend is added when the
    recording has a block >= 90 s; otherwise it is omitted."""
    result = run_session(blocks, fs, preset, None)
    span = [round(min(b["t_start"] for b in blocks) / 60, 1),
            round(max(b["t_start"] + len(b["x"]) / fs for b in blocks) / 60, 1)]
    result["window_min"] = span
    result["verdict"] = "review"
    trend = None
    try:
        sess = {"fs": fs, "resolution_uv": resolution_uv, "blocks": blocks}
        cat = composite_series(sess, MAINT_CFG)
        trend = _composite_trend(cat["t"], cat["comp"], MAINT_CFG["comp_trend_bin_s"])
    except Exception:
        trend = None
    result["maintenance"] = {"source": "review", "window": span, "verdict": "review",
                             "composite_trend": trend}
    try:
        tr = spectral_trends(blocks, fs, preset)
        result["dsa"] = tr["dsa"]
        result["band_trend"] = tr["bands"]
    except Exception:
        result["dsa"] = None
        result["band_trend"] = None
    try:
        full = bsr_analysis(sess, None, CFG)
        result["bsr"] = full
        result["bsr_trend"] = _bsr_trend_obj(full["trend_per_min_pct"])
    except Exception:
        result["bsr"] = None
        result["bsr_trend"] = None
    try:
        result["qc_flags"] = qc_flags(blocks, fs, resolution_uv, result.get("dsa"))
    except Exception:
        result["qc_flags"] = None
    return result
