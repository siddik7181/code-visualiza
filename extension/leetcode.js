// LeetCode test cases, as they're pasted from a problem page, turned into the call the visualizer runs. Takes what LeetCode shows:
// - the Testcase panel: one value per line, a case after another ([2,7,11,15] / 9 / [3,2,4] / 6), or each value under its name (nums =);
// - a problem's examples: "Input: nums = [2,7,11,15], target = 9" / "Output: [0,1]" / "Explanation: ...", one or several;
// - a design problem's two lines: ["MinStack","push","getMin"] / [[],[-2],[]];
// - the Test Result panel (its Expected is the answer; its Output is what the submitted code gave).
// Values are LeetCode's (JSON: null, true, false, "strings"), written into the call the way the code's language writes them, and built
// into the nodes a parameter is (a ListNode from [1,2,3], a TreeNode from level order, a graph from an adjacency list) by what the
// tracer read from the code (its `signature` mode: type hints, JSDoc, how a parameter is used). Nothing here touches the page.

// ---------------------------------------------------------------- values
const SPACE = /\s/;
/** Where the value starting at s[i] ends (a JSON value, also with Python's None / True / False and 'strings'), or -1 if there's none. */
function valueEnd(s, i) {
  while (SPACE.test(s[i] || "")) i++;
  const c = s[i];
  if (c === '"' || c === "'") {
    for (let k = i + 1; k < s.length; k++) {
      if (s[k] === "\\") k++;
      else if (s[k] === c) return k + 1;
    }
    return -1;
  }
  if (c === "[") {
    let k = i + 1;
    while (SPACE.test(s[k] || "")) k++;
    if (s[k] === "]") return k + 1;
    for (;;) {
      k = valueEnd(s, k);
      if (k < 0) return -1;
      while (SPACE.test(s[k] || "")) k++;
      if (s[k] === "]") return k + 1;
      if (s[k] !== ",") return -1;
      k++;
    }
  }
  const m = /^(-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|null|true|false|None|True|False)(?![\w.])/.exec(s.slice(i));
  return m ? i + m[0].length : -1;
}
/** The text is one value and nothing else. */
const isValue = (s) => {
  const end = valueEnd(s, 0);
  return end > 0 && !s.slice(end).trim();
};
const WORDS = {
  python: { null: "None", true: "True", false: "False", None: "None", True: "True", False: "False" },
  javascript: { null: "null", true: "true", false: "false", None: "null", True: "true", False: "false" },
};
WORDS.json = WORDS.javascript;
/** A value as `lang` writes it ("python", "javascript", or "json" for JSON.parse): null -> None, 'a' -> "a" in JSON. Numbers and strings
 * keep their text (a number past 2^53 stays exact). */
export function literal(text, lang) {
  let out = "";
  for (let i = 0; i < text.length;) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const end = valueEnd(text, i);
      const raw = text.slice(i, end);
      out += lang === "json" && c === "'" ? JSON.stringify(raw.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, "\\")) : raw;
      i = end;
    } else if (/[A-Za-z]/.test(c)) {
      const w = /^[A-Za-z]+/.exec(text.slice(i))[0];
      out += WORDS[lang][w] ?? w;
      i += w.length;
    } else if (SPACE.test(c)) i++;
    else {
      out += c === "," ? ", " : c;
      i++;
    }
  }
  return out;
}
/** The items of a list value, as their own texts: "[[1,2],[3]]" -> ["[1,2]", "[3]"]. */
export function items(text) {
  const out = [];
  let k = text.indexOf("[") + 1;
  while (SPACE.test(text[k] || "")) k++;
  if (text[k] === "]") return out;
  for (;;) {
    const end = valueEnd(text, k);
    out.push(text.slice(k, end).trim());
    k = end;
    while (SPACE.test(text[k] || "")) k++;
    if (text[k] !== ",") return out;
    k++;
  }
}
/** "nums = [2,7,11,15], target = 9" -> [["nums", "[2,7,11,15]"], ["target", "9"]], or null when the line isn't only that. */
function named(line) {
  const out = [];
  let i = 0;
  for (;;) {
    const m = /^\s*([A-Za-z_$][\w$]*)\s*=\s*/.exec(line.slice(i));
    if (!m) return null;
    i += m[0].length;
    const end = valueEnd(line, i);
    if (end < 0) return null;
    out.push([m[1], line.slice(i, end).trim()]);
    i = end;
    while (SPACE.test(line[i] || "")) i++;
    if (i >= line.length) return out;
    if (line[i] !== ",") return null;
    i++;
  }
}

