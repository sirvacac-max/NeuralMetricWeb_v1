// wwwroot/js/session.js
// Multi-file session intake. Same rules as the desktop intake.py and loader.py.
import { readEdfHeader, readChannel, readAnnotations } from "./edf.js";
import { readVistaHeader, readVistaRaw, readVistaSpa } from "./bisVista.js";

export const RULES = {
    maxGapS: 1.0,      // files this close are stitched into one block
    mixedGapMin: 30,   // a larger gap starts a different session
    maxOverlapS: 5,    // a larger overlap starts a different session
    flatWinS: 1.0,     // sensor-off test window
    flatSdUv: 0.5,     // a window is live above this standard deviation
    minLiveFrac: 0.5,  // a block below this live fraction is dropped
};

const UNIT_TO_UV = { uV: 1, "µV": 1, mV: 1e3, V: 1e6 };

// Device profiles: known analysis-channel labels, tried in order. Falls back to any
// label containing "EEG" (so BIS and generic single-channel EDF exports work too).
export const CHANNEL_CANDIDATES = [
    "EEG R1(Fp2)", "EEG R1", "EEG L1(Fp1)", "EEG L1",     // Masimo SedLine montages
    "BIS/EEG", "EEG1", "EEG Ch1", "EEG Fp2", "EEG Fp1",   // BIS / generic
    "EEG",
];
function pickEegChannel(labels, preferred) {
    const norm = labels.map((l) => l.trim());
    if (preferred && norm.includes(preferred.trim())) return preferred.trim();
    for (const c of CHANNEL_CANDIDATES) {
        const i = norm.indexOf(c);
        if (i >= 0) return norm[i];
    }
    for (const l of norm) {
        if (l !== "EDF Annotations" && /eeg/i.test(l)) return l;   // any EEG-like channel
    }
    return null;
}
const r = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

const concat = (parts, Type) => {
    const total = parts.reduce((s, p) => s + p.length, 0);
    const out = new Type(total);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
};

// Sensor-off trimming (trim_flat in loader.py): drop dead blocks, trim leading/trailing flat.
function trimBlocks(blocks, fs, events) {
    const w = Math.floor(RULES.flatWinS * fs);
    const kept = [];
    blocks.forEach((b, idx) => {
        const x = concat(b.x, Float32Array);
        const sat = concat(b.sat, Uint8Array);
        const where = `block ${idx + 1} at ${(b.t_start / 60).toFixed(1)} min`;
        const nWin = Math.floor(x.length / w);
        if (nWin === 0) {
            events.push({ type: "block_dropped", block: idx + 1, reason: `${where} is shorter than one ${w}-sample window` });
            return;
        }
        const live = new Uint8Array(nWin);
        let nLive = 0;
        for (let k = 0; k < nWin; k++) {
            let sum = 0;
            for (let j = k * w; j < (k + 1) * w; j++) sum += x[j];
            const mean = sum / w;
            let ss = 0;
            for (let j = k * w; j < (k + 1) * w; j++) { const d = x[j] - mean; ss += d * d; }
            if (Math.sqrt(ss / w) > RULES.flatSdUv) { live[k] = 1; nLive++; }
        }
        const liveFrac = nLive / nWin;
        if (liveFrac < RULES.minLiveFrac) {
            events.push({ type: "block_dropped", block: idx + 1,
                reason: `${where}: only ${r(100 * liveFrac, 0)} % live (sensor off)`,
                duration_min: r(x.length / fs / 60) });
            return;
        }
        const first = live.indexOf(1);
        const last = live.lastIndexOf(1) + 1;
        const trimStart = (first * w) / fs;
        const trimEnd = (x.length - last * w) / fs;
        if (trimStart || trimEnd) {
            events.push({ type: "trimmed", block: idx + 1, start_min: r(trimStart / 60), end_min: r(trimEnd / 60) });
        }
        kept.push({
            t_start: b.t_start + trimStart,
            x: x.slice(first * w, last * w),
            sat: sat.slice(first * w, last * w),
            live_pct: r(100 * liveFrac, 1),
        });
    });
    return kept;
}

