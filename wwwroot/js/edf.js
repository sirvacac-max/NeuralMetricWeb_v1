// wwwroot/js/edf.js
// Reads EDF headers and channels from the user's disk. Nothing is uploaded.
// Header rules follow the desktop intake.py.

const dec = new TextDecoder("ascii");

function parseStart(dateText, timeText) {
    const [d, mo, yy] = dateText.split(".").map(Number);
    const [hh, mi, ss] = timeText.split(".").map(Number);
    if ([d, mo, yy, hh, mi, ss].some((v) => Number.isNaN(v))) {
        throw new Error(`start date/time unreadable: '${dateText} ${timeText}'`);
    }
    const year = yy >= 85 ? 1900 + yy : 2000 + yy; // EDF clipping-year rule
    return Date.UTC(year, mo - 1, d, hh, mi, ss);   // ms, UTC clock
}

export async function readEdfHeader(file) {
    const fixed = dec.decode(await file.slice(0, 256).arrayBuffer());
    const version = fixed.slice(0, 8).trim();
    if (version !== "0") throw new Error(`not an EDF file (version '${version}')`);

    const start = parseStart(fixed.slice(168, 176).trim(), fixed.slice(176, 184).trim());
    const headerBytes = parseInt(fixed.slice(184, 192), 10);
    const reserved = fixed.slice(192, 236).trim();
    const declared = parseInt(fixed.slice(236, 244), 10);
    const recDur = parseFloat(fixed.slice(244, 252));
    const ns = parseInt(fixed.slice(252, 256), 10);

    if (!(ns >= 1)) throw new Error("header declares no signals");
    if (headerBytes !== 256 * (ns + 1)) {
        throw new Error(`header size ${headerBytes} should be ${256 * (ns + 1)}`);
    }
    if (!(recDur > 0)) throw new Error("data record duration must be positive");

    const sig = dec.decode(await file.slice(256, headerBytes).arrayBuffer());
    const field = (base, w) =>
        Array.from({ length: ns }, (_, i) => sig.slice(base * ns + i * w, base * ns + (i + 1) * w).trim());
    const num = (base, w) => field(base, w).map(Number);

    const spr = num(216, 8);
    const recBytes = 2 * spr.reduce((a, b) => a + b, 0);
    const present = Math.floor(Math.max(file.size - headerBytes, 0) / recBytes);

    return {
        start, reserved, recDur, ns, headerBytes, recBytes, declared, present,
        labels: field(0, 16),
        units: field(96, 8),
        pmin: num(104, 8), pmax: num(112, 8),
        dmin: num(120, 8), dmax: num(128, 8),
        spr,
        fs: spr.map((n) => n / recDur),
    };
}

// Reads one channel in its file's own units. session.js converts to µV.
export async function readChannel(file, hdr, label, chunkRecords = 60) {
    const ch = hdr.labels.indexOf(label);
    if (ch < 0) throw new Error(`Channel "${label}" not found. Available: ${hdr.labels.join(", ")}`);

    const nRec = hdr.declared === -1 ? hdr.present : hdr.declared;
    const n = hdr.spr[ch];
    const before = hdr.spr.slice(0, ch).reduce((a, b) => a + b, 0) * 2;
    const scale = (hdr.pmax[ch] - hdr.pmin[ch]) / (hdr.dmax[ch] - hdr.dmin[ch]);
    const out = new Float32Array(nRec * n);
    let pos = 0;

    for (let r = 0; r < nRec; r += chunkRecords) {
        const k = Math.min(chunkRecords, nRec - r);
        const start = hdr.headerBytes + r * hdr.recBytes;
        const dv = new DataView(await file.slice(start, start + k * hdr.recBytes).arrayBuffer());
        for (let j = 0; j < k; j++) {
            const base = j * hdr.recBytes + before;
            for (let s = 0; s < n; s++) {
                out[pos++] = (dv.getInt16(base + s * 2, true) - hdr.dmin[ch]) * scale + hdr.pmin[ch];
            }
        }
    }

    return {
        label,
        unit: hdr.units[ch],
        fs: hdr.fs[ch],
        resolution: scale,          // per digital step, in the file's unit
        phys_min: hdr.pmin[ch],
        phys_max: hdr.pmax[ch],
        x: out,
    };
}


// ---- EDF+ annotations (TAL) ----
// EDF+ stores events in one or more signals labelled "EDF Annotations". Each data
// record holds that signal's bytes as Time-stamped Annotation Lists (TALs):
//   +onset[<0x15>duration]<0x14>text<0x14>...<0x14><0x00>
// The first TAL of each record is timekeeping (empty text) and is skipped.
function parseTALs(bytes, utf8, out) {
    const n = bytes.length;
    let i = 0;
    while (i < n) {
        if (bytes[i] === 0) { i++; continue; }          // padding between/after TALs
        let end = i;
        while (end < n && bytes[end] !== 0) end++;       // TAL runs up to the 0x00
        const tal = bytes.subarray(i, end);
        const fields = [];
        let fstart = 0;
        for (let q = 0; q < tal.length; q++) {
            if (tal[q] === 0x14) { fields.push(tal.subarray(fstart, q)); fstart = q + 1; }
        }
        fields.push(tal.subarray(fstart));
        const head = fields[0];
        let onsetBytes = head, durBytes = null;
        for (let q = 0; q < head.length; q++) {
            if (head[q] === 0x15) { onsetBytes = head.subarray(0, q); durBytes = head.subarray(q + 1); break; }
        }
        const onset = parseFloat(utf8.decode(onsetBytes));
        const dur = durBytes ? parseFloat(utf8.decode(durBytes)) : null;
        for (let t = 1; t < fields.length; t++) {
            const txt = utf8.decode(fields[t]).trim();
            if (txt && Number.isFinite(onset)) {
                out.push({ onset_s: onset, duration_s: Number.isFinite(dur) ? dur : null, text: txt });
            }
        }
        i = end + 1;
    }
}

// Returns { present, annotations:[{onset_s, duration_s, text}] } (onset in seconds from this file's start).
export async function readAnnotations(file, hdr, chunkRecords = 200) {
    const annIdx = hdr.labels
        .map((l, i) => (l.trim() === "EDF Annotations" ? i : -1))
        .filter((i) => i >= 0);
    if (!annIdx.length) return { present: false, annotations: [] };

    const nRec = hdr.declared === -1 ? hdr.present : hdr.declared;
    const utf8 = new TextDecoder("utf-8");
    const spans = annIdx.map((ai) => ({
        off: hdr.spr.slice(0, ai).reduce((a, b) => a + b, 0) * 2,
        len: hdr.spr[ai] * 2,
    }));
    const out = [];
    for (let r = 0; r < nRec; r += chunkRecords) {
        const k = Math.min(chunkRecords, nRec - r);
        const start = hdr.headerBytes + r * hdr.recBytes;
        const buf = new Uint8Array(await file.slice(start, start + k * hdr.recBytes).arrayBuffer());
        for (let j = 0; j < k; j++) {
            const recBase = j * hdr.recBytes;
            for (const sp of spans) {
                parseTALs(buf.subarray(recBase + sp.off, recBase + sp.off + sp.len), utf8, out);
            }
        }
    }
    out.sort((a, b) => a.onset_s - b.onset_s);
    return { present: true, annotations: out };
}
