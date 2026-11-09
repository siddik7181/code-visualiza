// The JavaScript tracer (extension/tracer.js): the same trace as the Python tracer, from JavaScript run in Sval. What a run records, how
// control flow and functions show up, scripts, classes, the suggested call, the usage analysis, the statement tree, and the fixes made to
// Sval (vendor/sval/README.md).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { run, signature, suggest } from "../extension/tracer.js";

const local = (step, name, depth = -1) => step.stack.at(depth).loc.find(([k]) => k === name)?.[1];
const names = (step, depth = -1) => step.stack.at(depth).loc.map(([k]) => k);
const shape = (r) => r.steps.map((s) => `${s.ev}:${s.line}`);

const TWO_SUM = `function twoSum(nums, target) {
  const seen = new Map();
  for (let i = 0; i < nums.length; i++) {
    const need = target - nums[i];
    if (seen.has(need)) return [seen.get(need), i];
    seen.set(nums[i], i);
  }
}`;

describe("a run", () => {
  test("records every line, call and return, in order, with the call's result", () => {
    const r = run(TWO_SUM, "twoSum([2, 7, 11], 9)");
    assert.equal(r.error, null);
    assert.deepEqual(shape(r), [
      "call:1",
      "line:2",
      "line:3",
      "line:4",
      "line:5",
      "line:6",
      "line:3",
      "line:4",
      "line:5",
      "line:5",
      "return:5",
    ]);
    assert.deepEqual(r.result.heap[r.result.v.r].v, [0, 1]);
    assert.equal(r.lang, "javascript");
  });

  test("keeps the real state at each step: a Map, a number, and a let only once it's set", () => {
    const r = run(TWO_SUM, "twoSum([2, 7, 11], 9)");
    const s = r.steps[8]; // the second time round, `need` set
    assert.deepEqual(s.heap[local(s, "seen").r], { t: "dict", cls: "Map", kv: [[2, 0]], n: 1 });
    assert.equal(local(s, "need"), 2);
    // each time round the loop has a new `need`, not set until its line runs
    assert.ok(!names(r.steps[7]).includes("need") && !names(r.steps[1]).includes("need"), "`need` was shown before its line ran");
  });

  test("names the parameters at a call (a closure's outer variables aren't parameters, but are shown)", () => {
    const r = run(
      "function outer(a) {\n  let z = 3;\n  const inner = (b) => {\n    return z + b;\n  };\n  return inner(a);\n}",
      "outer(1)",
    );
    const call = r.steps.find((s) => s.ev === "call" && s.stack.at(-1).fn === "inner");
    assert.deepEqual(call.params, ["b"]);
    assert.deepEqual(names(call).sort(), ["b", "z"]);
    assert.equal(r.result.v, 4);
  });

  test("has every frame of a recursion on the stack, deepest last", () => {
    const r = run("function fact(n) {\n  if (n <= 1) return 1;\n  return n * fact(n - 1);\n}", "fact(4)");
    const deepest = r.steps.find((s) => s.stack.length === 4);
    assert.deepEqual(
      deepest.stack.map((f) => f.loc.find(([k]) => k === "n")[1]),
      [4, 3, 2, 1],
    );
    assert.equal(r.result.v, 24);
  });

  test("builds linked lists with linked([...]); a ListNode the code defines is its own", () => {
    const rev =
      "function rev(head) {\n  let prev = null;\n  while (head) {\n    const next = head.next;\n    head.next = prev;\n    prev = head;\n    head = next;\n  }\n  return prev;\n}";
    const r = run(rev, "rev(linked([1, 2, 3]))");
    const chain = [];
    for (let v = r.result.v; v?.r; v = r.result.heap[v.r].a.find(([k]) => k === "next")[1]) chain.push(r.result.heap[v.r].a[0][1]);
    assert.deepEqual(chain, [3, 2, 1]);
    const own = run("class ListNode {\n  constructor(v) {\n    this.v = v;\n    this.next = null;\n  }\n}", "new ListNode(7)");
    assert.equal(own.error, null);
    assert.deepEqual(own.result.heap[own.result.v.r].a, [
      ["v", 7],
      ["next", null],
    ]);
  });

  test("shows `this` of a method, opened up by the panel into this.<field>", () => {
    const r = run(
      "class Box {\n  constructor() {\n    this.items = [];\n  }\n  add(x) {\n    this.items.push(x);\n  }\n}",
      "const b = new Box();\nb.add(5)",
    );
    const add = r.steps.find((s) => s.ev === "line" && s.stack.at(-1).fn === "add");
    assert.ok(names(add).includes("this"));
    assert.equal(add.heap[local(add, "this").r].cls, "Box");
  });

  test("encodes plain objects as maps, objects that link to others as nodes, undefined as undefined", () => {
    const r = run("function f() {\n  const counts = { a: 1 };\n  const node = { val: 1, next: null };\n  let u;\n  return 0;\n}", "f()");
    const s = r.steps.at(-1);
    assert.deepEqual(s.heap[local(s, "counts").r], { t: "dict", cls: "", kv: [["a", 1]], n: 1 });
    assert.equal(s.heap[local(s, "node").r].t, "obj");
    assert.deepEqual(local(s, "u"), { x: "undefined" });
  });
});