// Step 1: check every selected file (desktop check_file and check_folder).
export async function inspectFiles(files, preferred = null) {
    const infos = [];
    for (const file of files) {
        const info = { file: file.name, status: "ok", reasons: [], warnings: [], _file: file };
        infos.push(info);
        const reject = (why) => { info.status = "rejected"; info.reasons.push(why); };

        let h;
        try {
            h = await readEdfHeader(file);
        } catch (err) {
            reject(`invalid EDF header: ${err.message}`);
            continue;
        }
        info._h = h;

        if (h.reserved.startsWith("EDF+D")) reject("discontinuous EDF+ (EDF+D) is not supported");
        if (h.declared === -1) info.warnings.push(`record count not written; using ${h.present} records`);
        else if (h.present < h.declared) reject(`truncated: ${h.present} of ${h.declared} data records present`);
        else if (h.present > h.declared) info.warnings.push(`${h.present - h.declared} extra record(s) ignored`);
        const records = h.declared === -1 ? h.present : h.declared;
        if (records <= 0) reject("contains no data records");

        const ch = pickEegChannel(h.labels, preferred);
        if (!ch) { reject(`no EEG channel found (labels: ${h.labels.join(", ")})`); continue; }
        info._channel = ch;
        const i = h.labels.indexOf(ch);
        if (!Object.hasOwn(UNIT_TO_UV, h.units[i])) reject(`unknown unit '${h.units[i]}'; cannot convert to µV`);
        if (h.pmax[i] <= h.pmin[i] || h.dmax[i] <= h.dmin[i]) {
            reject("invalid amplitude calibration for the analysis channel");
        }

        info.start = h.start;
        info.durationS = records * h.recDur;
        info.fs = h.fs[i];
    }

    // Dominant sampling rate; files at a different rate are rejected.
    const ok = infos.filter((f) => f.status === "ok");
    if (ok.length) {
        const counts = new Map();
        for (const f of ok) {
            const k = Math.round(f.fs * 1000);
            counts.set(k, (counts.get(k) || 0) + 1);
        }
        const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
        for (const f of ok) {
            if (Math.round(f.fs * 1000) !== dominant) {
                f.status = "rejected";
                f.reasons.push(`sampling rate ${f.fs.toFixed(2)} Hz differs from the session's ${(dominant / 1000).toFixed(2)} Hz`);
            }
        }
    }

    // Sort by start time and group into sessions by gap or overlap.
    const sorted = infos.filter((f) => f.status === "ok").sort((a, b) => a.start - b.start);
    const sessions = [];
    for (const f of sorted) {
        const cur = sessions[sessions.length - 1];
        if (cur) {
            const prev = cur[cur.length - 1];
            const gapS = (f.start - (prev.start + prev.durationS * 1000)) / 1000;
            if (gapS <= RULES.mixedGapMin * 60 && gapS >= -RULES.maxOverlapS) {
                cur.push(f);
                continue;
            }
        }
        sessions.push([f]);
    }

    const channel = sessions.length && sessions[0].length ? sessions[0][0]._channel : preferred;
    return { channel, infos, sessions };
}

// Step 2: stitch, mark saturation per file, trim sensor-off time (loader.py + trim_flat).
export async function buildSession(insp) {
    if (insp.sessions.length !== 1) {
        throw new Error(`The selection holds ${insp.sessions.length} sessions. Select files from one session.`);
    }
    const files = insp.sessions[0];
    const channel = insp.channel;
    const fs = files[0].fs;
    const t0 = files[0].start;
    const events = [];
    const stitchLog = [];
    const annotations = [];
    const blocks = [];
    let cursor = 0;
    let resolution = 0;
    let recordedS = 0;

    for (const f of files) {
        const c = await readChannel(f._file, f._h, f._channel || channel);
        const toUv = UNIT_TO_UV[c.unit];
        const x = c.x;
        for (let k = 0; k < x.length; k++) x[k] *= toUv;

        const lo = c.phys_min * toUv;
        const hi = c.phys_max * toUv;
        const step = c.resolution * toUv;           // µV per digital step
        resolution = Math.max(resolution, step);

        const sat = new Uint8Array(x.length);
        let nSat = 0;
        for (let k = 0; k < x.length; k++) {
            if (x[k] <= lo + step / 2 || x[k] >= hi - step / 2) { sat[k] = 1; nSat++; }
        }

        const n = x.length;
        const startS = (f.start - t0) / 1000;
        const gap = startS - cursor;
        try {
            const ann = await readAnnotations(f._file, f._h);
            for (const a of ann.annotations) {
                annotations.push({
                    time_min: r((startS + a.onset_s) / 60, 3),
                    onset_s: r(startS + a.onset_s, 2),
                    duration_s: a.duration_s,
                    text: a.text,
                    file: f.file,
                });
            }
        } catch (e) { }
        recordedS += f.durationS;
        const entry = {
            file: f.file,
            start_min: r(startS / 60),
            duration_min: r(n / fs / 60),
            clipped_pct: r((100 * nSat) / n, 3),
            gap_before_s: blocks.length ? r(gap) : null,
            resolution_uv: r(step, 4),
            fs_hz: r(f.fs, 2),
        };

        const cur = blocks[blocks.length - 1];
        if (cur && gap <= RULES.maxGapS) {
            const dropped = gap < 0 ? Math.round(-gap * fs) : 0;
            cur.x.push(x.subarray(dropped));
            cur.sat.push(sat.subarray(dropped));
            entry.action = "joined";
            entry.overlap_samples_dropped = dropped;
        } else {
            blocks.push({ t_start: startS, x: [x], sat: [sat] });
            entry.action = blocks.length === 1 ? "first block" : "new block (gap)";
        }
        stitchLog.push(entry);
        cursor = startS + n / fs;
    }

    // Sensor-off trimming, as trim_flat in loader.py.
    const kept = trimBlocks(blocks, fs, events);
    if (!kept.length) throw new Error("No usable EEG after flat-segment removal");

    // Recording-quality summary: resolution (gain) and sampling-rate changes, lead-off / clipping.
    const stepVals = [...new Set(stitchLog.map((e) => e.resolution_uv))];
    const fsVals = [...new Set(stitchLog.map((e) => e.fs_hz))];
    const maxClip = stitchLog.reduce((m, e) => Math.max(m, e.clipped_pct || 0), 0);
    const quality = {
        resolution_changed: stepVals.length > 1,
        resolution_values_uv: stepVals,
        fs_changed: fsVals.length > 1,
        fs_values_hz: fsVals,
        files_excluded: insp.infos.length - files.length,
        blocks_dropped: events.filter((e) => e.type === "block_dropped").length,
        segments_trimmed: events.filter((e) => e.type === "trimmed").length,
        max_clipped_pct: r(maxClip, 2),
        annotations_count: annotations.length,
    };

    // Session end: last file's header start plus its recorded duration (header clock, as written).
    const lastFile = files[files.length - 1];
    const tEnd = new Date(lastFile.start + lastFile.durationS * 1000).toISOString();

    return {
        channel,
        fs,
        resolution_uv: resolution,
        t0: new Date(t0).toISOString(),
        t_end: tEnd,
        files_used: files.length,
        files_total: insp.infos.length,
        recorded_min: r(recordedS / 60),
        analysable_min: r(kept.reduce((s, b) => s + b.x.length, 0) / fs / 60),
        stitch_log: stitchLog,
        quality,
        annotations,
        events,
        blocks: kept,
    };
}

