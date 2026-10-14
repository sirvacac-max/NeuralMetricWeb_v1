// wwwroot/js/charts.js
// Lightweight, dependency-free SVG charts. Theme-aware (reads CSS tokens) and responsive.
const registry = new Map();   // elId -> { el, draw, lastWidth }
let pickRef = null;
export function setPick(ref) { pickRef = ref; }
export function saveOrder(v) { try { localStorage.setItem("nmw-chartorder", v); } catch (e) { } }
export function loadOrder() { try { return localStorage.getItem("nmw-chartorder") || ""; } catch (e) { return ""; } }

function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function palette() {
    return {
        ink: cssVar("--ink"), ink2: cssVar("--ink-2"), ink3: cssVar("--ink-3"),
        line: cssVar("--line"), lineStrong: cssVar("--line-strong"),
        surface: cssVar("--surface"), surface2: cssVar("--surface-2"),
        accent: cssVar("--accent"), accentWash: cssVar("--accent-wash"),
    };
}

function niceTicks(min, max, n) {
    const span = (max - min) || 1;
    const step0 = span / n;
    const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const norm = step0 / mag;
    const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
    const start = Math.ceil(min / step) * step;
    const out = [];
    for (let v = start; v <= max + 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6);
    return out;
}

function esc(t) { return String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;"); }

function drawLineChart(el, cfg) {
    const W = Math.max(el.clientWidth || 640, 240);
    const H = cfg.height || 260;
    const m = { t: 16, r: (cfg.rightPad != null ? cfg.rightPad : 16), b: 34, l: 48 };
    const c = palette();
    const pw = W - m.l - m.r, ph = H - m.t - m.b;
    const { xMin, xMax, yMin, yMax } = cfg;
    const sx = v => m.l + (v - xMin) / ((xMax - xMin) || 1) * pw;
    const sy = v => m.t + (1 - (v - yMin) / ((yMax - yMin) || 1)) * ph;

    let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" role="img" aria-label="${esc(cfg.aria || "chart")}">`;

    for (const b of (cfg.bands || [])) {
        const x0 = sx(Math.max(b.x0, xMin)), x1 = sx(Math.min(b.x1, xMax));
        const bf = b.color ? (b.color.startsWith("--") ? cssVar(b.color) : b.color) : c.accentWash;
        const ba = (b.alpha != null) ? b.alpha : 1;
        s += `<rect x="${x0.toFixed(1)}" y="${m.t}" width="${Math.max(0, x1 - x0).toFixed(1)}" height="${ph}" fill="${bf}" fill-opacity="${ba}"/>`;
        if (b.label) s += `<text x="${(x0 + 4).toFixed(1)}" y="${m.t + 11}" font-size="9" fill="${c.ink3}">${esc(b.label)}</text>`;
    }

    for (const t of niceTicks(yMin, yMax, 4)) {
        const y = sy(t);
        s += `<line x1="${m.l}" y1="${y.toFixed(1)}" x2="${m.l + pw}" y2="${y.toFixed(1)}" stroke="${c.line}" stroke-width="1"/>`;
        s += `<text x="${m.l - 8}" y="${(y + 3).toFixed(1)}" font-size="10" text-anchor="end" fill="${c.ink3}">${cfg.yFmt ? cfg.yFmt(t) : t}</text>`;
    }
    for (const b of (cfg.yBands || [])) {
        const topY = sy(Math.min(b.y1, yMax)), botY = sy(Math.max(b.y0, yMin));
        s += `<rect x="${m.l}" y="${topY.toFixed(1)}" width="${pw}" height="${Math.max(0, botY - topY).toFixed(1)}" fill="${b.color || c.ink3}" fill-opacity="0.08"/>`;
        s += `<line x1="${m.l}" y1="${sy(b.y1).toFixed(1)}" x2="${m.l + pw}" y2="${sy(b.y1).toFixed(1)}" stroke="${b.color || c.ink3}" stroke-width="1" stroke-dasharray="2 3" opacity="0.55"/>`;
        s += `<line x1="${m.l}" y1="${sy(b.y0).toFixed(1)}" x2="${m.l + pw}" y2="${sy(b.y0).toFixed(1)}" stroke="${b.color || c.ink3}" stroke-width="1" stroke-dasharray="2 3" opacity="0.55"/>`;
        s += `<text x="${(m.l + 5).toFixed(1)}" y="${(sy(b.y1) - 4).toFixed(1)}" font-size="9" fill="${c.ink3}">${b.y1}</text>`;
        s += `<text x="${(m.l + 5).toFixed(1)}" y="${(sy(b.y0) + 11).toFixed(1)}" font-size="9" fill="${c.ink3}">${b.y0}</text>`;
    }
    for (const t of niceTicks(xMin, xMax, 6)) {
        const x = sx(t);
        s += `<text x="${x.toFixed(1)}" y="${m.t + ph + 18}" font-size="10" text-anchor="middle" fill="${c.ink3}">${cfg.xFmt ? cfg.xFmt(t) : t}</text>`;
    }
    if (cfg.yLabel) s += `<text x="${m.l}" y="${m.t - 5}" font-size="10" fill="${c.ink3}">${esc(cfg.yLabel)}</text>`;
    if (cfg.xLabel) s += `<text x="${m.l + pw}" y="${H - 4}" font-size="10" text-anchor="end" fill="${c.ink3}">${esc(cfg.xLabel)}</text>`;

    for (const mk of (cfg.markers || [])) {
        if (mk.x == null) continue;
        const x = sx(mk.x);
        const ms = mk.color ? (mk.color.startsWith("--") ? cssVar(mk.color) : mk.color) : c.ink3;
        s += `<line x1="${x.toFixed(1)}" y1="${m.t}" x2="${x.toFixed(1)}" y2="${m.t + ph}" stroke="${ms}" stroke-width="1.5" stroke-dasharray="4 3"/>`;
        if (mk.label) s += `<text x="${(x + 4).toFixed(1)}" y="${m.t + 11}" font-size="9" fill="${ms}">${esc(mk.label)}</text>`;
    }

    if (cfg.bars && cfg.series.length) {
        const ser0b = cfg.series[0];
        const bw = Math.max(1, (cfg.barBinMin || 1) / ((xMax - xMin) || 1) * pw * 0.85);
        const base = sy(Math.max(yMin, 0));
        const bc = ser0b.color ? (ser0b.color.startsWith("--") ? cssVar(ser0b.color) : ser0b.color) : c.accent;
        const bo = (cfg.barOpacity != null) ? cfg.barOpacity : 0.85;
        for (let i = 0; i < cfg.x.length; i++) {
            const yv = ser0b.y[i];
            if (yv == null || !isFinite(yv)) continue;
            const X = sx(cfg.x[i]), Y = sy(yv);
            s += `<rect x="${(X - bw / 2).toFixed(1)}" y="${Math.min(Y, base).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.abs(base - Y).toFixed(1)}" fill="${bc}" fill-opacity="${bo}"/>`;
        }
    }

    for (const ser of (cfg.bars ? [] : cfg.series)) {
        let d = "", pen = false;
        for (let i = 0; i < cfg.x.length; i++) {
            const yv = ser.y[i];
            if (yv == null || !isFinite(yv)) { pen = false; continue; }
            const X = sx(cfg.x[i]).toFixed(1), Y = sy(yv).toFixed(1);
            d += pen ? ` L${X} ${Y}` : ` M${X} ${Y}`;
            pen = true;
        }
        const sc = ser.color ? (ser.color.startsWith("--") ? cssVar(ser.color) : ser.color) : c.accent;
        const lw = cfg.lineWidth || 2;
        const lo = (cfg.lineOpacity != null) ? cfg.lineOpacity : 1;
        s += `<path d="${d}" fill="none" stroke="${sc}" stroke-width="${lw}" stroke-opacity="${lo}" stroke-linejoin="round" stroke-linecap="round"/>`;
    }

    s += `<line class="cx" x1="0" y1="${m.t}" x2="0" y2="${m.t + ph}" stroke="${c.ink3}" stroke-width="1" style="opacity:0"/>`;
    s += `<circle class="cdot" r="3.5" fill="${c.accent}" stroke="${c.surface}" stroke-width="1.5" style="opacity:0"/>`;
    s += `<rect class="hit" x="${m.l}" y="${m.t}" width="${pw}" height="${ph}" fill="transparent"/>`;
    s += `</svg>`;
    el.innerHTML = s;

    let tip = el.querySelector(".chart-tip");
    if (!tip) { tip = document.createElement("div"); tip.className = "chart-tip"; el.appendChild(tip); }

    const svg = el.querySelector("svg");
    const cx = svg.querySelector(".cx"), cdot = svg.querySelector(".cdot"), hit = svg.querySelector(".hit");
    const multi = cfg.series.length > 1;

    hit.addEventListener("pointermove", (ev) => {
        const r = svg.getBoundingClientRect();
        const px = (ev.clientX - r.left) * (W / r.width);
        let best = -1, bd = 1e9;
        for (let i = 0; i < cfg.x.length; i++) {
            if (!cfg.series.some(se => se.y[i] != null && isFinite(se.y[i]))) continue;
            const d = Math.abs(sx(cfg.x[i]) - px);
            if (d < bd) { bd = d; best = i; }
        }
        if (best < 0) return;
        const X = sx(cfg.x[best]);
        cx.setAttribute("x1", X); cx.setAttribute("x2", X); cx.style.opacity = .6;
        tip.style.opacity = 1;
        let Ytop = m.t + ph;
        if (!multi) {
            const yv = cfg.series[0].y[best];
            if (yv != null && isFinite(yv)) {
                const Y = sy(yv); Ytop = Y;
                cdot.setAttribute("cx", X); cdot.setAttribute("cy", Y); cdot.style.opacity = 1;
            } else { cdot.style.opacity = 0; }
            tip.innerHTML = `<b>${cfg.tipX ? cfg.tipX(cfg.x[best]) : cfg.x[best]}</b> &middot; ${cfg.tipY ? cfg.tipY(yv) : yv}`;
        } else {
            cdot.style.opacity = 0;
            let html = `<b>${cfg.tipX ? cfg.tipX(cfg.x[best]) : cfg.x[best]}</b>`;
            for (const se of cfg.series) {
                const yv = se.y[best];
                if (yv == null || !isFinite(yv)) continue;
                const col = se.color ? (se.color.startsWith("--") ? cssVar(se.color) : se.color) : c.accent;
                const lab = se.label ? `${esc(se.label)} ` : "";
                html += `<br><span style="color:${col}">&#9679;</span> ${lab}${cfg.tipY ? cfg.tipY(yv) : yv}`;
            }
            tip.innerHTML = html;
        }
        const ex = X * (r.width / W), ey = Ytop * (r.height / H);
        tip.style.left = Math.max(2, Math.min(ex + 10, r.width - tip.offsetWidth - 6)) + "px";
        tip.style.top = Math.max(2, ey - 30) + "px";
    });
    hit.addEventListener("pointerleave", () => {
        cx.style.opacity = 0; cdot.style.opacity = 0; tip.style.opacity = 0;
    });

    if (cfg.pickable && pickRef) {
        hit.style.cursor = "crosshair";
        hit.addEventListener("click", (ev) => {
            const r = svg.getBoundingClientRect();
            const px = (ev.clientX - r.left) * (W / r.width);
            let tv = xMin + (px - m.l) / (pw || 1) * (xMax - xMin);
            tv = Math.max(xMin, Math.min(xMax, tv));
            try { pickRef.invokeMethodAsync("OnChartPick", tv); } catch (e) { }
        });
    }

    const inst = registry.get(el.id);
    if (inst) inst.lastWidth = W;
}

function register(el, draw) {
    const prev = registry.get(el.id);
    if (prev && prev.ro) prev.ro.disconnect();
    const inst = { el, draw, lastWidth: 0 };
    registry.set(el.id, inst);
    draw();
    if (typeof ResizeObserver !== "undefined") {
        inst.ro = new ResizeObserver(() => {
            if (Math.abs(el.clientWidth - inst.lastWidth) > 1) draw();
        });
        inst.ro.observe(el);
    }
}

export function renderComposite(elId, data) {
    const el = document.getElementById(elId);
    if (!el || !data || !data.time || data.time.length === 0) return;
    el.style.position = "relative";
    const series = [{ y: data.composite, label: (data.selfLabel || null) }];
    if (data.deviceBis) series.push({ y: data.deviceBis, color: "--ink-3", label: (data.deviceLabel || "BIS (device)") });
    const cfg = {
        x: data.time,
        series,
        xMin: 0, xMax: (data.xMax != null ? data.xMax : Math.max.apply(null, data.time)),
        rightPad: data.rightPad,
        yMin: 0, yMax: 100,
        yLabel: (data.labels && data.labels.y) || "composite (0-100)", xLabel: (data.labels && data.labels.x) || "time (min)",
        aria: "pEEG composite over the session",
        yFmt: v => `${Math.round(v)}`,
        xFmt: v => `${Math.round(v)}`,
        tipX: v => `${v.toFixed(1)} min`,
        tipY: v => `${Math.round(v)}`,
        bands: data.window ? [{ x0: data.window[0], x1: data.window[1], label: (data.labels && data.labels.window) || "Analyzed window" }] : [],
        yBands: [{ y0: 40, y1: 60, label: "anaesthesia 40-60" }],
        markers: data.markers || [],
        pickable: true,
    };
    register(el, () => drawLineChart(el, cfg));
}

function redrawAll() { for (const inst of registry.values()) { try { inst.draw(); } catch (e) { } } }
new MutationObserver(redrawAll).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
try { matchMedia("(prefers-color-scheme: dark)").addEventListener("change", redrawAll); } catch (e) { }


// ---- DSA spectrogram (canvas heatmap) ----
function viridis(t) {
    t = Math.max(0, Math.min(1, t));
    const stops = [[0.0, [68, 1, 84]], [0.25, [59, 82, 139]], [0.5, [33, 145, 140]], [0.75, [94, 201, 98]], [1.0, [253, 231, 37]]];
    for (let i = 1; i < stops.length; i++) {
        if (t <= stops[i][0]) {
            const a = stops[i - 1], b = stops[i];
            const f = (t - a[0]) / ((b[0] - a[0]) || 1);
            return [Math.round(a[1][0] + f * (b[1][0] - a[1][0])),
                    Math.round(a[1][1] + f * (b[1][1] - a[1][1])),
                    Math.round(a[1][2] + f * (b[1][2] - a[1][2]))];
        }
    }
    return stops[stops.length - 1][1];
}

function pctile(sorted, p) {
    if (!sorted.length) return 0;
    const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
    return sorted[i];
}

function drawDSA(el, data, labels) {
    const c = palette();
    const W = Math.max(el.clientWidth || 640, 260);
    const H = 300;
    const m = { t: 16, r: 70, b: 34, l: 48 };
    const pw = W - m.l - m.r, ph = H - m.t - m.b;
    const nBins = data.power_db.length, freqs = data.freq_hz, nF = freqs.length;

    const vals = [];
    for (const col of data.power_db) if (col) for (const v of col) if (isFinite(v)) vals.push(v);
    vals.sort((a, b) => a - b);
    const lo = pctile(vals, 0.02), hi = pctile(vals, 0.98), span = (hi - lo) || 1;

    const off = document.createElement("canvas"); off.width = nBins; off.height = nF;
    const img = off.getContext("2d").createImageData(nBins, nF);
    for (let k = 0; k < nBins; k++) {
        const col = data.power_db[k], st = data.column_status[k];
        for (let i = 0; i < nF; i++) {
            const row = nF - 1 - i, o = (row * nBins + k) * 4;
            let rgb, a = 255;
            if (col) rgb = viridis((col[i] - lo) / span);
            else if (st === "rejected") { rgb = [150, 150, 150]; a = 80; }
            else { rgb = [0, 0, 0]; a = 0; }
            img.data[o] = rgb[0]; img.data[o + 1] = rgb[1]; img.data[o + 2] = rgb[2]; img.data[o + 3] = a;
        }
    }
    off.getContext("2d").putImageData(img, 0, 0);

    let cv = el.querySelector("canvas");
    if (!cv) { cv = document.createElement("canvas"); el.appendChild(cv); }
    cv.width = W; cv.height = H; cv.style.width = "100%"; cv.style.height = H + "px"; cv.style.display = "block";
    const ctx = cv.getContext("2d");
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = c.surface2; ctx.fillRect(m.l, m.t, pw, ph);
    ctx.imageSmoothingEnabled = false;
    const dataMax = data.time_min[data.time_min.length - 1] + data.bin_s / 120;
    const xMax = (labels && labels.xMax) ? labels.xMax : dataMax;
    const imgW = dataMax / (xMax || 1) * pw;
    ctx.drawImage(off, 0, 0, nBins, nF, m.l, m.t, imgW, ph);

    ctx.fillStyle = c.ink3; ctx.strokeStyle = c.line; ctx.font = "10px system-ui, sans-serif";
    ctx.textAlign = "center";
    for (const t of niceTicks(0, xMax, 6)) ctx.fillText(String(Math.round(t)), m.l + t / (xMax || 1) * pw, m.t + ph + 16);
    const fmin = freqs[0], fmax = freqs[freqs.length - 1];
    ctx.textAlign = "end";
    for (const fq of niceTicks(fmin, fmax, 5)) ctx.fillText(String(Math.round(fq)), m.l - 8, m.t + (1 - (fq - fmin) / ((fmax - fmin) || 1)) * ph + 3);
    ctx.textAlign = "start"; ctx.fillText((labels && labels.y) || "Hz", m.l, m.t - 5);
    ctx.textAlign = "end"; ctx.fillText((labels && labels.x) || "time (min)", m.l + pw, H - 4);

    // Frequency-band overlay (educational): boundary lines + band-name pills.
    ctx.save();
    const yOf = (fq) => m.t + (1 - (fq - fmin) / ((fmax - fmin) || 1)) * ph;
    for (const bnd of [4, 8, 12]) {
        if (bnd > fmin && bnd < fmax) {
            const y = yOf(bnd);
            ctx.setLineDash([]);
            ctx.strokeStyle = "rgba(0,0,0,0.55)"; ctx.lineWidth = 2.5;
            ctx.beginPath(); ctx.moveTo(m.l, y); ctx.lineTo(m.l + pw, y); ctx.stroke();
            ctx.strokeStyle = "rgba(255,255,255,0.92)"; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
            ctx.beginPath(); ctx.moveTo(m.l, y); ctx.lineTo(m.l + pw, y); ctx.stroke();
        }
    }
    ctx.setLineDash([]);
    ctx.font = "10px system-ui, sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    for (const bd of [["Delta", 0.5, 4], ["Theta", 4, 8], ["Alpha", 8, 12], ["Beta", 12, 30]]) {
        const yc = yOf((Math.max(bd[1], fmin) + Math.min(bd[2], fmax)) / 2);
        const tw = ctx.measureText(bd[0]).width;
        ctx.fillStyle = "rgba(0,0,0,0.5)";
        if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(m.l + 5, yc - 8, tw + 8, 16, 4); ctx.fill(); }
        else { ctx.fillRect(m.l + 5, yc - 8, tw + 8, 16); }
        ctx.fillStyle = "#fff"; ctx.fillText(bd[0], m.l + 9, yc + 0.5);
    }
    ctx.restore();

    // SEF95 trend overlay (white line over the spectrogram)
    if (data.sef95_hz && (labels && labels.sef !== false)) {
        const sef = data.sef95_hz;
        ctx.save();
        ctx.lineJoin = "round"; ctx.lineCap = "round";
        let seg = [];
        const flush = () => {
            if (seg.length < 1) return;
            ctx.strokeStyle = "rgba(0,0,0,0.5)"; ctx.lineWidth = 3.5;
            ctx.beginPath(); seg.forEach((pt, i) => i ? ctx.lineTo(pt[0], pt[1]) : ctx.moveTo(pt[0], pt[1])); ctx.stroke();
            ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 1.6;
            ctx.beginPath(); seg.forEach((pt, i) => i ? ctx.lineTo(pt[0], pt[1]) : ctx.moveTo(pt[0], pt[1])); ctx.stroke();
        };
        let lastPt = null;
        for (let k = 0; k < sef.length; k++) {
            const v = sef[k];
            if (v == null) { flush(); seg = []; continue; }
            const x = m.l + data.time_min[k] / (xMax || 1) * pw;
            const y = yOf(Math.max(fmin, Math.min(fmax, v)));
            seg.push([x, y]); lastPt = [x, y];
        }
        flush();
        if (lastPt) {
            const lbl = (labels && labels.sefLabel) || "SEF95";
            ctx.font = "10px system-ui, sans-serif"; ctx.textBaseline = "middle"; ctx.textAlign = "left";
            const tw = ctx.measureText(lbl).width;
            const lx = Math.min(lastPt[0] + 6, m.l + pw - tw - 10), ly = lastPt[1];
            ctx.fillStyle = "rgba(0,0,0,0.55)";
            if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(lx - 3, ly - 8, tw + 6, 16, 4); ctx.fill(); }
            else ctx.fillRect(lx - 3, ly - 8, tw + 6, 16);
            ctx.fillStyle = "#fff"; ctx.fillText(lbl, lx, ly + 0.5);
        }
        ctx.restore();
    }

    const cbx = W - m.r + 20, cbw = 12, cbh = ph;
    const grad = ctx.createLinearGradient(0, m.t + cbh, 0, m.t);
    for (let i = 0; i <= 10; i++) { const rgb = viridis(i / 10); grad.addColorStop(i / 10, `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`); }
    ctx.fillStyle = grad; ctx.fillRect(cbx, m.t, cbw, cbh);
    ctx.strokeStyle = c.line; ctx.strokeRect(cbx, m.t, cbw, cbh);
    ctx.fillStyle = c.ink3; ctx.textAlign = "start";
    ctx.fillText(hi.toFixed(0), cbx + cbw + 4, m.t + 8);
    ctx.fillText(lo.toFixed(0), cbx + cbw + 4, m.t + cbh);
    ctx.fillText("dB", cbx, m.t - 5);

    let tip = el.querySelector(".chart-tip");
    if (!tip) { tip = document.createElement("div"); tip.className = "chart-tip"; el.appendChild(tip); }
    cv.onpointermove = (ev) => {
        const r = cv.getBoundingClientRect();
        const px = (ev.clientX - r.left) * (W / r.width), py = (ev.clientY - r.top) * (H / r.height);
        if (px < m.l || px > m.l + pw || py < m.t || py > m.t + ph) { tip.style.opacity = 0; return; }
        const k = Math.min(nBins - 1, Math.max(0, Math.floor((px - m.l) / (imgW || pw) * nBins)));
        const fi = Math.min(nF - 1, Math.max(0, Math.round((1 - (py - m.t) / ph) * (nF - 1))));
        const col = data.power_db[k], st = data.column_status[k];
        const val = col ? `${col[fi].toFixed(1)} dB` : ((labels && (st === "rejected" ? labels.rejected : labels.noData)) || st);
        tip.style.opacity = 1;
        tip.innerHTML = `<b>${data.time_min[k].toFixed(1)} min</b> &middot; ${freqs[fi].toFixed(1)} Hz &middot; ${val}`;
        const ex = px * (r.width / W), ey = py * (r.height / H);
        tip.style.left = Math.max(2, Math.min(ex + 10, r.width - tip.offsetWidth - 6)) + "px";
        tip.style.top = Math.max(2, ey - 30) + "px";
    };
    cv.onpointerleave = () => { tip.style.opacity = 0; };
    if (pickRef) {
        cv.style.cursor = "crosshair";
        cv.onclick = (ev) => {
            const r = cv.getBoundingClientRect();
            const px = (ev.clientX - r.left) * (W / r.width);
            let tv = (px - m.l) / (pw || 1) * xMax;
            tv = Math.max(0, Math.min(xMax, tv));
            try { pickRef.invokeMethodAsync("OnChartPick", tv); } catch (e) { }
        };
    }

    const inst = registry.get(el.id); if (inst) inst.lastWidth = W;
}

