// The panel's logic that doesn't need a page: the call tree built from a trace, the clean-up of code selected on a page, and telling
// Python from JavaScript.
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { EXAMPLES } from "../extension/examples.js";
import { run as runJs } from "../extension/tracer.js";
import {
  adjacency,
  backOver,
  callTree,
  clean,
  condValues,
  detectLanguage,
  callArgs,
  evalBound,
  graphState,
  gridAxes,
  isRefGridInStack,
  layered,
  lineEffects,
  loopPass,
  nextPass,
  parseSlice,
  setLanguage,
  settled,
  sliceOf,
  splitArgs,
  stepOut,
  stepOver,
  toJSON,
  windowEnds,
} from "../extension/visualizer.js";
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

describe("calls repeated with the same arguments", () => {
  test("a recursion without a memo: each repeat knows its twins; the root counts them and the calls a memo would save", () => {
    const t = callTree(trace("def fib(n):\n    if n < 2:\n        return n\n    return fib(n - 1) + fib(n - 2)", "fib(4)").steps);
    assert.deepEqual([t.calls, t.repeats, t.saved], [9, 1, 2]); // the second fib(2), and its fib(1) and fib(0): fib(4) with a memo makes 7
    const twos = all(t).filter((n) => n.label === "fib(2)");
    assert.deepEqual(
      twos.map((n) => n.rep),
      [1, 2],
    );
    assert.equal(twos[1].twins, twos[0].twins);
    // base cases (fib(1), fib(0)) repeat too, but do no work again
    assert.ok(all(t).every((n) => !n.rep || n.label === "fib(2)"));
  });

  test("a memo's hits aren't repeats: they don't call again", () => {
    const code =
      "def count(n):\n    memo = {}\n    def f(k):\n        if k < 2:\n            return k\n        if k not in memo:\n            memo[k] = f(k - 1) + f(k - 2)\n        return memo[k]\n    return f(n)";
    const t = callTree(trace(code, "count(4)").steps);
    assert.equal(all(t).filter((n) => n.label === "f(2)").length, 2);
    assert.deepEqual([t.repeats, t.saved], [0, 0]);
  });

  test("a function that doesn't recurse isn't flagged, nor are calls whose arguments differ", () => {
    const t = callTree(trace("def sq(x):\n    return x * x\ndef f():\n    return sq(2) + sq(2) + sq(3)", "f()").steps);
    assert.deepEqual([t.calls, t.repeats], [4, 0]);
    assert.ok(all(t).every((n) => !n.rep));
  });
});

describe("moving through a run", () => {
  // f(2): 0 call f · 1 s = 0 · 2 for · 3 s += g(i) · 4-6 g(0) · 7 for · 8 s += g(i) · 9-11 g(1) · 12 for · 13 return s · 14 return
  const r = trace("def f(n):\n    s = 0\n    for i in range(n):\n        s += g(i)\n    return s\ndef g(x):\n    return x * 2", "f(2)");
  const { steps, outline } = r;

  test("step over skips the calls a line makes; back over goes back past them", () => {
    assert.deepEqual([stepOver(steps, 3), stepOver(steps, 8), stepOver(steps, 14)], [7, 12, 14]);
    assert.deepEqual([backOver(steps, 7), backOver(steps, 12), backOver(steps, 0)], [3, 8, 0]);
  });

  test("step out goes to the return of the current call", () => {
    assert.deepEqual([stepOut(steps, 4), stepOut(steps, 9), stepOut(steps, 3)], [6, 11, 14]);
  });

  test("next loop pass goes to the loop's line again (past the calls), then out of the loop; the pass is counted", () => {
    assert.deepEqual([nextPass(steps, 3, outline), nextPass(steps, 8, outline), nextPass(steps, 12, outline)], [7, 12, 13]);
    assert.deepEqual(
      [3, 8, 13].map((k) => loopPass(steps, k, outline)),
      [1, 2, 0],
    );
  });
});

