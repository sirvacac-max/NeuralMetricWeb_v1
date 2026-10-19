// wwwroot/js/analysis.js
// Browser entry point for Blazor: reads the selected files, runs intake, runs the engine in the worker.
// Supports SedLine EDF files and BIS Vista raw exports (.h_a/.r2a/.spa triplets).
import { inspectFiles, buildSession, buildBisSession } from "./session.js";
import { readEdfHeader } from "./edf.js";
import { bisChannels } from "./bisVista.js";

const CHANNEL = "EEG R1(Fp2)";                 // SedLine default, used as a preferred hint
const DEVICE_CLIP_WARN_PCT = 5.0;              // bad-signal rule: >5 % of a file's samples at the device limits
const BIS_RAW_EXT = [".r2a", ".r4a", ".r1a"];

let worker = null;
let lastSession = null;
let workerReady = null;
let nextId = 100;
const pending = new Map();

function startWorker() {
    if (!workerReady) {
        worker = new Worker("/js/pyodideWorker.js", { type: "module" });
        workerReady = new Promise((resolve, reject) => {
            worker.onerror = (e) => reject(new Error(e.message || "worker failed to start"));
            worker.onmessage = (e) => {
                const { type, id, data, message } = e.data;
                if (type === "ready") { resolve(); return; }
                const p = pending.get(id);
                if (!p) return;
                pending.delete(id);
                if (type === "error") p.reject(new Error(message));
                else p.resolve(data);
            };
        });
        worker.postMessage({ type: "init", id: 1 });
    }
    return workerReady;
}

function callWorker(type, payload) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ type, id, payload });
    });
}

function corruptFiles(stitchLog) {
    return (stitchLog ?? [])
        .map((s, i) => ({ file: s.file ?? `file ${i + 1}`, clipped_pct: s.clipped_pct }))
        .filter((f) => typeof f.clipped_pct === "number" && f.clipped_pct > DEVICE_CLIP_WARN_PCT)
        .map((f) => `${f.file}: ${f.clipped_pct.toFixed(2)} % of samples at the device limits (bad signal)`);
}

// ---- file-type detection ----
const lower = (f) => f.name.toLowerCase();
const stem = (name) => name.replace(/\.[^.]+$/, "");
const allFiles = (inputId) => { const el = document.getElementById(inputId); return el && el.files ? [...el.files] : []; };
const edfFilesOf = (files) => files.filter((f) => lower(f).endsWith(".edf"));

function pickBisTriplet(files) {
    const ha = files.find((f) => lower(f).endsWith(".h_a"));
    if (!ha) return null;
    const base = stem(ha.name);
    const raw = files.find((f) => BIS_RAW_EXT.some((e) => lower(f).endsWith(e)) && stem(f.name) === base)
             || files.find((f) => BIS_RAW_EXT.some((e) => lower(f).endsWith(e)));
    if (!raw) return null;
    const spa = files.find((f) => lower(f).endsWith(".spa") && stem(f.name) === base)
             || files.find((f) => lower(f).endsWith(".spa"));
    return { h_a: ha, raw, spa, name: base };
}

// Analysis-channel options for the picker (BIS channels, or EDF EEG labels).
export async function channelsInfo(inputId) {
    const files = allFiles(inputId);
    const tri = pickBisTriplet(files);
    if (tri) {
        try {
            const info = await bisChannels(tri.h_a);
            return { type: "bis", fs: info.fs, channels: info.channels, default: 0 };
        } catch (e) { return { type: "bis", channels: [], default: 0 }; }
    }
    const edf = edfFilesOf(files);
    if (edf.length) {
        try {
            const h = await readEdfHeader(edf[0]);
            const opts = h.labels.map((l) => l.trim())
                .filter((l) => l !== "EDF Annotations" && /eeg/i.test(l))
                .map((l) => ({ value: l, label: l }));
            const def = opts.findIndex((o) => o.value === CHANNEL);
            return { type: "edf", fs: h.fs[0], channels: opts, default: def >= 0 ? def : 0 };
        } catch (e) { return { type: "edf", channels: [], default: 0 }; }
    }
    return { type: "none", channels: [], default: 0 };
}

// Build an EDF or BIS session from the current selection; cache it for re-runs.
async function prepareSession(inputId, channel, report) {
    const files = allFiles(inputId);
    const tri = pickBisTriplet(files);
    report("reading");
    let sess;
    if (tri) {
        const ch = (channel == null) ? 0 : (parseInt(channel, 10) || 0);
        sess = await buildBisSession(tri, ch);
    } else {
        const edf = edfFilesOf(files);
        if (edf.length === 0) throw new Error("No EDF or BIS Vista (.h_a/.r2a/.spa) files found in the selection.");
        const preferred = (typeof channel === "string" && channel) ? channel : CHANNEL;
        const insp = await inspectFiles(edf, preferred);
        sess = await buildSession(insp);
    }
    lastSession = sess;
    try { window.__nmwRaw = { fs: sess.fs, t0: sess.t0, blocks: sess.blocks }; } catch (e) { }
    return sess;
}

