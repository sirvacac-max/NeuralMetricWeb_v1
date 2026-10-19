// wwwroot/js/bisVista.js
// Reads a BIS Vista raw export: .h_a header + .r2a/.r4a/.r1a raw EEG + .spa 1-Hz trends.
// Binary layout reverse-engineered and validated bit-exact against the vendor's MATLAB
// reader (github.com/Tiakat/intraop-eeg-pipeline). Everything runs locally; nothing uploads.
//
//   .h_a   2048-byte header: @184 int16 n_channels, @186 int16 fs(Hz),
//          @702 4x float32 gain (uV per A/D unit), @766 4x float32 offset (A/D units)
//   .r2a   raw EEG, little-endian int16, channels interleaved; uV = (AD - offset) * gain
//   .spa   processed variables at 1 Hz, '|'-separated text, 2 header lines (BIS, SEF, SR...)

const HEADER_SIZE = 2048;
const SPA_SENTINELS = new Set([-3276.8, -327.7, -32768, -3276, -327]);
const BIS_LABELS = ["EEG R1", "EEG L1", "EEG R2", "EEG L2"];

// Channel options for the picker: [{value:index, label}]. Also returns fs, nch.
export async function bisChannels(h_aFile) {
    const hdr = await readVistaHeader(h_aFile);
    const labels = (hdr.nch >= 2 ? BIS_LABELS : ["EEG"]).slice(0, hdr.nch);
    return { fs: hdr.fs, nch: hdr.nch, channels: labels.map((l, i) => ({ value: i, label: l })) };
}

export async function readVistaHeader(file) {
    const b = new DataView(await file.slice(0, HEADER_SIZE).arrayBuffer());
    const nch = b.getInt16(184, true);
    const fs = b.getInt16(186, true);
    if (!(nch >= 1 && nch <= 4)) throw new Error(`BIS header: implausible channel count (${nch})`);
    if (!(fs > 0)) throw new Error(`BIS header: bad sampling rate (${fs})`);
    const gain = [], offset = [];
    for (let i = 0; i < nch; i++) {
        gain.push(b.getFloat32(702 + i * 4, true));
        offset.push(b.getFloat32(766 + i * 4, true));
    }
    return { nch, fs, gain, offset };
}

// Returns { fs, nch, gain, labels, channels:[Float32Array uV], sat:[Uint8Array] }.
export async function readVistaRaw(h_aFile, rawFile) {
    const hdr = await readVistaHeader(h_aFile);
    const buf = await rawFile.arrayBuffer();
    const ad = new Int16Array(buf);          // files are little-endian; browsers are LE
    const nch = hdr.nch;
    const n = Math.floor(ad.length / nch);
    const channels = [], sat = [];
    for (let c = 0; c < nch; c++) {
        const x = new Float32Array(n), s = new Uint8Array(n);
        const g = hdr.gain[c], o = hdr.offset[c];
        for (let i = 0; i < n; i++) {
            const a = ad[i * nch + c];
            x[i] = (a - o) * g;
            if (a >= 32767 || a <= -32768) s[i] = 1;   // A/D rail -> saturated
        }
        channels.push(x); sat.push(s);
    }
    const labels = (nch >= 2 ? BIS_LABELS : ["EEG"]).slice(0, nch);
    return { fs: hdr.fs, nch, gain: hdr.gain, labels, channels, sat };
}

// 1-Hz device variables. Returns { n, time, bis, sef, sr, cols } (null arrays when absent).
export async function readVistaSpa(file) {
    const text = await file.text();
    const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
    if (lines.length < 3) return null;
    const groups = lines[0].split("|").map((s) => s.trim());
    const names = lines[1].split("|").map((s) => s.trim());
    let g = "";
    const cols = names.map((v, i) => {
        if (groups[i]) g = groups[i];
        return g ? `${v}_${g.replace(/\s+/g, "")}` : v;
    });
    const rows = lines.slice(2).map((l) => l.split("|"));
    const clean = (v) => (Number.isFinite(v) && !SPA_SENTINELS.has(v)) ? v : null;
    const colByName = (pred) => {
        const i = cols.findIndex((c) => pred(c.toUpperCase()));
        return i >= 0 ? rows.map((r) => clean(parseFloat(r[i]))) : null;
    };
    return {
        n: rows.length,
        time: rows.map((r) => (r[0] || "").trim()),
        // BIS Vista exports the BIS index under the coded column "DB13U01" (per hemisphere + combined);
        // "BiSmooth" (smoothing-rate setting) and "BISBIT" (status bits) also start with BIS - exclude them.
        bis: colByName((c) => c.startsWith("DB13") || (c.startsWith("BIS") && !c.startsWith("BISMOOTH") && !c.startsWith("BISBIT"))),
        sef: colByName((c) => c.startsWith("SEF")),
        sr: colByName((c) => c.startsWith("SR") || c.includes("SUPP")),
        cols,
    };
}