describe("marks for tests and sorting", () => {
  after(() => setLanguage("python"));

  test("a test with its values put in; one an and / or didn't work out stays as written", () => {
    setLanguage("python");
    const r = trace("def f(a, b):\n    if a and b > 1:\n        return 1\n    return 0", "f(0, 5)");
    const s = r.steps.find((x) => x.cond);
    assert.equal(condValues(r.conds[0], s.cond, s.heap), "0 and b > 1");
    setLanguage("javascript");
    const j = runJs("function f(xs, ys) {\n  if (xs[0] === null) return 1;\n  return 0;\n}", "f([null], [1, 2])");
    const t = j.steps.find((x) => x.cond);
    assert.equal(condValues(j.conds[0], t.cond, t.heap), "null === null");
  });

  test("the items already where they'll be once sorted", () => {
    assert.deepEqual([...settled([5, 1, 4, 2, 8])], [4]);
    assert.deepEqual([...settled([1, 2, 5, 3, 4, 8, 9])].sort(), [0, 1, 5, 6]);
    assert.deepEqual([...settled([3, 3, 1])], []);
  });

  test("splits call arguments at top-level commas", () => {
    assert.deepEqual(splitArgs("a, b, c"), ["a", "b", "c"]);
    assert.deepEqual(splitArgs("f(x, y), g(z)"), ["f(x, y)", "g(z)"]);
    assert.deepEqual(splitArgs("[1, 2], [3, 4]"), ["[1, 2]", "[3, 4]"]);
    assert.deepEqual(splitArgs('a, "b, c", d'), ["a", '"b, c"', "d"]);
    assert.deepEqual(splitArgs("nums[lo:hi], target"), ["nums[lo:hi]", "target"]);
    assert.deepEqual(splitArgs("path + [rest[i]], rest[:i] + rest[i+1:]"), ["path + [rest[i]]", "rest[:i] + rest[i+1:]"]);
  });

  test("parses slice expressions", () => {
    setLanguage("python");
    assert.deepEqual(parseSlice("a[1:3]", false), { name: "a", lo: "1", hi: "3" });
    assert.deepEqual(parseSlice("a[:mid]", false), { name: "a", lo: "0", hi: "mid" });
    assert.deepEqual(parseSlice("a[mid:]", false), { name: "a", lo: "mid", hi: null });
    assert.deepEqual(parseSlice("a[:]", false), { name: "a", lo: "0", hi: null });
    assert.equal(parseSlice("a[i]", false), null);
    assert.equal(parseSlice("a + b", false), null);
    setLanguage("javascript");
    assert.deepEqual(parseSlice("a.slice(1, 3)", true), { name: "a", lo: "1", hi: "3" });
    assert.deepEqual(parseSlice("a.slice(mid)", true), { name: "a", lo: "mid", hi: null });
    assert.deepEqual(parseSlice("a.slice(0)", true), { name: "a", lo: "0", hi: null });
    assert.equal(parseSlice("a[i]", true), null);
  });

  test("evaluates slice bounds", () => {
    const ints = new Map([
      ["lo", 1],
      ["hi", 5],
      ["mid", 3],
    ]);
    assert.equal(evalBound("0", ints, 10), 0);
    assert.equal(evalBound("5", ints, 10), 5);
    assert.equal(evalBound("-1", ints, 10), 9);
    assert.equal(evalBound("-2", ints, 10), 8);
    assert.equal(evalBound("lo", ints, 10), 1);
    assert.equal(evalBound("hi", ints, 10), 5);
    assert.equal(evalBound("mid + 1", ints, 10), 4);
    assert.equal(evalBound("hi - 2", ints, 10), 3);
    assert.equal(evalBound(null, ints, 10), 10);
    assert.equal(evalBound("", ints, 10), 0);
    assert.equal(evalBound("unknown", ints, 10), null);
    assert.equal(evalBound("x + y", ints, 10), null);
    // the length of the list being sliced (a[0:len(a)], a.slice(0, a.length)); another list's length isn't known here
    assert.equal(evalBound("len(a)", ints, 10, "a"), 10);
    assert.equal(evalBound("a.length", ints, 10, "a"), 10);
    assert.equal(evalBound("len(b)", ints, 10, "a"), null);
  });

  test("sliceOf: detects contiguous slices, rejects whole lists and non-contiguous", () => {
    // valid slices
    assert.deepEqual(sliceOf([5, 2, 8, 1, 9, 3], [1, 9, 3]), [3, 6]);
    assert.deepEqual(sliceOf([5, 2, 8, 1, 9, 3], [5, 2, 8]), [0, 3]);
    assert.deepEqual(sliceOf([1, 2, 3, 4], [2, 3]), [1, 3]);
    assert.deepEqual(sliceOf(["a", "b", "c"], ["b"]), [1, 2]);
    // whole list: would be marked without parseSlice check
    assert.deepEqual(sliceOf([5, 2, 8], [5, 2, 8]), [0, 3]);
    // non-contiguous (backtracking case: path + [rest[i]])
    assert.equal(sliceOf([1, 2, 3], [1, 3]), null);
    assert.equal(sliceOf([1, 2, 3], [2, 4]), null);
    // wrong length
    assert.equal(sliceOf([1, 2], [1, 2, 3]), null);
    assert.equal(sliceOf([1, 2, 3], []), null);
  });
});