describe("control flow", () => {
  test("an if / else if / else steps on each test it makes; a body on the test's line gets its own step", () => {
    const code = "function sign(x) {\n  if (x > 0) {\n    return 1;\n  } else if (x < 0) return -1;\n  else {\n    return 0;\n  }\n}";
    assert.deepEqual(shape(run(code, "sign(-5)")), ["call:1", "line:2", "line:4", "line:4", "return:4"]);
    assert.deepEqual(shape(run(code, "sign(0)")), ["call:1", "line:2", "line:4", "line:6", "return:6"]);
  });

  test("a for loop steps on its header before each test; for...of before each item and once when none are left", () => {
    const loop = run("function f(n) {\n  let s = 0;\n  for (let i = 0; i < n; i++) {\n    s += i;\n  }\n  return s;\n}", "f(2)");
    assert.deepEqual(shape(loop), ["call:1", "line:2", "line:3", "line:4", "line:3", "line:4", "line:3", "line:6", "return:6"]);
    const of = run("function f(xs) {\n  let s = 0;\n  for (const x of xs) s += x;\n  return s;\n}", "f([5, 6])");
    assert.deepEqual(shape(of), ["call:1", "line:2", "line:3", "line:3", "line:3", "line:3", "line:3", "line:4", "return:4"]);
    assert.equal(of.result.v, 11);
  });

  test("while, do...while, switch, break and continue", () => {
    const r = run(
      "function f(n) {\n  let k = 0;\n  do {\n    k++;\n  } while (k < 2);\n  while (true) {\n    if (k > 3) break;\n    k++;\n    continue;\n  }\n  switch (k) {\n    case 4:\n      return 'four';\n    default:\n      return 'other';\n  }\n}",
      "f(0)",
    );
    assert.equal(r.error, null);
    assert.equal(r.result.v, "four");
    assert.ok(["line:5", "line:6", "line:7", "line:11", "line:13"].every((x) => shape(r).includes(x)));
  });

  test("an exception that leaves a function is a step in it, and the error is reported", () => {
    const r = run("function f(a) {\n  return a.b.c;\n}", "f({})");
    assert.match(r.error, /^TypeError/);
    assert.deepEqual(shape(r), ["call:1", "line:2", "exception:2"]);
  });

  test("a call that raises inside the code's own try is caught there", () => {
    const r = run(
      "function f(x) {\n  if (!x) throw new Error('no');\n  return x;\n}\nfunction g() {\n  try {\n    f(0);\n  } catch (e) {\n    return f(2);\n  }\n}",
      "g()",
    );
    assert.equal(r.error, null);
    assert.equal(r.result.v, 2);
    assert.ok(r.steps.some((s) => s.ev === "exception" && s.exc === "Error: no"));
  });

  test("one-line callbacks (a sort comparator) and generators run, without steps of their own", () => {
    const r = run("function f(a) {\n  a.sort((x, y) => x - y);\n  function* g() { yield 1; }\n  return [...g(), ...a];\n}", "f([3, 1, 2])");
    assert.equal(r.error, null);
    assert.deepEqual(r.result.heap[r.result.v.r].v, [1, 1, 2, 3]);
    assert.deepEqual([...new Set(r.steps.map((s) => s.stack.at(-1).fn))], ["f"]);
  });
});

