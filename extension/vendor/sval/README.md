# vendor/sval

Sval 0.6.12 (a JavaScript interpreter written in JavaScript, MIT, see LICENSE; acorn is bundled in), used by `tracer.js` to run JavaScript
step by step: extension pages may not `eval`, and an interpreter needs no `eval`. `sval.mjs` is the package's `dist/sval.js` with three fixes (below);
`sval.d.mts` declares the part of its API `tracer.js` uses, for `npm run typecheck`.

```
npm pack sval@0.6.12 && tar xzf sval-0.6.12.tgz && cp package/dist/sval.js extension/vendor/sval/sval.mjs
```

**Fixes**, each marked `(Visualiza: ...)` in the code; `test/js-tracer.test.mjs` checks them, so updating Sval without them fails a test.

1. In Sval 0.6.12 a `finally` block's ordinary completion replaces a pending `return` from its `try`, so
`function f() { try { return 1 } finally {} }` returns `undefined`. In JavaScript a `finally` only replaces the outcome when it breaks,
continues or returns. Both try evaluators (`fr`, and `zi` for generators and async functions) are changed to do that. And as a
   pending return / break / continue is one shared object (`k.RES`, `_.LABEL`, `C.LABEL`), a call or loop inside the `finally` overwrote
   it (`try { return 1 } finally { g() }` returned what `g()` returned): its value is now put back after the `finally`.
2. A destructuring assignment to a property (`[a[i], a[j]] = [a[j], a[i]]`, `({ p: o.q } = x)`) throws "Unexpected token": the pattern
   evaluators (`q`, and `W` for generators and async functions) only take names and nested patterns. They now assign to a property too.
3. An object destructuring assignment to names (`({ a, b } = obj)`) declares new `var`s instead of assigning: inside a function the outer
   `a` is left unchanged, at the top level it throws "already declared". The object pattern (`ar`, `Mi`) now assigns when it isn't
   declaring, as the array pattern already does; the one caller that relied on the old default, a destructured `catch` parameter, now
   says it declares.