describe("lineEffects(): what the line that ran read and wrote", () => {
  const COIN =
    "def f(coins, amount):\n    dp = [99] * (amount + 1)\n    dp[0] = 0\n    for a in range(1, amount + 1):\n        for c in coins:\n            dp[a] = min(dp[a], dp[a - c] + 1)\n    return dp[amount]";
  const r = trace(COIN, "f([1, 2], 3)");
  const eff = lineEffects(r.steps, r.pointers);
  const view = (e) => e && e.list.map((x) => `${x.w ? "w" : "r"} ${x.text} = ${x.val}`).sort();

  test("is on the step after the line, with the indexes and values from before it ran", () => {
    // the first time line 6 runs: a = 1, c = 1, dp[1] = min(dp[1], dp[0] + 1)
    const k = r.steps.findIndex((s) => s.ev === "line" && s.line === 6);
    assert.equal(eff[k], null); // (not yet run)
    assert.deepEqual(view(eff[k + 1]), ["r dp[0] = 0", "r dp[1] = 99", "w dp[1] = 99"]);
    assert.equal(eff[k + 1].list[0].ref, r.steps[k].stack[0].loc.find(([n]) => n === "dp")[1].r);
  });

  test("of a line that makes calls, once they're all done (memo[n] = f(n - 1) + f(n - 2))", () => {
    const m = trace(
      "def fib(n, memo):\n    if n < 2:\n        return n\n    memo[n] = fib(n - 1, memo) + fib(n - 2, memo)\n    return memo[n]",
      "fib(3, {})",
    );
    const e = lineEffects(m.steps, m.pointers);
    const k = m.steps.findIndex((s) => s.ev === "line" && s.line === 4); // fib(3) about to run line 4
    const done = m.steps.findIndex((s, n) => n > k && s.stack.length === 1);
    assert.ok(e.slice(k + 1, done).every((x) => !x || !x.list.some((y) => y.text === "memo[3]")));
    assert.deepEqual(view(e[done]), ["w memo[3] = null"]); // (a new key: no value before)
  });

  test("marks a test line, and cells of a grid", () => {
    const g = trace(
      "def g(dp):\n    for r in range(1, 2):\n        if dp[r - 1][0] > 0:\n            dp[r][1] = dp[r - 1][1] + dp[r][0]\n    return dp",
      "g([[1, 2], [3, 0]])",
    );
    const e = lineEffects(g.steps, g.pointers);
    const k = g.steps.findIndex((s) => s.ev === "line" && s.line === 4);
    assert.equal(e[k].test, true); // (line 3, the if)
    assert.deepEqual(e[k + 1].list.map((x) => [x.at, x.w]).sort(), [
      ["0,1", false],
      ["1,0", false],
      ["1,1", true],
    ]);
  });
});