export function renderDSA(elId, data, labels) {
    const el = document.getElementById(elId);
    if (!el || !data || !data.power_db || !data.freq_hz || data.freq_hz.length === 0) return;
    el.style.position = "relative";
    register(el, () => drawDSA(el, data, labels));
}

// ---- PSD (power spectrum) line chart with absolute(dB)/relative(%) toggle ----
export function renderPSD(elId, data, opts) {
    const el = document.getElementById(elId);
    if (!el || !data || !data.freq_hz || data.freq_hz.length === 0) return;
    el.style.position = "relative";
    const mode = (opts && opts.mode) || "db";
    const lab = (opts && opts.labels) || {};
    const f = data.freq_hz, P = data.power_uv2_hz;

    let y, yLabel, yFmt, tipY, yMin, yMax;
    if (mode === "rel") {
        const tot = P.reduce((a, b) => a + b, 0) || 1;
        y = P.map(v => 100 * v / tot);
        yMin = 0; yMax = Math.max.apply(null, y) * 1.08;
        yLabel = lab.yRel || "% of total (per bin)";
        yFmt = v => `${v.toFixed(1)}`;
        tipY = v => `${v.toFixed(2)} %`;
    } else {
        y = P.map(v => v > 0 ? 10 * Math.log10(v) : null);
        const vals = y.filter(v => v != null);
        yMin = Math.floor(Math.min.apply(null, vals) / 5) * 5;
        yMax = Math.ceil(Math.max.apply(null, vals) / 5) * 5;
        yLabel = lab.yDb || "dB re uV2/Hz";
        yFmt = v => `${Math.round(v)}`;
        tipY = v => `${v.toFixed(1)} dB`;
    }

    const bandDefs = [["Delta", "--delta", 0.5, 4], ["Theta", "--theta", 4, 8], ["Alpha", "--alpha", 8, 12], ["Beta", "--beta", 12, 30]];
    const bands = bandDefs.map(b => ({ x0: b[2], x1: b[3], color: b[1], alpha: 0.13, label: b[0] }));
    const markers = (data.sef95 != null) ? [{ x: data.sef95, label: `SEF95 ${data.sef95.toFixed(1)} Hz`, color: "--accent" }] : [];

    const cfg = {
        x: f, series: [{ y }],
        xMin: f[0], xMax: f[f.length - 1],
        yMin, yMax, yLabel, xLabel: lab.x || "Hz",
        aria: "power spectral density",
        yFmt, xFmt: v => `${Math.round(v)}`,
        tipX: v => `${v.toFixed(1)} Hz`, tipY,
        bands, markers,
    };
    register(el, () => drawLineChart(el, cfg));
}


