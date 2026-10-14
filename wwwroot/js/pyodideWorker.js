// wwwroot/js/pyodideWorker.js
// Runs Python (Pyodide) off the UI thread.
// The runtime is fetched and evaluated instead of importScripts, which fails here.

const PYODIDE_BASE = "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/";

let pyodide = null;

self.onmessage = async (event) => {
    const { type, id, payload } = event.data;

    try {
        if (type === "init") {
            if (!self.loadPyodide) {
                const src = await (await fetch(PYODIDE_BASE + "pyodide.js")).text();
                (0, eval)(src); // defines loadPyodide in the worker's global scope
            }
            pyodide = await loadPyodide({ indexURL: PYODIDE_BASE });
            await pyodide.loadPackage(["numpy", "scipy", "pandas"]);
            const src = await (await fetch("/engine/engine.py", { cache: "no-store" })).text();
            pyodide.FS.writeFile("engine.py", src);
            pyodide.runPython("import engine");
            self.postMessage({ type: "ready", id });
        }

        else if (type === "selftest") {
            const json = pyodide.runPython("import json, engine\njson.dumps(engine.self_test())");
            self.postMessage({ type: "result", id, data: JSON.parse(json) });
        }

        else if (type === "analyze") {
            const { x, fs, resolution_uv, phys_min, phys_max, preset } = payload;
            const xPy = pyodide.toPy(x);
            pyodide.globals.set("x_in", xPy);
            const json = pyodide.runPython(`
import json, engine
json.dumps(engine.run_analysis(x_in, ${Number(fs)}, ${Number(resolution_uv)},
                               ${Number(phys_min)}, ${Number(phys_max)}, "${preset || "v3_default"}"))
`);
            xPy.destroy();
            self.postMessage({ type: "result", id, data: JSON.parse(json) });
        }

        else if (type === "analyze_session") {
            const { blocks, fs, preset, window_min } = payload;
            const pyBlocks = pyodide.toPy(blocks.map((b) => ({ t_start: b.t_start, x: b.x, sat: b.sat })));
            pyodide.globals.set("blocks_in", pyBlocks);
            const win = window_min ? `(${Number(window_min[0])}, ${Number(window_min[1])})` : "None";
            const json = pyodide.runPython(`
import json, engine
json.dumps(engine.run_session(blocks_in, ${Number(fs)}, "${preset || "v3_default"}", ${win}))
`);
            pyBlocks.destroy();
            self.postMessage({ type: "result", id, data: JSON.parse(json) });
        }

        else if (type === "report") {
            const { blocks, fs, resolution_uv, preset, manual_window } = payload;
            const pyBlocks = pyodide.toPy(blocks.map((b) => ({ t_start: b.t_start, x: b.x, sat: b.sat })));
            pyodide.globals.set("blocks_in", pyBlocks);
            const win = manual_window
                ? `[${Number(manual_window[0])}, ${Number(manual_window[1])}]`
                : "None";
            const json = pyodide.runPython(`
import json, engine
json.dumps(engine.run_report(blocks_in, ${Number(fs)}, ${Number(resolution_uv)}, "${preset || "v3_default"}", ${win}),
           default=lambda o: o.item() if hasattr(o, "item") else str(o))
`);
            pyBlocks.destroy();
            self.postMessage({ type: "result", id, data: JSON.parse(json) });
        }

        else if (type === "review") {
            const { blocks, fs, resolution_uv, preset } = payload;
            const pyBlocks = pyodide.toPy(blocks.map((b) => ({ t_start: b.t_start, x: b.x, sat: b.sat })));
            pyodide.globals.set("blocks_in", pyBlocks);
            const json = pyodide.runPython(`
import json, engine
json.dumps(engine.run_review(blocks_in, ${Number(fs)}, ${Number(resolution_uv)}, "${preset || "v3_default"}"),
           default=lambda o: o.item() if hasattr(o, "item") else str(o))
`);
            pyBlocks.destroy();
            self.postMessage({ type: "result", id, data: JSON.parse(json) });
        }

    } catch (err) {
        self.postMessage({ type: "error", id, message: String(err) });
    }
};