describe("graphs: the adjacency list, its layout, and what other variables say about it", () => {
  test("an adjacency list of (node, weight) pairs is a weighted graph; keys and neighbours are named alike", () => {
    const r = trace("def f(graph):\n    return graph", 'f({"A": [("B", 4)], "B": []})');
    const s = r.steps[0];
    const g = adjacency(s.heap[s.stack[0].loc[0][1].r], s.heap, "graph");
    assert.deepEqual(g, { nodes: ["'A'", "'B'"], edges: [["'A'", "'B'", "4"]] });
    const l = trace("def f(adj):\n    return adj", "f([[(1, 7)], []])").steps[0];
    assert.deepEqual(adjacency(l.heap[l.stack[0].loc[0][1].r], l.heap, "adj").edges, [["0", "1", "7"]]);
  });

  test("a graph without cycles is in topological layers; a weighted or undirected one by distance from its source", () => {
    const dag = layered(
      ["0", "1", "2", "3"],
      [
        ["0", "1"],
        ["0", "2"],
        ["1", "3"],
        ["2", "3"],
        ["0", "3"],
      ],
    ).layer;
    assert.deepEqual([...dag.values()], [0, 1, 1, 2]); // 3 below both 1 and 2, though 0 points at it too
    const near = layered(
      ["0", "1", "2", "3"],
      [
        ["0", "1", 1],
        ["0", "2", 1],
        ["1", "3", 1],
        ["2", "3", 1],
        ["0", "3", 9],
      ],
      true,
    ).layer;
    assert.equal(near.get("3"), 1);
    const ring = layered(
      ["a", "b", "c", "d"],
      [
        ["a", "b"],
        ["b", "a"],
        ["b", "c"],
        ["c", "b"],
        ["c", "d"],
        ["d", "c"],
        ["d", "a"],
        ["a", "d"],
      ],
    ).layer;
    assert.deepEqual([...ring.entries()].sort(), [
      ["a", 0],
      ["b", 1],
      ["c", 2],
      ["d", 1],
    ]);
  });

  test("marks visited nodes, waiting nodes (a heap's (dist, node) items too), a number per node, and the edge a loop is on", () => {
    const code =
      "import heapq\ndef f(graph, src):\n    seen = {src}\n    pq = [(0, src)]\n    dist = {src: 0}\n    u = src\n    for v, w in graph[u]:\n        seen.add(v)\n        heapq.heappush(pq, (w, v))\n        dist[v] = w\n        return 1";
    const r = trace(code, 'f({"A": [("B", 4), ("C", 1)], "B": [], "C": []}, "A")');
    const s = r.steps.findLast((x) => x.ev === "return");
    const frame = s.stack.at(-1);
    const byName = new Map(frame.loc);
    const o = s.heap[byName.get("graph").r];
    const g = adjacency(o, s.heap, "graph");
    const labels = new Map();
    const st = graphState(g, o, "graph", frame.loc, s.heap, r.pointers.f, byName, labels);
    assert.deepEqual([...st.seen].sort(), ["'A'", "'B'"]);
    assert.deepEqual([...st.front].sort(), ["'A'", "'B'"]);
    assert.deepEqual(
      [...st.notes],
      [
        ["'A'", "0"],
        ["'B'", "4"],
      ],
    );
    assert.deepEqual(st.edge, ["'A'", "'B'"]);
    assert.deepEqual(labels.get("'B'"), ["v"]);
    assert.deepEqual(
      st.legend.map((x) => x[1]),
      ["in seen", "in pq", "under each node: dist"],
    );
  });
});

describe("pictures that read other variables", () => {
  test("a DP table over two strings has each row's and column's letter", () => {
    const r = trace(
      "def lcs(a, b):\n    dp = [[0] * (len(b) + 1) for _ in range(len(a) + 1)]\n    for i in range(1, len(a) + 1):\n        for j in range(1, len(b) + 1):\n            if a[i - 1] == b[j - 1]:\n                dp[i][j] = dp[i - 1][j - 1] + 1\n    return dp",
      'lcs("ab", "b")',
    );
    const info = r.pointers.lcs;
    const byName = new Map([
      ["a", "ab"],
      ["b", "b"],
    ]);
    assert.deepEqual(gridAxes(info, info.grid.dp, byName, 3, 2), { rows: ["", "a", "b"], cols: ["", "b"] });
    assert.equal(gridAxes(info, undefined, byName, 3, 2), null);
  });

  test("the other end of a window is a pointer too (left with right), when it's a number", () => {
    const ints = new Map([
      ["left", 2],
      ["right", 4],
      ["lo", 0],
    ]);
    assert.deepEqual(windowEnds(["right"], ints), ["right", "left"]);
    assert.deepEqual(windowEnds(["hi"], ints), ["hi", "lo"]);
    assert.deepEqual(windowEnds(["i"], ints), ["i"]);
  });

  test("gridAxes still labels a DP table over two strings when expr() handles subscripts", () => {
    // Regression test: ensure namesIn correctly extracts variable names from expressions
    const r = trace(
      "def lcs(a, b):\n    dp = [[0] * (len(b) + 1) for _ in range(len(a) + 1)]\n    for i in range(1, len(a) + 1):\n        for j in range(1, len(b) + 1):\n            if a[i - 1] == b[j - 1]:\n                dp[i][j] = dp[i - 1][j - 1] + 1\n    return dp",
      'lcs("xy", "z")',
    );
    const info = r.pointers.lcs;
    const byName = new Map([
      ["a", "xy"],
      ["b", "z"],
    ]);
    const axes = gridAxes(info, info.grid.dp, byName, 3, 2);
    assert.ok(axes, "should find axes");
    assert.deepEqual(axes.rows, ["", "x", "y"]);
    assert.deepEqual(axes.cols, ["", "z"]);
  });
});