// ---- Band power over time (Delta/Theta/Alpha/Beta trend), y-axis toggle dB/% ----
export function renderBandTrend(elId, data, opts) {
    const el = document.getElementById(elId);
    if (!el || !data || !data.time_min || data.time_min.length === 0) return;
    el.style.position = "relative";
    const mode = (opts && opts.mode) || "db";
    const lab = (opts && opts.labels) || {};
    const t = data.time_min;
    const core = data.bands || ["Delta", "Theta", "Alpha", "Beta"];
    const colors = { Delta: "--delta", Theta: "--theta", Alpha: "--alpha", Beta: "--beta" };
    const binS = data.bin_s || 30;

    // Centered rolling median (~5 min window) in the power domain, gap-aware.
    const half = Math.max(1, Math.round(150 / binS));   // ~2.5 min each side
    const rmed = (arr) => {
        const out = new Array(arr.length).fill(null);
        for (let i = 0; i < arr.length; i++) {
            const v = [];
            const a = Math.max(0, i - half), b = Math.min(arr.length - 1, i + half);
            for (let j = a; j <= b; j++) { const x = arr[j]; if (x != null && isFinite(x)) v.push(x); }
            if (v.length) { v.sort((p, q) => p - q); const m = v.length >> 1; out[i] = v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; }
        }
        return out;
    };
    const sabs = {};
    for (const b of core) sabs[b] = rmed(data.abs_uv2[b]);
    const stot = rmed(data.total_uv2);

    let series, yMin, yMax, yLabel, yFmt, tipY;
    if (mode === "rel") {
        series = core.map(b => ({
            label: b, color: colors[b],
            y: sabs[b].map((v, i) => (v != null && stot[i] != null && stot[i] > 0) ? 100 * v / stot[i] : null)
        }));
        let mx = 0;
        for (const se of series) for (const v of se.y) if (v != null && v > mx) mx = v;
        yMin = 0; yMax = Math.min(100, Math.ceil(mx / 10) * 10 + 5) || 100;
        yLabel = lab.yRel || "% of total";
        yFmt = v => `${Math.round(v)}`;
        tipY = v => `${v.toFixed(1)} %`;
    } else {
        series = core.map(b => ({
            label: b, color: colors[b],
            y: sabs[b].map(v => (v != null && v > 0) ? 10 * Math.log10(v) : null)
        }));
        const vals = [];
        for (const se of series) for (const v of se.y) if (v != null && isFinite(v)) vals.push(v);
        yMin = Math.floor(Math.min.apply(null, vals) / 5) * 5;
        yMax = Math.ceil(Math.max.apply(null, vals) / 5) * 5;
        yLabel = lab.yDb || "dB (uV2)";
        yFmt = v => `${Math.round(v)}`;
        tipY = v => `${v.toFixed(1)} dB`;
    }

    const xMax = (opts && opts.xMax != null) ? opts.xMax : (t[t.length - 1] + binS / 120);
    const cfg = {
        x: t, series,
        xMin: 0, xMax,
        rightPad: (opts && opts.rightPad != null) ? opts.rightPad : 16,
        yMin, yMax, yLabel, xLabel: lab.x || "time (min)",
        lineWidth: 1.5, lineOpacity: 0.9, pickable: true,
        aria: "band power over time",
        yFmt, xFmt: v => `${Math.round(v)}`,
        tipX: v => `${v.toFixed(1)} min`, tipY,
    };
    register(el, () => drawLineChart(el, cfg));
}


