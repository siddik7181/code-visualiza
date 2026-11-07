// The tracer: what a run records, how a script and a class run, the suggested call, what the code's usage says about each variable,
// and the statement tree.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { trace, suggest, local } from "./python.mjs";

const TWO_SUM =
  "def twoSum(nums, target):\n    seen = {}\n    for i, x in enumerate(nums):\n        if target - x in seen:\n            return [seen[target - x], i]\n        seen[x] = i";
const FACT = "def fact(n):\n    if n <= 1:\n        return 1\n    return n * fact(n - 1)";

describe("a run", () => {
  test("records every line, call and return, in order", () => {
    const r = trace(TWO_SUM, "twoSum(nums=[2,7,11,15], target=9)");
    assert.equal(r.error, null);
    assert.deepEqual(
      r.steps.map((s) => `${s.ev}:${s.line}`),
      ["call:1", "line:2", "line:3", "line:4", "line:6", "line:3", "line:4", "line:5", "return:5"],
    );
    assert.deepEqual(r.result.heap[r.result.v.r].v, [0, 1]);
  });

  test("keeps the real state at each step", () => {
    const r = trace(TWO_SUM, "twoSum([2, 7, 11, 15], 9)");
    const s = r.steps[7]; // the partner of 7 is found
    assert.deepEqual(s.heap[local(s, "seen").r].kv, [[2, 0]]);
  });

  test("names the parameters at a call (a closure's outer variables aren't parameters)", () => {
    assert.deepEqual(trace(TWO_SUM, "twoSum([1], 1)").steps[0].params, ["nums", "target"]);
    const r = trace("def outer(a):\n    z = 3\n    def inner(b):\n        return z + b\n    return inner(a)", "outer(1)");
    const call = r.steps.find((s) => s.ev === "call" && s.stack.at(-1).fn === "inner");
    assert.deepEqual(call.params, ["b"]);
  });

  test("builds linked lists with linked([...]) and follows their links", () => {
    const r = trace(
      "def reverseList(head):\n    prev = None\n    while head:\n        nxt = head.next\n        head.next = prev\n        prev, head = head, nxt\n    return prev",
      "reverseList(linked([1, 2, 3]))",
    );
    const chain = [];
    for (let v = r.result.v; v && v.r; v = r.result.heap[v.r].a.find(([k]) => k === "next")[1])
      chain.push(r.result.heap[v.r].a.find(([k]) => k === "val")[1]);
    assert.deepEqual(chain, [3, 2, 1]);
  });

  test("has every frame of a recursion on the stack, deepest last", () => {
    const r = trace(FACT, "fact(4)");
    assert.equal(Math.max(...r.steps.map((s) => s.stack.length)), 4);
    assert.deepEqual(
      r.steps.find((s) => s.stack.length === 4).stack.map((f) => local({ stack: [f] }, "n")),
      [4, 3, 2, 1],
    );
    assert.equal(r.result.v, 24);
  });

  test("shows a variable named like a helper (graph, tree)", () => {
    const r = trace("def bfs(graph, tree):\n    return len(graph)", "bfs({0: [1], 1: [0]}, 3)");
    assert.deepEqual(
      r.steps[0].stack[0].loc.map(([k]) => k),
      ["graph", "tree"],
    );
  });

  test("is the same every time (random is seeded)", () => {
    const code = "def f():\n    return random.randint(1, 10**9)";
    assert.equal(trace(code, "f()").result.v, trace(code, "f()").result.v);
  });
});

