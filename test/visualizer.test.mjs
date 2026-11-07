// The panel's logic that doesn't need a page: the call tree built from a trace, the clean-up of code selected on a page, and telling
// Python from JavaScript.
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { EXAMPLES } from "../extension/examples.js";
import { run as runJs } from "../extension/tracer.js";
import { callTree, clean, detectLanguage, setLanguage } from "../extension/visualizer.js";
import { trace } from "./python.mjs";

const all = (n) => [n, ...n.children.flatMap(all)];

describe("the call tree", () => {
  const r = trace("def fib(n):\n    if n < 2:\n        return n\n    return fib(n - 1) + fib(n - 2)", "fib(4)");
  const tree = callTree(r.steps);
  const top = tree.children[0];

  test("has every call the run made, under the call that made it", () => {
    assert.equal(tree.children.length, 1);
    assert.equal(all(tree).length - 1, 9); // fib(4) makes 9 calls
    assert.deepEqual(
      top.children.map((c) => c.label),
      ["fib(3)", "fib(2)"],
    );
  });

  test("knows what each call returned, and the steps where it started and ended", () => {
    assert.deepEqual([top.label, top.value, top.call, top.ret], ["fib(4)", "3", 0, r.steps.length - 1]);
    assert.deepEqual(
      top.children.map((c) => c.value),
      ["2", "1"],
    );
    assert.ok(all(top).every((n) => n.call < n.ret && n.children.every((c) => c.call > n.call && c.ret < n.ret)));
  });

  test("labels a call with its arguments only (not a closure's outer variables, not self)", () => {
    const t = callTree(trace("def outer(a):\n    z = 3\n    def inner(b):\n        return z + b\n    return inner(a)", "outer(1)").steps);
    assert.equal(t.children[0].children[0].label, "inner(1)");
    const c = callTree(trace("class C:\n    def m(self, x):\n        return x", "C().m(7)").steps);
    assert.equal(c.children[0].label, "m(7)");
  });

  test("marks a call that raised: it has no return", () => {
    const t = callTree(
      trace("def f(x):\n    return 1 // x\ndef g():\n    try:\n        f(0)\n    except ZeroDivisionError:\n        return f(1)", "g()")
        .steps,
    );
    assert.deepEqual(
      t.children[0].children.map((c) => [c.label, c.ret >= 0]),
      [
        ["f(0)", false],
        ["f(1)", true],
      ],
    );
  });

  test("hangs several first calls (a class's methods) under the input", () => {
    const t = callTree(trace("class S:\n    def push(self, x):\n        return x", "s = S()\ns.push(1)\ns.push(2)").steps);
    assert.deepEqual(
      t.children.map((c) => c.label),
      ["push(1)", "push(2)"],
    );
  });

  test("names a script's top level `global`", () => {
    assert.equal(callTree(trace("x = 1\nprint(x)").steps).children[0].label, "global");
  });
});

describe("clean(): code selected on a page", () => {
  test("loses the indentation all its lines share (a method copied out of its class)", () => {
    assert.equal(clean("    def f(x):\n        return x"), "def f(x):\n    return x");
  });

  test("turns non-breaking spaces into spaces and Windows line ends into \\n, and trims blank lines around it", () => {
    assert.equal(clean("\r\n    def f(x):\r\n        return x\u00a0+ 1\r\n\r\n    \r\n"), "def f(x):\n    return x + 1");
  });

  test("keeps blank lines inside the code, and code that isn't indented", () => {
    assert.equal(clean("a = 1\n\nb = 2"), "a = 1\n\nb = 2");
  });

  test("gives code Python runs", () => {
    assert.equal(trace(clean("\u00a0\u00a0\u00a0\u00a0def f(n):\n        return n * 2"), "f(3)").result.v, 6);
  });
});

describe("the call tree of a JavaScript run", () => {
  after(() => setLanguage("python"));

  test("labels calls with their arguments, written the JavaScript way (null, true), without this", () => {
    setLanguage("javascript");
    const t = callTree(runJs("class C {\n  m(x, y) {\n    return x === null && y;\n  }\n}", "new C().m(null, true)").steps);
    assert.deepEqual([t.children[0].label, t.children[0].value], ["m(null, true)", "true"]);
  });

  test("has every call of a recursion, and what each returned", () => {
    setLanguage("javascript");
    const t = callTree(runJs("function fib(n) {\n  return n < 2 ? n : fib(n - 1) + fib(n - 2);\n}", "fib(4)").steps);
    assert.equal(all(t).length - 1, 9);
    assert.deepEqual([t.children[0].label, t.children[0].value], ["fib(4)", "3"]);
  });
});

describe("detectLanguage(): Python or JavaScript, for code selected on a page", () => {
  for (const ex of EXAMPLES) test(`${ex.lang} example: ${ex.title}`, () => assert.equal(detectLanguage(ex.code), ex.lang));

  test("short snippets", () => {
    assert.equal(detectLanguage("def f(x):\n    return x * 2"), "python");
    assert.equal(detectLanguage("for i in range(3):\n    print(i)"), "python");
    assert.equal(detectLanguage("const f = (x) => x * 2;"), "javascript");
    assert.equal(detectLanguage("for (let i = 0; i < 3; i++) {\n  console.log(i);\n}"), "javascript");
  });

  test("a tie (nothing tells) is Python", () => assert.equal(detectLanguage("x = 1"), "python"));
});