// ---- Burst-suppression ratio over time (per-minute %, shared timeline) ----
export function renderBsr(elId, data, opts) {
    const el = document.getElementById(elId);
    if (!el || !data || !data.time_min || data.time_min.length === 0) return;
    el.style.position = "relative";
    const lab = (opts && opts.labels) || {};
    const t = data.time_min, y = data.pct_per_min;
    const xMax = (opts && opts.xMax != null) ? opts.xMax : (t[t.length - 1] + 0.5);
    const binMin = data.bin_s ? data.bin_s / 60 : 1;

    const bands = (opts && opts.window && opts.window.length === 2)
        ? [{ x0: opts.window[0], x1: opts.window[1], color: "--accent-wash", alpha: 1,
             label: (opts && opts.windowLabel) || null }] : [];
    const markers = (opts && opts.transition != null)
        ? [{ x: opts.transition, color: "--ink-3", label: (opts && opts.transitionLabel) || null }] : [];

    const cfg = {
        x: t, series: [{ y, color: "--bsr" }],
        bars: true, barBinMin: binMin, barOpacity: 0.9,
        xMin: 0, xMax, yMin: 0, yMax: 100,
        rightPad: (opts && opts.rightPad != null) ? opts.rightPad : 16,
        yLabel: lab.y || "BSR (%)", xLabel: lab.x || "time (min)",
        pickable: true,
        aria: "burst suppression ratio over time",
        yFmt: v => `${Math.round(v)}`, xFmt: v => `${Math.round(v)}`,
        tipX: v => `${v.toFixed(1)} min`, tipY: v => `${v.toFixed(1)} %`,
        bands, markers,
    };
    register(el, () => drawLineChart(el, cfg));
}


