// LeetCode test cases pasted into the input (extension/leetcode.js): what's read from each way LeetCode shows them, the calls they become
// for a function's signature (as the tracers give it), and how a result compares with the expected answer.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { calls, compare, items, literal, parseCases } from "../extension/leetcode.js";

const param = (name, kind = null) => ({ name, kind });
const TWO_SUM = { entries: [{ call: "Solution().twoSum", params: [param("nums"), param("target")] }], classes: {} };
/** @param {string} text @param {"python" | "javascript"} [lang] */
const drivers = (text, sig = TWO_SUM, lang = "python") => calls(parseCases(text), sig, lang).runs.map((r) => r.driver);

describe("parseCases(): the ways LeetCode shows test cases", () => {
  test("the Testcase panel: one value per line, the cases one after another", () => {
    assert.deepEqual(parseCases("[2,7,11,15]\n9\n[3,2,4]\n6"), {
      cases: [
        {
          values: ["[2,7,11,15]", "9", "[3,2,4]", "6"].map((text) => ({ name: null, text })),
          expected: null,
        },
      ],
    });
  });

  test("the Testcase panel with each value under its name, and its Case labels", () => {
    const p = parseCases("Case 1\nnums =\n[2,7,11,15]\ntarget =\n9\nCase 2\nnums =\n[3,3]\ntarget =\n6");
    assert.deepEqual(
      p.cases.map((c) => c.values.map((v) => `${v.name}=${v.text}`)),
      [
        ["nums=[2,7,11,15]", "target=9"],
        ["nums=[3,3]", "target=6"],
      ],
    );
  });

  test("a problem's examples: Input / Output, passing over Explanation and Constraints", () => {
    const p = parseCases(
      "Example 1:\n\nInput: nums = [2,7,11,15], target = 9\nOutput: [0,1]\nExplanation: Because nums[0] + nums[1] == 9, we return [0, 1].\n\n" +
        "Example 2:\n\nInput: nums = [3,2,4], target = 6\nOutput: [1,2]\n\nConstraints:\n\n2 <= nums.length <= 104\nOnly one valid answer exists.",
    );
    assert.deepEqual(
      p.cases.map((c) => [c.values.map((v) => v.name), c.expected]),
      [
        [["nums", "target"], "[0,1]"],
        [["nums", "target"], "[1,2]"],
      ],
    );
  });

  test("the Test Result panel: Expected is the answer, Output is what the submitted code gave", () => {
    const p = parseCases("Wrong Answer\nRuntime: 0 ms\nCase 1\nInput\nnums =\n[2,7,11,15]\ntarget =\n9\nOutput\n[0,0]\nExpected\n[0,1]");
    assert.equal(p.cases[0].expected, "[0,1]");
  });

  test("strings with commas and brackets in them, nulls, and nested lists are one value each", () => {
    const p = parseCases('s = "a,b]", grid = [["1","0"],["0","1"]], root = [1,null,2]');
    assert.deepEqual(
      p.cases[0].values.map((v) => v.text),
      ['"a,b]"', '[["1","0"],["0","1"]]', "[1,null,2]"],
    );
  });

  test("code isn't test cases", () => {
    for (const code of ["fib(5)", "s = MinStack()\ns.push(1)", "Solution().twoSum([1, 2], 3)", "print(1)", ""])
      assert.equal(parseCases(code), null);
  });
});

describe("literal() and items(): values as each language writes them", () => {
  test("null, true and false the language's way; numbers and strings as they are", () => {
    assert.equal(literal('[1,null,true,false,"x"]', "python"), '[1, None, True, False, "x"]');
    assert.equal(literal("[None,True]", "javascript"), "[null, true]");
    assert.equal(literal("12345678901234567890", "python"), "12345678901234567890"); // (stays exact)
    assert.equal(JSON.parse(literal("['a', 'b']", "json"))[1], "b");
  });

  test("the items of a list", () => assert.deepEqual(items('[[1,2], "a,b", []]'), ["[1,2]", '"a,b"', "[]"]));
});

