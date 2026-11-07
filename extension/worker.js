// Runs code for the visualizer, off the page's thread (a run that never ends is stopped by terminating this worker): Python with
// tracer.py, JavaScript with tracer.js (which needs no Python, so Pyodide is only started for Python).
// Pyodide (CPython 3.14 in WebAssembly, MPL-2.0) ships in vendor/pyodide: an extension may not load code from the network. It only runs in
// a module worker (its classic build throws "Classic web workers are not supported"), so this file is one.
// Protocol: the page posts { id, lang: "python" | "javascript", mode: "trace" | "suggest", code, driver, text } and gets back { id, json }
// or { id, error }.
import { loadPyodide } from "./vendor/pyodide/pyodide.mjs";
import { run as runJs } from "./tracer.js";

let ready = null;
const start = () =>
  (ready ||= (async () => {
    const py = await loadPyodide();
    py.runPython(await (await fetch("tracer.py")).text());
    return py.globals.get("run"); // one proxy for the worker's life (a proxy per call would leak)
  })().catch((e) => {
    ready = null; // a failed start is tried again on the next run
    throw e;
  }));

onmessage = async ({ data: { id, lang, mode, code, driver, text } }) => {
  try {
    if (lang === "javascript") return postMessage({ id, json: JSON.stringify(runJs(code, driver || "", mode)) });
    const run = await start();
    postMessage({ id, json: run(code, driver || "", text || "", mode) });
  } catch (err) {
    postMessage({ id, error: String(err && err.message ? err.message : err).slice(-600) });
  }
};