// ---------------------------------------------------------------- the text
// labels (a whole line, or the start of one): a new case, the input, the answer, and parts to pass over
const CASE = /^(?:example|case)\s*\d*\s*:?$/i;
const LABEL = /^(input|output|expected(?:\s+output)?|explanation|constraints|stdout|note|notes|follow[-\s]?up)\b\s*:?\s*(.*)$/i;
const NOISE =
  /^(?:accepted|wrong answer|runtime error|time limit exceeded|memory limit exceeded|compile error|testcase|test result|source|runtime:.*|memory:.*|\d+\s*\/\s*\d+ testcases passed)$/i;

/** @typedef {{ name: string | null, text: string }} Value */
/** @typedef {{ values: Value[], expected: string | null }} Case */
/** LeetCode test cases in `text`: { cases }, or null when it isn't test cases (code, like fib(5)). A paste of the Testcase panel's
 * values without names is one case of all of them (they're split by the number of parameters, see calls()).
 * @param {string} text @returns {{ cases: Case[] } | null} */
export function parseCases(text) {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .split("\n");
  /** @type {(Case & { output: string | null })[]} */
  const cases = [];
  let cur = null,
    section = "input",
    pending = null; // a name on its own line (nums =): the next value is it
  const start = () => cases.push((cur = { values: [], expected: null, output: null }));
  for (const raw of lines) {
    let line = raw.trim();
    if (!line || NOISE.test(line)) continue;
    if (CASE.test(line)) {
      start();
      section = "input";
      continue;
    }
    const m = LABEL.exec(line);
    if (m) {
      const label = m[1].toLowerCase();
      section = label === "input" ? "input" : label === "output" ? "output" : label.startsWith("expected") ? "expected" : "skip";
      if (section === "input" && cur && (cur.values.length || cur.output || cur.expected)) start();
      line = m[2].trim();
      if (!line || section === "skip") continue;
    } else if (section === "skip") continue;
    if (!cur) start();
    if (section === "output" || section === "expected") {
      if (!isValue(line)) return null;
      cur[section] = line;
      continue;
    }
    const name = /^([A-Za-z_$][\w$]*)\s*=$/.exec(line);
    if (name) {
      pending = name[1];
      continue;
    }
    const pairs = named(line);
    if (pairs) cur.values.push(...pairs.map(([n, t]) => ({ name: n, text: t })));
    else if (isValue(line)) cur.values.push({ name: pending, text: line });
    else return null;
    pending = null;
  }
  const found = cases.filter((c) => c.values.length).map((c) => ({ values: c.values, expected: c.expected ?? c.output }));
  return found.length ? { cases: found } : null;
}

// ---------------------------------------------------------------- the calls
/** @typedef {{ name: string, kind: string | null }} Param */
/** @typedef {{ entries: { call: string, params: Param[] }[], classes: Record<string, { init: Param[], methods: Record<string, Param[]> }> }} Signature */
/** @typedef {{ label: string, driver: string, call: string, expected: string | null, design: boolean, fn: string }} Run */

const NODES = { linked: "a linked list", tree: "a binary tree", graph: "a graph" };
// a value as the argument a parameter takes: nodes built from LeetCode's lists (a list it must be: throws with what's wrong if it isn't)
function argument(text, kind, lang, name = "") {
  if (!kind) return literal(text, lang);
  if (!text.trim().startsWith("["))
    throw new Error(
      `${name || "This parameter"} is ${kind.endsWith("[]") ? `a list of ${NODES[kind.slice(0, -2)]}s` : NODES[kind]}: LeetCode writes it as a list, like [1,2,3], not ${text}.`,
    );
  if (kind.endsWith("[]"))
    return `[${items(text)
      .map((t) => argument(t, kind.slice(0, -2), lang))
      .join(", ")}]`;
  if (kind === "linked") return `linked(${literal(text, lang)})`;
  if (kind === "tree") return `tree(${literal(text, lang)})`;
  if (kind === "graph") {
    // LeetCode's adjacency list: node i + 1's neighbours at index i
    const adj = items(text).map((t, i) => `${i + 1}: ${literal(t, lang)}`);
    return `graph({${adj.join(", ")}})`;
  }
  return literal(text, lang);
}

/** The calls to run for parsed test cases on code with this signature: { runs: [{ label, driver, call, expected, design }], error,
 * notes }. A case is for the function its names match (or whose number of parameters divides its number of values), or for a design
 * class when its first value is a list of method names starting with the class's.
 * @param {{ cases: Case[] }} parsed @param {Signature} sig @param {"python" | "javascript"} lang */