describe("limits and errors", () => {
  test("an endless loop stops at 1,500 steps, even inside the code's own try / catch", () => {
    assert.equal(run("let i = 0;\nwhile (true) {\n  i++;\n}").steps.length, 1500);
    const r = run("let i = 0;\nwhile (true) {\n  try {\n    i++;\n  } catch {}\n}");
    assert.equal(r.truncated, true);
  });

  test("a syntax error in the code or the input is explained", () => {
    assert.match(run("function f( {").error, /^The code doesn't run: SyntaxError \(line 1\)/);
    assert.match(run(TWO_SUM, "twoSum([1, 2], ").error, /^The input isn't valid JavaScript: SyntaxError/);
  });

  test("console.log is captured, written as Node writes it", () => {
    const r = run("console.log('n', 1, [1, 'a'], { a: null }, new Map([[1, 2]]), new Set([3]), undefined);");
    assert.equal(r.out, "n 1 [1, 'a'] {a: null} Map(1) {1 => 2} Set(1) {3} undefined\n");
  });
});

describe("a script (no input)", () => {
  const r = run(
    "const sq = (n) => n * n;\nfunction twice(n) {\n  return 2 * n;\n}\nlet total = 0;\nfor (let k = 0; k < 3; k++) total += sq(k);\nconsole.log('total', twice(total));",
  );

  test("runs its top level as the global frame, and captures console.log", () => {
    assert.deepEqual([r.error, r.script, r.driver], [null, true, ""]);
    assert.equal(r.steps[0].stack[0].fn, "<module>");
    assert.equal(r.out, "total 10\n");
  });

  test("skips the lines that only define things (const f = () => ..., function f)", () => {
    const top = r.steps.filter((s) => s.ev === "line" && s.stack.length === 1).map((s) => s.line);
    assert.ok(!top.includes(1) && !top.includes(2), `definition lines were steps: ${top}`);
    assert.deepEqual([...new Set(r.steps.map((s) => s.stack.at(-1).fn))], ["<module>", "sq", "twice"]);
  });

  test("shows the variables it made (not the functions)", () => {
    assert.deepEqual(names(r.steps.at(-1)), ["total"]);
  });
});

describe("the suggested call (no input, code that only defines things)", () => {
  test("is run, and says which inputs were picked", () => {
    const r = run("function fact(n) {\n  return n <= 1 ? 1 : n * fact(n - 1);\n}");
    assert.deepEqual([r.script, r.driver, r.result.v, r.guessed], [false, "fact(5)", 120, ["n"]]);
  });

  test("calls a LeetCode-style `var f = function`, with inputs shaped by name and use", () => {
    assert.equal(suggest("var maxProfit = function(prices) {\n  return prices.length;\n};").driver, "maxProfit([5, 2, 8, 1, 9, 3])");
    assert.equal(
      suggest("function depth(root) {\n  return root ? 1 + depth(root.left) : 0;\n}").driver,
      "depth(tree([4, 2, 6, 1, 3, 5, 7]))",
    );
    assert.equal(suggest("function len(node) {\n  return node.next ? 1 : 0;\n}").driver, "len(linked([1, 2, 3, 4, 5]))");
    assert.equal(suggest("function f(s) {\n  return s.split('');\n}").driver, 'f("abcabcbb")');
  });

  test("makes calls for a design class, or a LeetCode design problem written with prototypes", () => {
    assert.match(
      suggest("class Stack {\n  constructor() { this.a = []; }\n  push(x) { this.a.push(x); }\n  pop() { return this.a.pop(); }\n}").driver,
      /^const obj = new Stack\(\);\nobj\.push\(1\);/,
    );
    const proto = suggest(
      "var Counter = function() { this.n = 0; };\nCounter.prototype.add = function(x) { this.n += x; };\nCounter.prototype.get = function() { return this.n; };",
    );
    assert.match(proto.driver, /^const obj = new Counter\(\);\nobj\.add\(1\);/);
    assert.equal(run("var Counter = function() { this.n = 0; };\nCounter.prototype.add = function(x) { this.n += x; };").error, null);
  });
});

describe("what the code's usage says about a variable", () => {
  test("a for loop up to .length, forEach's index, and .entries() walk over a list", () => {
    const p = run(
      "function f(nums, xs, ys) {\n  for (let i = 0; i < nums.length; i++) nums[i];\n  xs.forEach((x, j) => x);\n  for (const [k, y] of ys.entries()) y;\n}",
      "f([1], [2], [3])",
    ).pointers.f;
    assert.deepEqual([p.idx.nums, p.idx.xs, p.idx.ys], [["i"], ["j"], ["k"]]);
  });

  test("Map.has / Map.get and `in` with an expression are lookups the panel works out", () => {
    const p = run(TWO_SUM, "twoSum([1], 1)").pointers.twoSum;
    assert.deepEqual(p.keys.seen, ["need"]);
    const q = run("function f(o, x) {\n  return (x + 1) in o;\n}", "f({}, 1)").pointers.f;
    assert.deepEqual(
      q.probes.map((x) => [x.on, x.kind, x.text]),
      [["o", "in", "x + 1"]],
    );
  });

  test("stack (push + pop), queue (shift), bits, a destructuring swap, a class's fields across methods", () => {
    const p = run(
      "function f(nums, k) {\n  const st = [], q = [];\n  st.push(1); st.pop();\n  q.push(1); q.shift();\n  let mask = 0;\n  mask |= 1 << k;\n  [nums[0], nums[1]] = [nums[1], nums[0]];\n  return mask;\n}",
      "f([1, 2], 1)",
    ).pointers.f;
    assert.deepEqual([p.stacks, p.queues, p.bits, p.swaps], [["st"], ["q"], ["mask"], ["nums"]]);
    const c = run("class S {\n  push(x) { this.a.push(x); }\n  pop() { return this.a.pop(); }\n}", "1").pointers;
    assert.deepEqual([c.push.stacks, c.pop.stacks], [["this.a"], ["this.a"]]);
  });

  test("a midpoint (Math.floor((lo + hi) / 2), (lo + hi) >> 1) makes its ends pointers", () => {
    const code = (mid) => `function bs(nums) {\n  let lo = 0, hi = nums.length - 1;\n  const mid = ${mid};\n  return nums[mid];\n}`;
    assert.deepEqual(run(code("Math.floor((lo + hi) / 2)"), "bs([1, 2, 3])").pointers.bs.idx.nums, ["hi", "lo", "mid"]);
    assert.deepEqual(run(code("(lo + hi) >> 1"), "bs([1, 2, 3])").pointers.bs.idx.nums, ["hi", "lo", "mid"]);
  });

  test("pivot = nums[(lo + hi) >> 1] doesn't make pivot a pointer (subscript expressions excluded)", () => {
    const qs = run(
      "function partition(nums, lo, hi) {\n  const pivot = nums[(lo + hi) >> 1];\n  return pivot;\n}",
      "partition([3, 1, 4], 0, 2)",
    );
    // pivot is a value, not a pointer; only lo, hi should be pointers from the subscript index
    assert.deepEqual(qs.pointers.partition.idx.nums, ["hi", "lo"]);
    assert.ok(!qs.pointers.partition.idx.nums.includes("pivot"));
  });

  test("nested subscripts in comparisons: temps[stack[stack.length - 1]] encodes the subscript", () => {
    const temps = run(
      "function f(temps) {\n  const stack = [0];\n  for (let i = 0; i < temps.length; i++) {\n    const t = temps[i];\n    while (stack.length && temps[stack[stack.length - 1]] < t) stack.pop();\n  }\n}",
      "f([73, 74, 75])",
    );
    // The comparison should encode temps[stack[stack.length - 1]]
    const probe = temps.pointers.f.probes.find((p) => p.line === 5 && p.on === "temps");
    assert.ok(probe, "should have a probe for temps[...]");
    assert.deepEqual(probe.e, ["sub", "stack", ["-", ["len", "stack"], ["c", 1]]], "should encode temps[stack[stack.length - 1]]");
  });

  test("stack.at(-1) and stack.length are encoded as expressions", () => {
    const code = run(
      "function f(nums) {\n  const stack = [1, 2];\n  const top = stack.at(-1);\n  const n = stack.length;\n  return top + n;\n}",
      "f([1, 2, 3])",
    );
    // stack.at(-1) should create a probe; length should be derivable
    const at = code.pointers.f.probes.find((p) => p.on === "stack" && p.kind === "get");
    assert.ok(at, "should have a probe for stack.at(...)");
    assert.deepEqual(at.e, ["c", -1], "should encode stack.at(-1) as a subscript");
  });
});

describe("what each line reads and writes, and how lists point into each other (as tracer.py)", () => {
  const at = (p, line) => p.acc.filter((a) => a.line === line);

  test("a DP line reads its sources and writes its cell (1D and 2D); a one-line if's body is on its line", () => {
    const coin = run(
      "function f(coins, amount) {\n  const dp = new Array(amount + 1).fill(9);\n  for (let a = 1; a <= amount; a++)\n    for (const c of coins) if (c <= a) dp[a] = Math.min(dp[a], dp[a - c] + 1);\n  return dp[amount];\n}",
      "f([1], 2)",
    ).pointers.f;
    assert.deepEqual(
      at(coin, 4).map(({ ix, w }) => [JSON.stringify(ix), w]),
      [
        ['["n","a"]', true],
        ['["n","a"]', false],
        ['["-",["n","a"],["n","c"]]', false],
      ],
    );
    const grid = run(
      "function g(m, n) {\n  const dp = [[1, 1], [1, 1]];\n  for (let r = 1; r < m; r++)\n    for (let c = 1; c < n; c++) dp[r][c] = dp[r - 1][c] + dp[r][c - 1];\n  return dp;\n}",
      "g(2, 2)",
    ).pointers.g;
    assert.equal(at(grid, 4).length, 3); // a cell is one access, not also a read of its row
    assert.deepEqual(at(grid, 4)[0], {
      line: 4,
      on: "dp",
      rc: [
        ["n", "r"],
        ["n", "c"],
      ],
      w: true,
    });
  });

  test("leaves out what may not run (a branch of c ? x : y, the right of && / ||)", () => {
    const p = run(
      "function f(a, i) {\n  const x = a[i] ? a[0] : a[1];\n  const y = a[2] && a[3];\n  return x + y;\n}",
      "f([1, 1, 1, 1], 0)",
    ).pointers.f;
    assert.deepEqual(
      at(p, 2).map((a) => a.ix),
      [["n", "i"]],
    );
    assert.deepEqual(
      at(p, 3).map((a) => a.ix),
      [["c", 2]],
    );
  });

  test("a stack of indexes into a list holds its places (even on the right of &&), and loops over neighbours are named", () => {
    const p = run(
      "function f(temps) {\n  const ans = temps.map(() => 0), stack = [];\n  for (let i = 0; i < temps.length; i++) {\n    while (stack.length && temps[stack[stack.length - 1]] < temps[i]) {\n      const j = stack.pop();\n      ans[j] = i - j;\n    }\n    stack.push(i);\n  }\n  return ans;\n}",
      "f([2, 1, 3])",
    ).pointers.f;
    assert.deepEqual(p.holds, { temps: ["stack"], ans: ["stack"] });
    const g = run("function g(graph, u) {\n  for (const [v, w] of graph[u]) {}\n}", "g({1: [[2, 5]]}, 1)").pointers.g;
    assert.deepEqual(g.iters, { v: ["graph", "u"] });
  });
});

describe("what each test compared", () => {
  test("if / else if / while / for / do-while tests, their operands' values and what they came out as", () => {
    const r = run(
      "function bs(nums, t) {\n  let lo = 0, hi = nums.length - 1;\n  while (lo <= hi) {\n    const mid = (lo + hi) >> 1;\n    if (nums[mid] < t) lo = mid + 1;\n    else if (nums[mid] > t) hi = mid - 1;\n    else return mid;\n  }\n  return -1;\n}",
      "bs([1, 3, 5, 7], 5)",
    );
    assert.deepEqual(
      r.conds.map((c) => [c.line, c.kind, c.t]),
      [
        [3, "while", "lo <= hi"],
        [5, "if", "nums[mid] < t"],
        [6, "elif", "nums[mid] > t"],
      ],
    );
    assert.deepEqual(
      r.conds[1].ops.map(({ on, ix }) => [on, ix]),
      [
        ["nums", ["n", "mid"]],
        ["t", undefined],
      ],
    );
    assert.deepEqual(
      r.steps.filter((s) => s.cond).map((s) => [s.line, s.cond.o.map(([, v]) => v), s.cond.v]),
      [
        [3, [0, 3], true],
        [5, [3, 5], true],
        [3, [2, 3], true],
        [5, [5, 5], false],
        [6, [5, 5], false],
      ],
    );
    const f = run(
      "function f(a) {\n  let s = 0;\n  for (let i = 0; i < a.length; i++) s += a[i];\n  do { s--; } while (s > 2);\n  return s;\n}",
      "f([1, 2])",
    );
    assert.deepEqual(
      f.conds.map((c) => [c.line, c.kind]),
      [
        [3, "for"],
        [4, "while"],
      ],
    );
    assert.deepEqual(
      f.steps.filter((s) => s.cond).map((s) => s.cond.v),
      [true, true, false, false],
    );
  });

  test("an && that stops early leaves out the operands it didn't work out", () => {
    const r = run("function f(a, b) {\n  if (a && b > 1) return 1;\n  return 0;\n}", "f(0, 5)");
    assert.deepEqual(r.steps.find((s) => s.cond).cond, { k: 0, o: [[0, 0]], v: false });
  });
});

describe("the statement tree", () => {
  const tree = (code) => {
    const s = (ns) => ns.map((n) => `${n.t}:${n.l}-${n.e}${n.c.length ? `[${s(n.c)}]` : ""}`).join(" ");
    return s(run(code).outline);
  };

  test("nests like the source; else if / else / catch / finally are siblings", () => {
    assert.equal(
      tree(
        "function f(x) {\n  if (x) {\n    return 1;\n  } else if (x === 0) {\n    return 0;\n  } else {\n    return -1;\n  }\n}\ntry {\n  f(1);\n} catch (e) {\n  throw e;\n} finally {\n  f(2);\n}",
      ),
      "function:1-9[if:2-4[return:3-3] else if:4-6[return:5-5] else:6-8[return:7-7]] try:10-12[expr:11-11] catch:12-14[throw:13-13] finally:14-16[expr:15-15]",
    );
  });

  test("shows a class's methods, a switch's cases, and functions assigned to names", () => {
    assert.equal(
      tree("class A {\n  m() {\n    return 1;\n  }\n}\nconst g = (x) => {\n  switch (x) {\n    case 1:\n      break;\n  }\n};"),
      "class:1-5[method:2-4[return:3-3]] const:6-11[switch:7-10[case:8-9[break:9-9]]]",
    );
  });
});

describe("the fixes made to Sval (vendor/sval/README.md)", () => {
  test("a return inside try is kept by a finally that doesn't return, even one that calls functions and loops", () => {
    assert.equal(run("function f() {\n  try {\n    return 1;\n  } finally {\n    0;\n  }\n}", "f()").result.v, 1);
    assert.equal(
      run("function g() {\n  return 2;\n}\nfunction f() {\n  try {\n    return 1;\n  } finally {\n    g();\n  }\n}", "f()").result.v,
      1,
    );
    const labeled =
      "function f() {\n  let r = 0;\n  a: for (;;) {\n    for (;;) {\n      try {\n        break a;\n      } finally {\n        for (;;) break;\n      }\n    }\n    r = 9;\n  }\n  return r;\n}";
    assert.equal(run(labeled, "f()").result.v, 0);
  });

  test("a destructuring assignment can assign to elements and properties ([a[i], a[j]] = [a[j], a[i]])", () => {
    const r = run("function f(a, o) {\n  [a[0], a[1]] = [a[1], a[0]];\n  ({ p: o.q } = { p: 5 });\n  return [a, o];\n}", "f([1, 2], {})");
    assert.equal(r.error, null);
    const [a, o] = r.result.heap[r.result.v.r].v.map((x) => r.result.heap[x.r]);
    assert.deepEqual([a.v, o.kv], [[2, 1], [["q", 5]]]);
  });

  test("an object destructuring assignment assigns to the existing variables", () => {
    assert.equal(run("let a = 1;\nfunction f() {\n  ({ a } = { a: 7 });\n}\nf();\nconsole.log(a);").out, "7\n");
    assert.equal(run("try {\n  throw new Error('boom');\n} catch ({ message }) {\n  console.log(message);\n}").out, "boom\n");
  });
});

describe("the signature (as tracer.py's)", () => {
  const kinds = (code) => signature(code).entries.map((e) => [e.call, e.params.map((p) => `${p.name}:${p.kind}`)]);

  test("LeetCode's JSDoc names the nodes a parameter is", () => {
    const code =
      "/**\n * Definition for singly-linked list.\n * function ListNode(val, next) {}\n */\n/**\n * @param {ListNode[]} lists\n * @param {TreeNode} root\n * @param {number} k\n */\nvar f = function(lists, root, k) {\n};";
    assert.deepEqual(kinds(code), [["f", ["lists:linked[]", "root:tree", "k:null"]]]);
    assert.deepEqual(kinds("/**\n * @param {_Node} node\n */\nvar clone = function(node) { return node.neighbors; };"), [
      ["clone", ["node:graph"]],
    ]);
  });

  test("without JSDoc, how a parameter is used; the function an input calls first", () => {
    assert.deepEqual(kinds("function helper(x) { return x; }\nfunction rev(head) { return helper(head.next); }"), [
      ["rev", ["head:linked"]],
      ["helper", ["x:null"]],
    ]);
  });

  test("a design class written with prototypes; a syntax error", () => {
    const sig = signature(
      "var MinStack = function() {};\nMinStack.prototype.push = function(val) {};\nMinStack.prototype.getMin = function() {};",
    );
    assert.deepEqual(sig.classes, { MinStack: { init: [], methods: { push: [{ name: "val", kind: null }], getMin: [] } } });
    assert.match(signature("function (").error, /^The code doesn't run/);
  });
});