// von Dincklage 2021 duration check: a file whose stored duration (n / header-fs) does not
// match the real clock gap to the next file reveals an undocumented feed / sampling-rate change.
function feedDurationCheck(stitchLog) {
    if (!Array.isArray(stitchLog) || stitchLog.length < 2) return { seams: [], high: false, checked: false };
    const seams = [];
    for (let i = 0; i < stitchLog.length - 1; i++) {
        const a = stitchLog[i], b = stitchLog[i + 1];
        const claimed = (a.duration_min || 0) * 60;
        const clock = ((b.start_min || 0) - (a.start_min || 0)) * 60;
        if (claimed <= 0 || clock <= 0) continue;
        const ratio = claimed / clock;
        // a 178<->89 Hz feed change shifts the stored duration by at most 2x; outside [0.45,0.9]U[1.12,2.2]
        // the mismatch is a recording gap/overlap, not a feed change, so it is not flagged here.
        if ((ratio >= 0.45 && ratio <= 0.9) || (ratio >= 1.12 && ratio <= 2.2)) {
            seams.push({ file: a.file, ratio: Math.round(ratio * 100) / 100,
                claimed_min: Math.round((claimed / 60) * 10) / 10,
                clock_min: Math.round((clock / 60) * 10) / 10 });
        }
    }
    return { seams, high: seams.length > 0, checked: true };
}

function attachMeta(data, sess) {
    return {
        ...data,
        corrupt_files: corruptFiles(sess.stitch_log),
        files_used: sess.files_used,
        files_total: sess.files_total,
        recorded_min: sess.recorded_min,
        analysable_min: sess.analysable_min,
        resolution_uv: sess.resolution_uv,
        session_start: sess.t0,
        session_end: sess.t_end,
        channel: sess.channel,
        source_format: sess.source || "edf",
        events: sess.events || [],
        stitch_log: sess.stitch_log,
        quality: sess.quality,
        annotations: sess.annotations || [],
        device: sess.device || null,
        feed_check: feedDurationCheck(sess.stitch_log),
    };
}

export async function analyzeSelection(inputId, manualWindow, progress, channel) {
    const report = (s) => { try { if (progress) progress.invokeMethodAsync("Stage", s); } catch (e) { } };
    const input = document.getElementById(inputId);
    if (!input || !input.files || input.files.length === 0) throw new Error("Choose the session's files first.");
    const sess = await prepareSession(inputId, channel, report);
    report("processing");
    await startWorker();
    const data = await callWorker("report", {
        blocks: sess.blocks, fs: sess.fs, resolution_uv: sess.resolution_uv,
        preset: "v3_default", manual_window: manualWindow ?? null,
    });
    report("done");
    const _result = attachMeta(data, sess);
    try { window.__nmwResult = _result; } catch (e) { }
    return _result;
}

// Re-run the report on the already-loaded session with a manual window (no re-read).
export async function reanalyzeWindow(manualWindow, progress) {
    const report = (s) => { try { if (progress) progress.invokeMethodAsync("Stage", s); } catch (e) { } };
    if (!lastSession) throw new Error("No session is loaded to re-analyze. Start a new analysis.");
    const sess = lastSession;
    report("processing");
    await startWorker();
    const data = await callWorker("report", {
        blocks: sess.blocks, fs: sess.fs, resolution_uv: sess.resolution_uv,
        preset: "v3_default", manual_window: manualWindow ?? null,
    });
    report("done");
    const _result = attachMeta(data, sess);
    try { window.__nmwResult = _result; } catch (e) { }
    return _result;
}

export function warmup() { try { startWorker(); } catch (e) { } }

export async function analyzeReview(inputId, progress, channel) {
    const report = (s) => { try { if (progress) progress.invokeMethodAsync("Stage", s); } catch (e) { } };
    const input = document.getElementById(inputId);
    if (!input || !input.files || input.files.length === 0) throw new Error("Choose a file first.");
    const sess = await prepareSession(inputId, channel, report);
    report("processing");
    await startWorker();
    const data = await callWorker("review", {
        blocks: sess.blocks, fs: sess.fs, resolution_uv: sess.resolution_uv, preset: "v3_default",
    });
    report("done");
    const _result = attachMeta(data, sess);
    try { window.__nmwResult = _result; } catch (e) { }
    return _result;
}

// Count analyzable units in the selection: EDF files, or a BIS triplet (counts as 1).
export function edfCount(inputId) {
    const files = allFiles(inputId);
    const edf = edfFilesOf(files).length;
    if (edf > 0) return edf;
    return pickBisTriplet(files) ? 1 : 0;
}

// Headers-only read for the pre-run estimate + session clock (EDF) or duration (BIS).
export async function sessionInfo(inputId) {
    const files = allFiles(inputId);
    const tri = pickBisTriplet(files);
    let minutes = 0, minStart = Infinity, maxEnd = -Infinity, count = 0;
    if (tri) {
        try {
            const info = await bisChannels(tri.h_a);
            const bytes = tri.raw.size;
            const nSamp = Math.floor(bytes / 2 / Math.max(info.nch, 1));
            minutes = (nSamp / info.fs) / 60;
            count = 1;
        } catch (e) { }
    } else {
        const edf = edfFilesOf(files);
        count = edf.length;
        for (const f of edf) {
            try {
                const h = await readEdfHeader(f);
                const recs = h.declared === -1 ? h.present : h.declared;
                if (recs > 0 && h.recDur > 0) {
                    const durS = recs * h.recDur;
                    minutes += durS / 60;
                    minStart = Math.min(minStart, h.start);
                    maxEnd = Math.max(maxEnd, h.start + durS * 1000);
                }
            } catch (e) { }
        }
    }
    let est = null;
    try {
        const rate = parseFloat(localStorage.getItem("nmw-secpermin") || "");
        if (isFinite(rate) && minutes > 0) est = Math.round(rate * minutes);
    } catch (e) { }
    const startIso = isFinite(minStart) ? new Date(minStart).toISOString() : null;
    const endIso = isFinite(maxEnd) ? new Date(maxEnd).toISOString() : null;
    return { count, minutes: Math.round(minutes), estSeconds: est, startIso, endIso };
}

export function recordRun(minutes, seconds) {
    try { if (minutes > 0 && seconds > 0) localStorage.setItem("nmw-secpermin", String(seconds / minutes)); } catch (e) { }
}