// ---- BIS Vista intake (one .h_a + .r2a/.r4a + .spa triplet per case) ----
const BIS_CH_LABELS = ["EEG R1", "EEG L1", "EEG R2", "EEG L2"];

export async function buildBisSession(triplet, channelIndex = 0) {
    const hdr = await readVistaHeader(triplet.h_a);
    const fs = hdr.fs, nch = hdr.nch;
    const avail = (nch >= 2 ? BIS_CH_LABELS : ["EEG"]).slice(0, nch);
    let ci = Number.isInteger(channelIndex) ? channelIndex : 0;
    if (ci < 0 || ci >= nch) ci = 0;

    const raw = await readVistaRaw(triplet.h_a, triplet.raw);
    const x = raw.channels[ci], sat = raw.sat[ci];
    const n = x.length, durS = n / fs;
    let nSat = 0; for (let i = 0; i < n; i++) nSat += sat[i];

    const events = [];
    const kept = trimBlocks([{ t_start: 0, x: [x], sat: [sat] }], fs, events);
    if (!kept.length) throw new Error("No usable EEG after flat-segment removal");

    const stitchLog = [{
        file: triplet.name || "BIS case", start_min: 0, duration_min: r(durS / 60),
        clipped_pct: r((100 * nSat) / n, 3), gap_before_s: null,
        resolution_uv: r(hdr.gain[ci], 4), fs_hz: r(fs, 2), action: "first block",
    }];
    const quality = {
        resolution_changed: false, resolution_values_uv: [r(hdr.gain[ci], 4)],
        fs_changed: false, fs_values_hz: [r(fs, 2)], files_excluded: 0,
        blocks_dropped: events.filter((e) => e.type === "block_dropped").length,
        segments_trimmed: events.filter((e) => e.type === "trimmed").length,
        max_clipped_pct: r((100 * nSat) / n, 2), annotations_count: 0,
    };

    // Device monitor trends (1 Hz), indexed by second.
    let device = null;
    if (triplet.spa) {
        try {
            const spa = await readVistaSpa(triplet.spa);
            if (spa) device = { bis: spa.bis || [], sef: spa.sef || [], sr: spa.sr || [] };
        } catch (e) { }
    }

    const t0ms = (triplet.raw.lastModified) || Date.now();
    return {
        channel: avail[ci], channels_available: avail, source: "bis", device,
        fs, resolution_uv: hdr.gain[ci],
        t0: new Date(t0ms).toISOString(),
        t_end: new Date(t0ms + durS * 1000).toISOString(),
        files_used: 1, files_total: 1,
        recorded_min: r(durS / 60),
        analysable_min: r(kept.reduce((s2, b) => s2 + b.x.length, 0) / fs / 60),
        stitch_log: stitchLog, quality, annotations: [], events, blocks: kept,
    };
}