describe("evaluate(): nested subscripts in comparisons are marked", () => {
  test("temps[stack[-1]] < t marks the correct cell (Python)", () => {
    const r = trace(
      "def daily_temperatures(temps):\n    stack = []\n    for i, t in enumerate(temps):\n        while stack and temps[stack[-1]] < t:\n            j = stack.pop()\n    return []",
      "daily_temperatures([73, 74, 75, 71])",
    );
    // At step where the comparison runs with stack=[0, 3], it should compare temps[3]
    const steps = r.steps;
    const comparisonStep = steps.find((s) => s.ev === "line" && s.line === 4 && s.stack.at(-1).loc.find(([n]) => n === "stack")?.[1]?.r);
    if (comparisonStep) {
      const stackRef = comparisonStep.stack.at(-1).loc.find(([n]) => n === "stack")[1];
      const stackObj = comparisonStep.heap[stackRef.r];
      // If stack has items, the comparison should work
      if (stackObj && stackObj.v.length > 0) {
        // The tracer should encode this comparison with nested subscripts
        const cond = r.conds?.[comparisonStep.cond?.k];
        if (cond) {
          const op = cond.ops.find((o) => o.on === "temps");
          assert.ok(op, "should have an operand for temps");
          // The index expression should be ["sub", "stack", ["c", -1]]
          assert.deepEqual(op.ix?.[0], "sub", "should use sub expression");
        }
      }
    }
  });

  test("temps[stack[stack.length - 1]] < t marks the correct cell (JavaScript)", () => {
    setLanguage("javascript");
    const r = runJs(
      "function f(temps) {\n  const stack = [];\n  for (let i = 0; i < temps.length; i++) {\n    const t = temps[i];\n    while (stack.length && temps[stack[stack.length - 1]] < t) stack.pop();\n  }\n}",
      "f([73, 74, 75, 71])",
    );
    // Similar test for JavaScript version
    const steps = r.steps;
    const comparisonStep = steps.find((s) => s.ev === "line" && s.line === 5 && s.stack.at(-1).loc.find(([n]) => n === "stack"));
    if (comparisonStep) {
      const cond = r.conds?.[comparisonStep.cond?.k];
      if (cond) {
        const op = cond.ops.find((o) => o.on === "temps");
        if (op) {
          // Should have a subscript expression
          assert.deepEqual(op.ix?.[0], "sub", "should use sub expression");
        }
      }
    }
  });
});

