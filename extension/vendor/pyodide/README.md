# vendor/pyodide

Pyodide 314.0.7 (CPython 3.14 compiled to WebAssembly, MPL-2.0, see LICENSE), used by `worker.js` to run code step by step for the
visualizer, and by `check.mjs` (Node) to test the tracer in the same Python. Extensions may not load code from the network, so it ships
here. Files are copied unchanged from the `pyodide` npm package:

```
npm pack pyodide@314.0.7 && tar xzf pyodide-314.0.7.tgz
cp package/{pyodide.mjs,pyodide.asm.mjs,pyodide.asm.wasm,python_stdlib.zip,pyodide-lock.json} extension/vendor/pyodide/
cp package/pyodide.d.ts extension/vendor/pyodide/pyodide.d.mts   # its types, for `npm run typecheck` (the name TypeScript looks for next to a .mjs)
```

It runs in a module worker (the classic build throws "Classic web workers are not supported") and needs only `'wasm-unsafe-eval'` in
the extension's CSP, not `'unsafe-eval'`.