export function calls(parsed, sig, lang) {
  try {
    return build(parsed, sig, lang);
  } catch (e) {
    return { runs: [], error: e.message, notes: [] };
  }
}
function build(parsed, sig, lang) {
  /** @type {Run[]} */
  const runs = [];
  const notes = [];
  const js = lang === "javascript";
  const entries = sig.entries || [];
  for (const c of parsed.cases) {
    const vals = c.values;
    // a design problem: ["MinStack","push",...] then [[],[-2],...] (and maybe more such pairs)
    const first = vals[0] && vals[0].text.trim().startsWith("[") ? items(vals[0].text) : [];
    const cls = first.length && /^["']/.test(first[0]) ? JSON.parse(literal(first[0], "json")) : null;
    if (cls && sig.classes?.[cls]) {
      for (let k = 0; k + 1 < vals.length; k += 2) {
        const ops = items(vals[k].text).map((t) => JSON.parse(literal(t, "json")));
        const args = items(vals[k + 1].text);
        if (ops.length !== args.length)
          return fail(`The two lists of a ${cls} case don't match: ${ops.length} calls, ${args.length} lists of arguments.`);
        const { init, methods } = sig.classes[ops[0]] || sig.classes[cls];
        const lines = [];
        for (let j = 0; j < ops.length; j++) {
          const ps = j === 0 ? init : methods[ops[j]];
          if (!ps) return fail(`${cls} has no method ${ops[j]} (the test case calls it).`);
          const a = items(args[j]);
          if (a.length !== ps.length)
            return fail(
              `${j ? `${cls}.${ops[j]}` : cls} takes ${ps.length} argument${ps.length === 1 ? "" : "s"}; the test case gives it ${a.length}.`,
            );
          const call = `${ops[j]}(${a.map((t, n) => argument(t, ps[n].kind, lang)).join(", ")})`;
          lines.push(j === 0 ? (js ? `const obj = new ${call};` : `obj = ${call}`) : js ? `obj.${call};` : `obj.${call}`);
        }
        runs.push({ label: "", driver: lines.join("\n"), call: lines.join("\n"), expected: c.expected, design: true, fn: cls });
      }
      continue;
    }
    if (!entries.length) return fail("The code has no function to call with these values.");
    // the values each have a name: the function with those parameters
    const names = vals.every((v) => v.name) ? vals.map((v) => v.name) : null;
    const byName = names && entries.find((e) => e.params.length && e.params.every((p) => names.includes(p.name)));
    if (byName) {
      const left = names.filter((n) => !byName.params.some((p) => p.name === n));
      if (left.length) notes.push(`${left.join(", ")} ${left.length === 1 ? "isn't a parameter" : "aren't parameters"}: left out.`);
      const args = byName.params.map((p) => argument(vals.find((v) => v.name === p.name).text, p.kind, lang, p.name));
      runs.push(run(byName, args, c.expected));
      continue;
    }
    // values in order: as many per call as the function has parameters
    const entry = entries.find((e) => e.params.length && vals.length % e.params.length === 0);
    if (!entry) {
      const e = entries[0];
      const want = e.params.map((p) => p.name).join(", ");
      return fail(
        `${e.call.replace(/^Solution\(\)\./, "")} takes ${e.params.length} value${e.params.length === 1 ? "" : "s"} (${want}); the test case has ${vals.length} value${vals.length === 1 ? "" : "s"}.`,
      );
    }
    const n = entry.params.length;
    for (let k = 0; k < vals.length; k += n) {
      const args = entry.params.map((p, j) => argument(vals[k + j].text, p.kind, lang, p.name));
      runs.push(run(entry, args, vals.length === n ? c.expected : null));
    }
  }
  runs.forEach((r, k) => (r.label = runs.length > 1 ? `Case ${k + 1}` : ""));
  return { runs, error: null, notes };

  function run(entry, args, expected) {
    const call = `${entry.call}(${args.join(", ")})`;
    return { label: "", driver: js ? `${call};` : call, call, expected, design: false, fn: entry.call };
  }
  function fail(error) {
    return { runs: [], error, notes };
  }
}

// ---------------------------------------------------------------- the answer
const close = (a, b) => typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= 1e-5 * Math.max(1, Math.abs(b));
function same(a, b) {
  if (close(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  return a === b;
}
// a list's items in one order (lists inside sorted first): [[2,1],[3]] and [[3],[1,2]] are the same items
const canon = (x) => (Array.isArray(x) ? x.map(canon).sort((p, q) => (JSON.stringify(p) < JSON.stringify(q) ? -1 : 1)) : x);
/** How a result (as JSON: lists, numbers, strings, booleans, null) compares with LeetCode's expected answer: "same", "order" (the same
 * items in another order: right when the problem takes any order), "different", or null when the expected text isn't a value.
 * An empty list and null are the same (LeetCode writes an empty linked list or tree as []). */
export function compare(got, expectedText) {
  let want;
  try {
    want = JSON.parse(literal(expectedText, "json"));
  } catch {
    return null;
  }
  const empty = (x) => x === null || (Array.isArray(x) && !x.length);
  if (same(got, want) || (empty(got) && empty(want))) return "same";
  if (Array.isArray(got) && Array.isArray(want) && same(canon(got), canon(want))) return "order";
  return "different";
}