describe("limits and errors", () => {
  test("an endless loop stops at 1,500 steps", () => {
    const r = trace("def f():\n    while True:\n        pass", "f()");
    assert.equal(r.truncated, true);
    assert.equal(r.steps.length, 1500);
  });

  test("the code's own `except Exception` can't swallow the step limit", () => {
    const r = trace("def f():\n    while True:\n        try:\n            pass\n        except Exception:\n            pass", "f()");
    assert.equal(r.truncated, true);
  });

  test("an exception is reported, with the step it happened on", () => {
    const r = trace("def f(a):\n    return a[5]", "f([1])");
    assert.match(r.error, /^IndexError/);
    assert.equal(r.steps.at(-1).ev, "exception");
  });

  test("a syntax error in the code or the input is explained", () => {
    assert.match(trace("def broken(:\n  pass", "broken()").error, /doesn't run: SyntaxError \(line 1\)/);
    assert.match(trace("x = (1,\nprint(x)").error, /doesn't run: SyntaxError/); // (no input: the script path)
    assert.match(trace(TWO_SUM, "twoSum([1, 2], ").error, /isn't valid Python/);
  });

  test("input() says to put the value in the code; sys.exit() just ends the program", () => {
    assert.match(trace("name = input()").error, /input\(\) can't ask/);
    const r = trace("import sys\nprint(1)\nsys.exit()\nprint(2)");
    assert.deepEqual([r.error, r.out], [null, "1\n"]);
  });
});

describe("a script (no input)", () => {
  const SCRIPT =
    'import math\nclass P:\n    def __init__(self, x):\n        self.x = x\ndef sq(n):\n    return n * n\nif __name__ == "__main__":\n    total = 0\n    for k in range(3):\n        total += sq(k)\n    p = P(total)\n    print("total", total)';
  const r = trace(SCRIPT);

  test('runs its top level, including `if __name__ == "__main__"`, and captures print()', () => {
    assert.deepEqual([r.error, r.script, r.driver], [null, true, ""]);
    assert.equal(r.out, "total 5\n");
    assert.equal(local(r.steps.at(-1), "total"), 5);
  });

  test("skips the lines that only define things, and class bodies", () => {
    const lines = r.steps.filter((s) => s.ev === "line" && s.stack.length === 1).map((s) => s.line);
    assert.ok(!lines.some((l) => [1, 2, 5].includes(l)), `definition lines were steps: ${lines}`);
    assert.deepEqual([...new Set(r.steps.map((s) => s.stack.at(-1).fn))], ["<module>", "sq", "__init__"]);
  });

  test("shows only the names the script made (not heapq, deque, inf ... the tracer provides)", () => {
    assert.deepEqual(
      r.steps.at(-1).stack[0].loc.map(([k]) => k),
      ["total", "k", "p"],
    );
    assert.deepEqual(trace("x = 1\nfor i in range(3):\n    x *= 2").steps.at(-1).stack[0].loc, [
      ["x", 8],
      ["i", 2],
    ]);
  });
});

describe("the suggested call (no input, code that only defines things)", () => {
  test("is run, and says which inputs were picked", () => {
    const r = trace(FACT);
    assert.deepEqual([r.script, r.driver, r.result.v, r.guessed], [false, "fact(n=5)", 120, ["n"]]);
  });

  test("takes values the text names", () => {
    assert.deepEqual(suggest(TWO_SUM, "Say nums=[2,7,11,15] and target=9."), { driver: "twoSum(nums=[2,7,11,15], target=9)", guessed: [] });
  });

  test("calls the method of a LeetCode `class Solution` (not its self.helper methods)", () => {
    const r = trace("class Solution:\n    def maxProfit(self, prices: List[int]) -> int:\n        return max(prices) - min(prices)");
    assert.deepEqual([r.driver, r.result.v], ["Solution().maxProfit(prices=[5, 2, 8, 1, 9, 3])", 8]);
    assert.equal(
      suggest(
        "class Solution:\n    def solve(self, grid):\n        return self.dfs(grid, 0)\n    def dfs(self, grid, i):\n        return i",
      ).driver,
      "Solution().solve(grid=[[1, 1, 0, 0], [1, 0, 0, 1], [0, 0, 1, 1]])",
    );
  });

  test("picks each input's shape from its name and how the code uses it; leaves defaults alone", () => {
    assert.equal(suggest("def f(nums, k):\n    return sorted(nums)[:k]").driver, "f(nums=[5, 2, 8, 1, 9, 3], k=2)");
    assert.equal(
      suggest("def v(root, lo=float('-inf'), hi=float('inf')):\n    return root.val").driver,
      "v(root=tree([4, 2, 6, 1, 3, 5, 7]))",
    );
    assert.equal(suggest("def g(q):\n    return q.next").driver, "g(q=linked([1, 2, 3, 4, 5]))");
  });

  test("makes calls for a design class", () => {
    const code =
      "class Stack:\n    def __init__(self):\n        self.a = []\n    def push(self, x):\n        self.a.append(x)\n    def pop(self):\n        return self.a.pop()";
    assert.match(suggest(code).driver, /^obj = Stack\(\)\nobj\.push\(1\)/);
  });
});

describe("what the code's usage says about a variable", () => {
  test("heap, stack, queue (a deque used at both ends too), bits, a list sorted in place", () => {
    const uses = trace(
      "def f(nums, k):\n    h, st, q, dq = [], [], [], deque()\n    for x in nums:\n        heapq.heappush(h, x)\n        st.append(x)\n        st.pop()\n        q.append(x)\n        q.pop(0)\n        dq.append(x)\n        dq.pop()\n        dq.popleft() if dq else None\n    mask = 0\n    mask |= 1 << k\n    a = list(nums)\n    a[0], a[1] = a[1], a[0]\n    return mask",
      "f([3, 1, 2], 2)",
    ).pointers.f;
    assert.deepEqual([uses.heaps, uses.stacks, uses.queues, uses.bits, uses.swaps], [["h"], ["st"], ["dq", "q"], ["mask"], ["a"]]);
  });

  test("a class attribute used as a stack across methods is a stack in every method", () => {
    const p = trace(
      "class S:\n    def __init__(self):\n        self.a = []\n    def push(self, x):\n        self.a.append(x)\n    def pop(self):\n        return self.a.pop()",
      "s = S()\ns.push(1)\ns.pop()",
    ).pointers;
    assert.deepEqual([p.push.stacks, p.pop.stacks, p.__init__.stacks], [["self.a"], ["self.a"], ["self.a"]]);
  });

  test("index variables and lookups become pointers", () => {
    const p = trace(TWO_SUM, "twoSum([1], 1)").pointers.twoSum;
    assert.deepEqual(p.idx.nums, ["i"]);
    assert.ok(p.probes.some((x) => x.on === "seen" && x.kind === "in" && x.line === 4 && x.text === "target - x"));
  });

  test("a midpoint makes its ends pointers (binary search's lo..hi window), a sum doesn't", () => {
    const bs = trace(
      "def bs(nums, t):\n    lo, hi = 0, len(nums) - 1\n    while lo <= hi:\n        mid = (lo + hi) // 2\n        if nums[mid] < t:\n            lo = mid + 1\n        else:\n            hi = mid - 1\n    return lo",
      "bs([1, 3, 5, 7], 5)",
    );
    assert.deepEqual(bs.pointers.bs.idx.nums, ["hi", "lo", "mid"]);
    const sum = trace("def f(nums, k):\n    for i in range(len(nums)):\n        j = i + k\n        nums[j]", "f([1, 2, 3], 0)");
    assert.deepEqual(sum.pointers.f.idx.nums, ["i", "j"]);
  });

  test("a script's top level is analysed under the name of its frame", () => {
    assert.deepEqual(trace("a = [3, 1]\nfor i in range(len(a)):\n    a[i] += 1").pointers["<module>"].idx.a, ["i"]);
  });
});

describe("the statement tree", () => {
  const shape = (ns) => ns.map((n) => `${n.t}:${n.l}-${n.e}${n.c.length ? `[${shape(n.c)}]` : ""}`).join(" ");

  test("nests like the source; elif / else / except / finally are siblings; a block ends where its body ends", () => {
    const { outline } = trace(
      "def f(x):\n    if x > 0:\n        return 1\n    elif x < 0:\n        return -1\n    else:\n        return 0\ntry:\n    f(1)\nexcept ValueError:\n    pass\nfinally:\n    print('done')\nfor i in range(2): pass\nelse: i = 9",
    );
    assert.equal(
      shape(outline),
      "def:1-7[if:2-3[return:3-3] elif:4-5[return:5-5] else:6-7[return:7-7]] try:8-9[expr:9-9] except:10-11[pass:11-11] finally:12-13[expr:13-13] for:14-14[pass:14-14] else:15-15[assign:15-15]",
    );
  });

  test("is empty for code that doesn't parse", () => {
    assert.deepEqual(trace("def f(:").outline, []);
  });
});