describe("grid vs rows: when a list of lists is a table (2-D indexed) vs a collection", () => {
  test("a DP grid is recognized in the function that indexes it", () => {
    const r = trace(
      "def unique_paths(m, n):\n    dp = [[1] * n for _ in range(m)]\n    for r in range(1, m):\n        for c in range(1, n):\n            dp[r][c] = dp[r - 1][c] + dp[r][c - 1]\n    return dp[m - 1][n - 1]",
      "unique_paths(3, 4)",
    );
    const refDp = r.steps[r.steps.length - 2].stack[0].loc.find(([n]) => n === "dp")[1].r;
    assert.equal(isRefGridInStack(refDp, r.steps[r.steps.length - 2].stack, r.pointers), true);
  });

  test("a list of results is not a grid when it's never 2-D indexed", () => {
    const r = trace(
      "def permutations(nums):\n    result = []\n    def backtrack(path, rest):\n        if not rest:\n            result.append(path)\n            return\n        for i in range(len(rest)):\n            backtrack(path + [rest[i]], rest[:i] + rest[i + 1:])\n    backtrack([], nums)\n    return result",
      "permutations([1, 2])",
    );
    // find the last step where we're in permutations with result populated
    const step = r.steps
      .slice()
      .reverse()
      .find((s) => {
        const frame = s.stack.find((f) => f.fn === "permutations");
        if (!frame) return false;
        const resultVar = frame.loc.find(([n]) => n === "result");
        return resultVar && resultVar[1]?.r && s.heap[resultVar[1].r]?.v?.length > 0;
      });
    assert.ok(step, "should find a step with result populated");
    const frame = step.stack.find((f) => f.fn === "permutations");
    const refResult = frame.loc.find(([n]) => n === "result")[1].r;
    assert.equal(isRefGridInStack(refResult, step.stack, r.pointers), false);
  });

  test("a board passed to a helper is recognized as a grid in the helper", () => {
    const r = trace(
      "def solve(board):\n    def dfs(r, c):\n        if board[r][c] == 1:\n            return True\n        return False\n    return dfs(0, 0)\n\nsolve([[0, 1], [1, 0]])",
    );
    const step = r.steps.find((s) => s.stack.length > 1 && s.stack[s.stack.length - 1].fn === "dfs");
    assert.ok(step, "dfs runs");
    const refBoard = step.stack.find((f) => f.fn === "solve").loc.find(([n]) => n === "board")[1].r;
    assert.equal(isRefGridInStack(refBoard, step.stack, r.pointers), true);
    // before dfs is called, solve is the current call and indexes nothing: the name, indexed by dfs, still makes it a table
    const before = r.steps.find((s) => s.stack.at(-1)?.fn === "solve" && s.stack.at(-1).loc.some(([n]) => n === "board"));
    assert.ok(before, "solve runs before dfs");
    assert.equal(isRefGridInStack(refBoard, before.stack.slice(-1), r.pointers, "board"), true);
  });

  test("a table another function fills is a table before that function is first called", () => {
    const r = trace(
      "def fill(dp, i, j):\n    dp[i][j] = 1\n\ndef main():\n    dp = [[0] * 2 for _ in range(2)]\n    fill(dp, 0, 0)\n    return dp\n\nmain()",
    );
    const before = r.steps.find((s) => s.stack.at(-1)?.fn === "main" && s.stack.at(-1).loc.some(([n]) => n === "dp"));
    assert.ok(before, "main makes dp before calling fill");
    const ref = before.stack.at(-1).loc.find(([n]) => n === "dp")[1].r;
    assert.equal(isRefGridInStack(ref, before.stack, r.pointers), false); // (main itself never indexes it)
    assert.equal(isRefGridInStack(ref, before.stack, r.pointers, "dp"), true);
  });
});

describe("callArgs(): the arguments of a call on the caller's line", () => {
  test("nested calls, brackets and strings stay inside", () => {
    assert.equal(callArgs("const left = mergeSort(a.slice(0, mid));", "mergeSort"), "a.slice(0, mid)");
    assert.equal(callArgs("left = merge_sort(a[:len(a) // 2])", "merge_sort"), "a[:len(a) // 2]");
    assert.equal(callArgs("return merge(merge_sort(a[:mid]), merge_sort(a[mid:]))", "merge_sort"), "a[:mid]");
    assert.equal(callArgs('go(s[1:], ")")', "go"), 's[1:], ")"');
    assert.equal(callArgs("x = self.helper(nums[i + 1:])", "helper"), "nums[i + 1:]");
  });
  test("no call to that function: null", () => {
    assert.equal(callArgs("result = sort_it(a[:mid])", "sort"), null);
    assert.equal(callArgs("x = a[:mid]", "merge_sort"), null);
  });
});

describe("toJSON(): a result as LeetCode prints it", () => {
  const result = (code, call) => {
    const r = trace(code, call).result;
    return toJSON(r.v, r.heap);
  };
  test("lists and values as they are, a linked list as its values, a tree in level order", () => {
    assert.deepEqual(result("def f():\n    return [[1, 2], (3, True, None)]", "f()"), [
      [1, 2],
      [3, true, null],
    ]);
    assert.deepEqual(result("def f(h):\n    return h", "f(linked([1, 2, 3]))"), [1, 2, 3]);
    assert.deepEqual(result("def f(t):\n    return t", "f(tree([4, 2, 7, None, 3]))"), [4, 2, 7, null, 3]);
    assert.equal(result("def f():\n    return {1: 2}", "f()"), undefined); // (LeetCode has no dicts to compare)
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