describe("calls(): the calls test cases become", () => {
  test("named values go to the parameters with those names; values in order, as many per call as there are parameters", () => {
    assert.deepEqual(drivers("nums = [2,7,11,15], target = 9"), ["Solution().twoSum([2, 7, 11, 15], 9)"]);
    assert.deepEqual(drivers("target = 9, nums = [1]"), ["Solution().twoSum([1], 9)"]);
    assert.deepEqual(drivers("[2,7]\n9\n[3,3]\n6"), ["Solution().twoSum([2, 7], 9)", "Solution().twoSum([3, 3], 6)"]);
    const js = { entries: [{ call: "twoSum", params: [param("nums"), param("target")] }], classes: {} };
    assert.deepEqual(drivers("[2,7]\n9", js, "javascript"), ["twoSum([2, 7], 9);"]);
  });

  test("each run is labelled, and keeps its case's expected answer", () => {
    const r = calls(
      parseCases("Input: nums = [2,7], target = 9\nOutput: [0,1]\nInput: nums = [3,3], target = 6\nOutput: [0,1]"),
      TWO_SUM,
      "python",
    );
    assert.deepEqual(
      r.runs.map((x) => [x.label, x.expected, x.fn]),
      [
        ["Case 1", "[0,1]", "Solution().twoSum"],
        ["Case 2", "[0,1]", "Solution().twoSum"],
      ],
    );
  });

  test("builds the nodes a parameter is: a linked list, a binary tree, a graph, a list of linked lists", () => {
    const sig = (kind, name = "x") => ({ entries: [{ call: "f", params: [param(name, kind)] }], classes: {} });
    assert.deepEqual(drivers("head = [1,2,3]", sig("linked", "head")), ["f(linked([1, 2, 3]))"]);
    assert.deepEqual(drivers("root = [1,null,2]", sig("tree", "root")), ["f(tree([1, None, 2]))"]);
    assert.deepEqual(drivers("adjList = [[2,4],[1,3],[2,4],[1,3]]", sig("graph", "node")), [
      "f(graph({1: [2, 4], 2: [1, 3], 3: [2, 4], 4: [1, 3]}))",
    ]);
    assert.deepEqual(drivers("lists = [[1,4],[2]]", sig("linked[]", "lists"), "javascript"), ["f([linked([1, 4]), linked([2])]);"]);
  });

  test("picks, of several functions, the one the names (or the number of values) fit", () => {
    const sig = {
      entries: [
        { call: "Solution().helper", params: [param("node", "tree")] },
        { call: "Solution().maxPath", params: [param("grid"), param("k")] },
      ],
      classes: {},
    };
    assert.deepEqual(drivers("grid = [[1]], k = 2", sig), ["Solution().maxPath([[1]], 2)"]);
  });

  test("a design problem: the calls on an object of the class", () => {
    const sig = { entries: [], classes: { MinStack: { init: [], methods: { push: [param("val")], getMin: [] } } } };
    const text = '["MinStack","push","getMin"]\n[[],[-2],[]]';
    assert.deepEqual(drivers(text, sig), ["obj = MinStack()\nobj.push(-2)\nobj.getMin()"]);
    assert.deepEqual(drivers(text, sig, "javascript"), ["const obj = new MinStack();\nobj.push(-2);\nobj.getMin();"]);
    assert.equal(
      calls(parseCases('["MinStack","pop"]\n[[],[]]'), sig, "python").error,
      "MinStack has no method pop (the test case calls it).",
    );
  });

  test("says what's wrong: a value that isn't a list for a node, too many values, nothing to call; leaves out what isn't a parameter", () => {
    const linked = { entries: [{ call: "Solution().hasCycle", params: [param("head", "linked")] }], classes: {} };
    assert.match(calls(parseCases("head = 3"), linked, "python").error, /head is a linked list: .* not 3/);
    assert.equal(
      calls(parseCases("[1]\n2\n3"), TWO_SUM, "python").error,
      "twoSum takes 2 values (nums, target); the test case has 3 values.",
    );
    assert.equal(
      calls(parseCases("[1]"), { entries: [], classes: {} }, "python").error,
      "The code has no function to call with these values.",
    );
    const r = calls(parseCases("head = [3,2,0,-4], pos = 1"), linked, "python");
    assert.deepEqual([r.runs[0].driver, r.notes], ["Solution().hasCycle(linked([3, 2, 0, -4]))", ["pos isn't a parameter: left out."]]);
  });
});

describe("compare(): a result and LeetCode's expected answer", () => {
  test("the same, the same items in another order, or different", () => {
    assert.equal(compare([0, 1], "[0,1]"), "same");
    assert.equal(compare([1, 0], "[0,1]"), "order");
    assert.equal(compare([[2, 1], [3]], "[[3],[1,2]]"), "order");
    assert.equal(compare(3, "4"), "different");
  });

  test("numbers to 5 decimals (2.00000), booleans, an empty list or tree as null", () => {
    assert.equal(compare(2, "2.00000"), "same");
    assert.equal(compare(true, "true"), "same");
    assert.equal(compare(null, "[]"), "same");
    assert.equal(compare(1, "not a value"), null);
  });
});