// ---- Raw EEG strip around a picked time (click any time chart to set it) ----
export function renderRaw(elId, centerMin, widthS, resUv, opts) {
    const el = document.getElementById(elId);
    if (!el) return;
    el.style.position = "relative";
    const lab = (opts && opts.labels) || {};
    const R = (typeof window !== "undefined") ? window.__nmwRaw : null;
    if (!R || !R.blocks || !R.blocks.length) {
        el.innerHTML = `<div class="chart-empty">${lab.none || "No raw EEG available."}</div>`;
        return;
    }
    const fs = R.fs;
    const c = centerMin * 60, a = c - widthS / 2, z = c + widthS / 2;
    const xs = [], ys = [];
    let lastT = null;
    for (const b of R.blocks) {
        const n = b.x.length, b0 = b.t_start, b1 = b0 + n / fs;
        if (b1 <= a || b0 >= z) continue;
        const i0 = Math.max(0, Math.floor((a - b0) * fs));
        const i1 = Math.min(n, Math.ceil((z - b0) * fs));
        for (let i = i0; i < i1; i++) {
            const tt = b0 + i / fs;
            if (lastT != null && (tt - lastT) > 1.5 / fs) { xs.push(tt - c); ys.push(null); }
            xs.push(tt - c); ys.push(b.x[i]); lastT = tt;
        }
    }
    if (!ys.some(v => v != null)) {
        el.innerHTML = `<div class="chart-empty">${lab.none || "No raw EEG at this time."}</div>`;
        return;
    }
    const cfg = {
        x: xs, series: [{ y: ys, color: "--ink-2" }],
        xMin: -widthS / 2, xMax: widthS / 2, yMin: -resUv, yMax: resUv,
        yLabel: lab.y || "µV", xLabel: lab.x || "s",
        lineWidth: 1, height: 220,
        aria: "raw EEG around the selected time",
        yFmt: v => `${Math.round(v)}`, xFmt: v => `${v}`,
        tipX: v => `${v.toFixed(2)} s`, tipY: v => `${v.toFixed(1)} µV`,
        markers: [{ x: 0, color: "--accent", label: lab.cursor || null }],
    };
    register(el, () => drawLineChart(el, cfg));
}
