// Test helper: the tracer (extension/tracer.py) in the Pyodide the extension ships (vendor/pyodide, CPython 3.14), loaded once per file.
import { readFile } from "node:fs/promises";

export const ext = (f) => new URL(`../extension/${f}`, import.meta.url);

const { loadPyodide } = await import(ext("vendor/pyodide/pyodide.mjs").href);
const py = await loadPyodide();
py.runPython(await readFile(ext("tracer.py"), "utf8"));
const run = py.globals.get("run");

/** The full result of a run, as the panel gets it. An empty input runs a script, or a suggested call. */
export const trace = (code, driver = "") => JSON.parse(run(code, driver, "", "trace"));
/** The call suggested for code that only defines things; `text` may name example values (nums=[2,7]). */
export const suggest = (code, text = "") => JSON.parse(run(code, "", text, "suggest"));
/** A variable's encoded value in a step (the top frame by default). */
export const local = (step, name, depth = -1) => step.stack.at(depth).loc.find(([k]) => k === name)?.[1];
