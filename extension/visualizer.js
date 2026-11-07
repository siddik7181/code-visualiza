// Visualizer: runs any Python code on an input (in Pyodide, in a Web Worker: see worker.js and tracer.py), records every step, and replays
// it as animated pictures: lists with their index pointers, grids, dictionaries, sets, linked lists, trees and graphs, the call stack, the
// tree of calls, the code's own statement tree, and the line that just ran. Nothing is generated: every picture is the real state of the
// program at that step, and every caption is computed from the difference between two steps.

const SPEEDS = [0.5, 1, 2, 4];
const STEP_MS = 900; // time per step at 1x
const CELL = 38; // array cell width + gap, px (matches .vz-cell in style.css)
const RANGE_PAIRS = [
  ["lo", "hi"],
  ["low", "high"],
  ["left", "right"],
  ["l", "r"],
  ["start", "end"],
  ["begin", "end"],
];

// ---------------------------------------------------------------- Python (one Web Worker, shared; it runs off the page's thread)
let box = null; // { worker, warm, waiting: Map(id -> settle) }
function worker() {
  if (box) return box;
  const w = new Worker("worker.js", { type: "module" });
  box = { worker: w, warm: false, waiting: new Map() };
  const b = box;
  w.onmessage = ({ data }) => {
    const done = b.waiting.get(data.id);
    b.waiting.delete(data.id);
    done?.(data);
  };
  // the worker couldn't start (Pyodide didn't load): fail what's waiting and start fresh next time
  w.onerror = (e) => {
    e.preventDefault();
    kill(b);
    for (const done of b.waiting.values()) done({ error: "Python couldn't start. Press Run to try again." });
    b.waiting.clear();
  };
  return box;
}
function kill(b) {
  b.worker.terminate();
  if (box === b) box = null;
}
function ask(msg) {
  const b = worker();
  const id = `${Date.now()}-${Math.random()}`;
  const limit = b.warm ? 20000 : 60000; // the first call also downloads and starts Python (slow on phones)
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      b.waiting.delete(id);
      kill(b); // a run that never ends (an endless loop in a builtin) is stopped by throwing the worker away
      reject(new Error(`It ran for more than ${limit / 1000} seconds and was stopped. Try a smaller input.`));
    }, limit);
    b.waiting.set(id, (d) => {
      clearTimeout(t);
      if (d.error) return reject(new Error(d.error));
      b.warm = true;
      resolve(JSON.parse(d.json));
    });
    b.worker.postMessage({ id, ...msg });
  });
}

// h("div.card", {onclick}, child, ...) — builds DOM via textContent, so data is never parsed as HTML.
function h(sel, props, ...kids) {
  const [tag, ...cls] = sel.split(".");
  const e = Object.assign(document.createElement(tag || "div"), props);
  if (cls.length) e.className = cls.join(" ");
  e.append(...kids.flat().filter(Boolean)); // drops null/false so `cond && node` works
  return e;
}
const svgEl = (tag) => document.createElementNS("http://www.w3.org/2000/svg", tag);
// the frame of a script's top level is "<module>" in Python; people call it the global frame
const fnName = (fn) => (fn === "<module>" ? "global" : fn);

// ---------------------------------------------------------------- values
// How values and operations are written: Python's way or JavaScript's. Module-wide, set from each trace (the panel shows one at a time).
const SYNTAX = {
  python: {
    js: false,
    none: "None",
    yes: "True",
    no: "False",
    push: "append",
    unshift: "appendleft",
    shift: "popleft",
    drop: "remove",
    del: "del",
    names: {},
  },
  javascript: {
    js: true,
    none: "null",
    yes: "true",
    no: "false",
    push: "push",
    unshift: "unshift",
    shift: "shift",
    drop: "delete",
    del: "delete",
    names: { list: "Array", dict: "Object", set: "Set" },
  },
};
let SYN = SYNTAX.python;
/** @param {string} lang "python" or "javascript" */
export const setLanguage = (lang) => (SYN = SYNTAX[lang] || SYNTAX.python);
const isRef = (v) => v != null && typeof v === "object" && "r" in v;
const objOf = (v, heap) => (isRef(v) ? heap[v.r] : null);
// A key of a dict, as shown and as compared with a variable. A JavaScript object's keys are strings (seen[2] is seen["2"]): shown bare,
// so the key 2 and a variable holding 2 match.
const keyOf = (k, o, heap) => (SYN.js && o && o.t === "dict" && !o.cls && k !== null && typeof k !== "object" ? String(k) : fmt(k, heap));
function fmt(v, heap, depth = 0) {
  if (v === null || v === undefined) return SYN.none;
  if (v === true) return SYN.yes;
  if (v === false) return SYN.no;
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(+v.toFixed(4));
  if (typeof v === "string") return `'${v}'`;
  if ("x" in v) return v.x;
  const o = heap[v.r];
  if (!o) return "…";
  if (depth > 2) return o.t === "dict" ? "{…}" : o.t === "obj" ? o.cls : "[…]";
  const items = (xs, n) =>
    xs
      .slice(0, 8)
      .map((x) => fmt(x, heap, depth + 1))
      .join(", ") + (n > 8 ? ", …" : "");
  switch (o.t) {
    case "list":
      return `[${items(o.v, o.n)}]`;
    case "tuple":
      return `(${items(o.v, o.n)}${o.n === 1 ? "," : ""})`;
    case "deque":
      return `deque([${items(o.v, o.n)}])`;
    case "set":
      return SYN.js ? `Set {${items(o.v, o.n)}}` : o.n ? `{${items(o.v, o.n)}}` : "set()";
    case "dict": {
      const map = SYN.js && o.cls === "Map";
      const body = o.kv
        .slice(0, 6)
        .map(([k, x]) => `${depth ? fmt(k, heap, depth + 1) : keyOf(k, o, heap)}${map ? " => " : ": "}${fmt(x, heap, depth + 1)}`)
        .join(", ");
      return `${map ? "Map " : ""}{${body}${o.n > 6 ? ", …" : ""}}`;
    }
    case "obj":
      return nodeLabel(o, heap) !== null ? `${o.cls}(${nodeLabel(o, heap)})` : o.cls;
    default:
      return o.repr;
  }
}
// A tuple inside a heap/stack/queue item, kept short: (3, 'a') -> 3,a
const itemText = (v, heap) => {
  const o = objOf(v, heap);
  return o && o.t === "tuple" && o.v.every(primitive) ? o.v.map((x) => cellText(x, heap)).join(",") : cellText(v, heap);
};
const INTERVAL_NAME = /interval|meeting|range|segment|span|booking|event|slot|schedule/i;
const RESULT_NAME = /^(res|out|ans|result|merged|answer)$/i;
// [[start, end], ...] with start <= end, named like intervals (or the result of a function that has intervals)
function isIntervals(o, heap, name, vars) {
  if (!o || o.t !== "list" || !o.v.length) return false;
  const pairs = o.v.map((x) => objOf(x, heap));
  if (!pairs.every((p) => p && p.v.length === 2 && p.v.every((y) => typeof y === "number") && p.v[0] <= p.v[1])) return false;
  return INTERVAL_NAME.test(name) || (RESULT_NAME.test(name) && vars.some(([k]) => INTERVAL_NAME.test(k)));
}
// Inside a cell a one-character string is shown bare ('#' -> #), like a board.
const cellText = (v, heap) => (typeof v === "string" && v.length === 1 ? v : fmt(v, heap));
const attr = (o, name) => (o && o.a ? (o.a.find((x) => x[0] === name) || [])[1] : undefined);
const hasAttr = (o, name) => !!(o && o.a && o.a.some((x) => x[0] === name));
function nodeLabel(o, heap) {
  for (const k of ["val", "value", "data", "key"])
    if (hasAttr(o, k) && !isRef(attr(o, k))) return fmt(attr(o, k), heap).replace(/^'(.*)'$/, "$1");
  if (hasAttr(o, "k") && hasAttr(o, "v")) return `${fmt(attr(o, "k"), heap)}:${fmt(attr(o, "v"), heap)}`;
  const prim = o.a && o.a.find(([, x]) => !isRef(x) && x !== null);
  return prim ? fmt(prim[1], heap).replace(/^'(.*)'$/, "$1") : null;
}
const LINKS = ["next", "prev", "random", "left", "right", "neighbors", "children", "parent"];
const isNode = (o) => !!(o && o.t === "obj" && o.a.some(([k]) => LINKS.includes(k)));
const primitive = (v) => !isRef(v);

const GRAPH_NAME = /^(adj|adjacency|graph|g|neighbors|nbrs|children|tree|edges_of|out|succ)$/i;
// A list of lists (or dict of lists) whose numbers are all positions in it: an adjacency list, drawn as a graph.
function adjacency(o, heap, name) {
  if (o.t === "dict") {
    if (!GRAPH_NAME.test(name) || !o.kv.length) return null;
    const keys = o.kv.map(([k]) => keyOf(k, o, heap));
    const edges = [];
    for (const [k, x] of o.kv) {
      const l = objOf(x, heap);
      if (!l || !["list", "set", "tuple"].includes(l.t) || !l.v.every(primitive)) return null;
      for (const y of l.v) edges.push([keyOf(k, o, heap), fmt(y, heap)]);
    }
    const all = [...new Set([...keys, ...edges.map((e) => e[1])])];
    return all.length <= 24 ? { nodes: all, edges } : null;
  }
  if (o.t !== "list" || !o.v.length || o.v.length > 24) return null;
  const rows = o.v.map((x) => objOf(x, heap));
  if (!rows.every((r) => r && ["list", "set", "tuple"].includes(r.t) && r.v.every((y) => Number.isInteger(y) && y >= 0 && y < o.v.length)))
    return null;
  const rect = rows.every((r) => r.v.length === rows[0].v.length);
  if (rect && !GRAPH_NAME.test(name)) return null; // equal rows are a table (edges, a board), not a graph
  const nodes = o.v.map((_, i) => String(i));
  return { nodes, edges: rows.flatMap((r, i) => r.v.map((y) => [String(i), String(y)])) };
}

// What kind of picture a value gets.
function kindOf(v, heap, ptrs, name = "") {
  if (typeof v === "string") return ptrs && ptrs.length && v.length <= 64 ? "chars" : "scalar";
  const o = objOf(v, heap);
  if (!o) return "scalar";
  if ((o.t === "list" || o.t === "dict") && adjacency(o, heap, name)) return "graph";
  if (o.t === "list" || o.t === "tuple" || o.t === "deque") {
    if (
      o.v.length &&
      o.v.every((x) => {
        const r = objOf(x, heap);
        return r && (r.t === "list" || r.t === "tuple") && r.v.every(primitive);
      }) &&
      o.v.length <= 30
    ) {
      const w = objOf(o.v[0], heap).v.length;
      if (w > 0 && w <= 30 && o.v.every((x) => objOf(x, heap).v.length === w)) return "grid";
    }
    if (o.v.length && o.v.every((x) => isNode(objOf(x, heap)))) return "nodes";
    if (
      o.v.length &&
      o.v.every((x) => {
        const r = objOf(x, heap);
        return r && ["list", "tuple", "set"].includes(r.t);
      })
    )
      return "rows";
    return "array";
  }
  if (o.t === "dict") return "dict";
  if (o.t === "set") return "set";
  if (isNode(o)) return "nodes";
  if (o.t === "obj") return "obj";
  return "scalar";
}

// The variables of a frame, with `self` (`this`) opened up into self.<attribute> (so a design class shows its own lists and maps).
function variables(frame, heap) {
  const out = [];
  for (const [name, v] of frame.loc) {
    const o = objOf(v, heap);
    if ((name === "self" || name === "this") && o && o.t === "obj" && !isNode(o)) {
      for (const [k, x] of o.a) out.push([`self.${k}`, x]);
    } else out.push([name, v]);
  }
  return out;
}

// Works out a lookup expression from the tracer (["-", ["n", "target"], ["n", "x"]]) with the frame's current numbers; null if it can't.
function evaluate(e, ints) {
  if (!e) return null;
  if (e[0] === "n") return ints.has(e[1]) ? ints.get(e[1]) : null;
  if (e[0] === "c") return e[1];
  if (e[0] === "neg") {
    const v = evaluate(e[1], ints);
    return v === null ? null : -v;
  }
  const a = evaluate(e[1], ints),
    b = evaluate(e[2], ints);
  if (a === null || b === null) return null;
  switch (e[0]) {
    case "+":
      return a + b;
    case "-":
      return a - b;
    case "*":
      return a * b;
    case "//":
      return b === 0 ? null : Math.floor(a / b);
    case "%":
      return b === 0 ? null : ((a % b) + b) % b;
  }
  return null;
}

// ---------------------------------------------------------------- what changed between two steps (the caption)
function diff(prevVars, curVars, prevHeap, heap) {
  const before = new Map(prevVars);
  const msgs = [];
  for (const [name, v] of curVars) {
    if (!before.has(name)) {
      msgs.push(`${name} = ${fmt(v, heap)}`);
      continue;
    }
    const p = before.get(name);
    if (isRef(p) && isRef(v) && p.r === v.r) {
      const a = prevHeap[p.r],
        b = heap[v.r];
      if (!a || !b) continue;
      msgs.push(...containerDiff(name, a, b, prevHeap, heap));
    } else if (fmt(p, prevHeap) !== fmt(v, heap)) {
      msgs.push(primitive(p) && primitive(v) ? `${name}: ${fmt(p, prevHeap)} → ${fmt(v, heap)}` : `${name} = ${fmt(v, heap)}`);
    }
  }
  return msgs;
}
function containerDiff(name, a, b, ha, hb) {
  const f = (x, h) => fmt(x, h);
  if ((a.t === "list" || a.t === "deque" || a.t === "tuple") && a.t === b.t) {
    const A = a.v.map((x) => f(x, ha)),
      B = b.v.map((x) => f(x, hb));
    if (B.length === A.length + 1 && A.every((x, i) => x === B[i])) return [`${name}.${SYN.push}(${B[B.length - 1]})`];
    if (B.length === A.length + 1 && A.every((x, i) => x === B[i + 1])) return [`${name}.${SYN.unshift}(${B[0]})`];
    if (B.length === A.length - 1 && B.every((x, i) => x === A[i])) return [`${name}.pop() → ${A[A.length - 1]}`];
    if (B.length === A.length - 1 && B.every((x, i) => x === A[i + 1])) return [`${name}.${SYN.shift}() → ${A[0]}`];
    if (A.length === B.length) {
      const ch = A.map((x, i) => (x !== B[i] ? i : -1)).filter((i) => i >= 0);
      if (ch.length === 2 && A[ch[0]] === B[ch[1]] && A[ch[1]] === B[ch[0]]) return [`swap ${name}[${ch[0]}] ↔ ${name}[${ch[1]}]`];
      if (ch.length && ch.length <= 3) return ch.map((i) => `${name}[${i}]: ${A[i]} → ${B[i]}`);
      if (ch.length) return [`${name}: ${ch.length} items changed`];
      return [];
    }
    // one item in or out somewhere else (a heap push/pop reorders the rest): name it by comparing the two lists as multisets
    const count = (xs) => xs.reduce((m, x) => m.set(x, (m.get(x) || 0) + 1), new Map());
    const inA = count(A),
      inB = count(B);
    const added = [...inB].flatMap(([x, n]) => Array(Math.max(0, n - (inA.get(x) || 0))).fill(x));
    const removed = [...inA].flatMap(([x, n]) => Array(Math.max(0, n - (inB.get(x) || 0))).fill(x));
    if (added.length + removed.length && added.length + removed.length <= 2)
      return [...removed.map((x) => `${name}: ${x} removed`), ...added.map((x) => `${name}: ${x} added`)];
    return [`${name} now has ${B.length} items`];
  }
  if (a.t === "dict" && b.t === "dict") {
    const A = new Map(a.kv.map(([k, x]) => [keyOf(k, a, ha), f(x, ha)])),
      B = new Map(b.kv.map(([k, x]) => [keyOf(k, b, hb), f(x, hb)]));
    const out = [];
    for (const [k, x] of B) {
      if (!A.has(k)) out.push(`${name}[${k}] = ${x} (new key)`);
      else if (A.get(k) !== x) out.push(`${name}[${k}]: ${A.get(k)} → ${x}`);
    }
    for (const k of A.keys()) if (!B.has(k)) out.push(`${SYN.del} ${name}[${k}]`);
    return out.slice(0, 3);
  }
  if (a.t === "set" && b.t === "set") {
    const A = new Set(a.v.map((x) => f(x, ha))),
      B = new Set(b.v.map((x) => f(x, hb)));
    return [
      ...[...B].filter((x) => !A.has(x)).map((x) => `${name}.add(${x})`),
      ...[...A].filter((x) => !B.has(x)).map((x) => `${name}.${SYN.drop}(${x})`),
    ].slice(0, 3);
  }
  if (a.t === "obj" && b.t === "obj") {
    const out = [];
    for (const [k, x] of b.a) {
      const old = attr(a, k);
      if (old === undefined || f(old, ha) !== f(x, hb)) out.push(`${name}.${k} = ${f(x, hb)}`);
    }
    return out.slice(0, 3);
  }
  return [];
}
const indent = (line) => (line.match(/^\s*/) || [""])[0].length;
// For a line that tests something (if/while/for), whether the program went into the block, read from where it went next.
function branch(code, ranLine, nextLine) {
  const ran = code[ranLine - 1] || "",
    next = code[nextLine - 1] || "";
  const m = /^\s*(?:}\s*else\s+)?(if|elif|while|for)\b/.exec(ran);
  if (!m || !nextLine || nextLine === ranLine) return ""; // (`if (x) return y`: the next step is on the same line)
  const inside = indent(next) > indent(ran) && nextLine > ranLine;
  if (m[1] === "for") return inside ? "next item, go into the loop" : "no items left, the loop ends";
  if (m[1] === "while") return inside ? "condition true, loop again" : "condition false, the loop ends";
  return inside ? "condition true" : "condition false";
}

// ---------------------------------------------------------------- small DOM helpers (views update in place, so changes can animate)
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const flash = (e, cls = "chg") => {
  e.classList.remove(cls);
  void e.offsetWidth; // restart the animation
  e.classList.add(cls);
};
const fit = (e, text) => {
  e.classList.toggle("long", text.length > 3 && text.length <= 6);
  e.classList.toggle("xlong", text.length > 6);
  e.title = text.length > 6 ? text : "";
};

// A row of cells: lists, tuples, deques and indexed strings. Index pointers slide under the cells; a lo..hi window dims the rest.
class ArrayView {
  constructor() {
    this.el = el("div", "vz-arr");
    this.cells = el("div", "vz-cells");
    this.ptrs = el("div", "vz-ptrs");
    this.el.append(this.cells, this.ptrs);
    this.ptrEls = new Map();
    this.prev = [];
  }
  // bars: draw numbers as bar heights (sorting); `nums` are the numeric values, or null when the list isn't all numbers
  update(items, ptrs, animate, nums = null, bars = false, meta = []) {
    const cells = this.cells;
    this.el.classList.toggle("bars", bars && !!nums);
    while (cells.children.length < items.length) {
      const c = el("div", "vz-cell");
      c.append(el("span", "vz-v"), el("span", "vz-i", String(cells.children.length)), el("i", "vz-bar"));
      if (animate) c.classList.add("enter");
      cells.append(c);
    }
    while (cells.children.length > items.length) cells.lastElementChild.remove();
    const swapped = animate ? swapOf(this.prev, items) : null;
    const top = nums ? Math.max(1e-9, ...nums.map(Math.abs)) : 1;
    items.forEach((text, i) => {
      const c = cells.children[i],
        v = c.firstChild;
      if (nums) {
        c.style.setProperty("--h", String(Math.max(0.04, Math.abs(nums[i]) / top)));
        c.classList.toggle("neg", nums[i] < 0);
      }
      if (v.textContent !== text) {
        v.textContent = text;
        fit(v, text);
        if (animate && this.prev.length) flash(c);
      }
    });
    if (swapped) {
      const [i, j] = swapped;
      for (const [a, b] of [
        [i, j],
        [j, i],
      ]) {
        const c = cells.children[a];
        c.style.transition = "none";
        c.style.transform = `translateX(${(b - a) * CELL}px)`;
        void c.offsetWidth;
        c.style.transition = "";
        c.style.transform = "";
      }
    }
    // window between a pair of pointers (binary search, two pointers)
    const at = new Map(ptrs.map((p) => [p.name, p.idx]));
    const pair = RANGE_PAIRS.find(([a, b]) => at.has(a) && at.has(b));
    [...cells.children].forEach((c, i) => c.classList.toggle("out", !!pair && (i < at.get(pair[0]) || i > at.get(pair[1]))));
    // pointers: one label per variable, stacked when several share a cell
    const level = new Map();
    const seen = new Set();
    for (const p of [...ptrs, ...meta]) {
      let e = this.ptrEls.get(p.name);
      if (!e) {
        e = el("div", "vz-ptr", p.name);
        e.prepend(el("i"));
        e.style.transform = `translateX(${p.idx * CELL}px)`;
        this.ptrs.append(e);
        this.ptrEls.set(p.name, e);
      }
      const lv = level.get(p.idx) || 0;
      level.set(p.idx, lv + 1);
      e.style.transform = `translateX(${p.idx * CELL}px) translateY(${lv * 16}px)`;
      e.classList.toggle("past", p.idx >= items.length);
      e.classList.toggle("probe", !!p.probe);
      e.classList.toggle("meta", !!p.meta);
      seen.add(p.name);
    }
    for (const [name, e] of this.ptrEls)
      if (!seen.has(name)) {
        e.remove();
        this.ptrEls.delete(name);
      }
    this.ptrs.style.height = `${Math.max(0, ...level.values()) * 16 + 4}px`;
    this.prev = items;
  }
}
function swapOf(a, b) {
  if (a.length !== b.length) return null;
  const ch = a.map((x, i) => (x !== b[i] ? i : -1)).filter((i) => i >= 0);
  return ch.length === 2 && a[ch[0]] === b[ch[1]] && a[ch[1]] === b[ch[0]] ? ch : null;
}

// A table: lists of equal-length lists (DP tables, boards, matrices). The current cell and its row/column are marked.
class GridView {
  constructor() {
    this.el = el("div", "vz-grid");
    this.prev = [];
  }
  update(rows, cur, animate) {
    const h = rows.length,
      w = rows[0] ? rows[0].length : 0;
    if (this.h !== h || this.w !== w) {
      this.el.replaceChildren();
      this.el.style.gridTemplateColumns = `18px repeat(${w}, minmax(26px, auto))`;
      this.el.append(el("span", "vz-gh"));
      for (let c = 0; c < w; c++) this.el.append(el("span", "vz-gh", String(c)));
      this.cells = [];
      for (let r = 0; r < h; r++) {
        this.el.append(el("span", "vz-gh", String(r)));
        this.cells.push([]);
        for (let c = 0; c < w; c++) {
          const e = el("span", "vz-gc");
          this.el.append(e);
          this.cells[r].push(e);
        }
      }
      this.h = h;
      this.w = w;
      this.prev = [];
    }
    rows.forEach((row, r) =>
      row.forEach((text, c) => {
        const e = this.cells[r][c];
        if (e.textContent !== text) {
          e.textContent = text;
          fit(e, text);
          if (animate && this.prev.length) flash(e);
        }
        e.classList.toggle("cur", !!cur && cur[0] === r && cur[1] === c);
        e.classList.toggle("line", !!cur && (cur[0] === r || cur[1] === c) && !(cur[0] === r && cur[1] === c));
      }),
    );
    this.prev = rows;
  }
}

// Key -> value rows; new keys slide in, changed values flash, the key being looked at is marked.
class DictView {
  constructor() {
    this.el = el("div", "vz-dict");
    this.rows = new Map();
  }
  update(pairs, hot, animate) {
    const seen = new Set();
    pairs.forEach(([k, v], i) => {
      let row = this.rows.get(k);
      if (!row) {
        row = el("div", "vz-kv");
        row.append(el("span", "vz-k", k), el("span", "vz-val"));
        if (animate) row.classList.add("enter");
        this.rows.set(k, row);
      }
      const val = row.lastChild;
      if (val.textContent !== v) {
        const first = val.textContent === "";
        val.textContent = v;
        if (animate && !first) flash(row);
      }
      row.classList.toggle("hot", hot.has(k));
      if (this.el.children[i] !== row) this.el.insertBefore(row, this.el.children[i] || null);
      seen.add(k);
    });
    for (const [k, row] of this.rows)
      if (!seen.has(k)) {
        row.remove();
        this.rows.delete(k);
      }
    if (!pairs.length) this.el.replaceChildren(el("span", "vz-empty", "empty"));
    else this.el.querySelector(".vz-empty")?.remove();
  }
}

// Set members as chips.
class SetView {
  constructor() {
    this.el = el("div", "vz-set");
    this.items = new Map();
  }
  update(items, animate, hot = new Set()) {
    const seen = new Set();
    items.forEach((t, i) => {
      let c = this.items.get(t);
      if (!c) {
        c = el("span", "vz-chip", t);
        if (animate) c.classList.add("enter");
        this.items.set(t, c);
      }
      c.classList.toggle("hot", hot.has(t));
      if (this.el.children[i] !== c) this.el.insertBefore(c, this.el.children[i] || null);
      seen.add(t);
    });
    for (const [t, c] of this.items)
      if (!seen.has(t)) {
        c.remove();
        this.items.delete(t);
      }
    if (!items.length) this.el.replaceChildren(el("span", "vz-empty", "empty"));
    else this.el.querySelector(".vz-empty")?.remove();
  }
}

// A heap (a list the code passes to heapq): the same list drawn as the binary tree it stands for (children of i at 2i+1, 2i+2),
// with the list itself underneath. The smallest item is always at the top.
class HeapView {
  constructor() {
    this.el = el("div", "vz-heap");
    this.tree = el("div", "vz-nodes");
    this.svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.svg.classList.add("vz-links");
    this.tree.append(this.svg);
    this.arr = new ArrayView();
    this.el.append(this.tree, this.arr.el);
    this.nodes = [];
  }
  update(items, ptrs, animate) {
    const n = items.length,
      levels = Math.max(1, Math.ceil(Math.log2(n + 1))),
      W = Math.max(2 ** (levels - 1) * 44, 80),
      R = 17;
    const pos = items.map((_, i) => {
      const lv = Math.floor(Math.log2(i + 1)),
        k = i + 1 - 2 ** lv;
      return [((k + 0.5) * W) / 2 ** lv, lv * 52 + 24];
    });
    this.tree.style.width = `${W}px`;
    this.tree.style.height = `${levels * 52 + 6}px`;
    this.svg.setAttribute("width", String(W));
    this.svg.setAttribute("height", String(levels * 52 + 6));
    this.svg.innerHTML = items
      .map((_, i) =>
        i ? `<path class="vz-link" d="M${pos[(i - 1) >> 1][0]},${pos[(i - 1) >> 1][1] + R} L${pos[i][0]},${pos[i][1] - R}"/>` : "",
      )
      .join("");
    while (this.nodes.length < n) {
      const e = el("div", "vz-node");
      e.append(el("span", "vz-nv"));
      if (animate) e.classList.add("enter");
      this.tree.append(e);
      this.nodes.push(e);
    }
    while (this.nodes.length > n) this.nodes.pop().remove();
    const hot = new Set(ptrs.map((p) => p.idx));
    items.forEach((text, i) => {
      const e = this.nodes[i];
      e.style.transform = `translate(${pos[i][0] - R - 1}px, ${pos[i][1] - R - 1}px)`;
      if (e.firstChild.textContent !== text) {
        if (e.firstChild.textContent && animate) flash(e);
        e.firstChild.textContent = text;
      }
      e.title = text;
      e.classList.toggle("hot", hot.has(i) || i === 0);
    });
    this.arr.update(items, ptrs, animate);
  }
}

// A stack (a list used with append and pop()): a column with the top at the top; pushes slide in, pops slide out.
class StackView {
  constructor() {
    this.el = el("div", "vz-stack");
    this.items = [];
  }
  update(items, animate) {
    while (this.items.length > items.length) {
      const e = this.items.pop();
      if (animate) {
        e.classList.add("leave");
        setTimeout(() => e.remove(), 260);
      } else e.remove();
    }
    while (this.items.length < items.length) {
      const e = el("div", "vz-sitem");
      e.append(el("span", "vz-v"), el("span", "vz-si", String(this.items.length)));
      if (animate) e.classList.add("enter");
      this.el.prepend(e); // the newest item is on top
      this.items.push(e);
    }
    items.forEach((text, i) => {
      const e = this.items[i];
      if (e.firstChild.textContent !== text) {
        if (e.firstChild.textContent && animate) flash(e);
        e.firstChild.textContent = text;
        e.title = text;
      }
      e.classList.toggle("top", i === items.length - 1);
    });
    this.el.classList.toggle("empty", !items.length);
  }
}

// [start, end] pairs on a number line, each interval in the first lane where it doesn't overlap another.
class IntervalsView {
  constructor() {
    this.el = el("div", "vz-ivl");
    this.axis = el("div", "vz-axis");
    this.el.append(this.axis);
    this.bars = new Map();
  }
  update(pairs, hot, animate) {
    const lo = Math.min(...pairs.map((p) => p[0])),
      hi = Math.max(...pairs.map((p) => p[1]));
    const span = Math.max(1, hi - lo),
      scale = Math.max(6, Math.min(40, 340 / span));
    const x = (v) => (v - lo) * scale + 8;
    const lanes = [];
    const order = pairs.map((p, i) => [p, i]).sort((a, b) => a[0][0] - b[0][0] || a[0][1] - b[0][1]);
    const laneOf = new Map();
    for (const [[a, b], i] of order) {
      let l = lanes.findIndex((end) => end < a);
      if (l < 0) l = lanes.push(-Infinity) - 1;
      lanes[l] = b;
      laneOf.set(i, l);
    }
    this.el.style.width = `${x(hi) + 30}px`;
    this.el.style.height = `${lanes.length * 26 + 30}px`;
    const step = span <= 20 ? 1 : Math.ceil(span / 10);
    this.axis.replaceChildren();
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      const t = el("span", "vz-tick", String(v));
      t.style.left = `${x(v)}px`;
      this.axis.append(t);
    }
    const seen = new Set();
    pairs.forEach(([a, b], i) => {
      let bar = this.bars.get(i);
      if (!bar) {
        bar = el("div", "vz-ival");
        if (animate) bar.classList.add("enter");
        this.el.append(bar);
        this.bars.set(i, bar);
      }
      const text = `${a}–${b}`;
      if (bar.textContent !== text) {
        if (bar.textContent && animate) flash(bar);
        bar.textContent = text;
      }
      bar.style.transform = `translate(${x(a)}px, ${laneOf.get(i) * 26}px)`;
      bar.style.width = `${Math.max(18, (b - a) * scale)}px`;
      bar.classList.toggle("hot", hot.has(i));
      seen.add(i);
    });
    for (const [i, bar] of this.bars)
      if (!seen.has(i)) {
        bar.remove();
        this.bars.delete(i);
      }
  }
}

// A number used with bit operators (&, |, ^, <<, >>, ~), drawn as its bits; bits that changed flash.
class BitsView {
  constructor() {
    this.el = el("div", "vz-bits");
    this.width = 4;
    this.prev = null;
  }
  update(n, animate) {
    const neg = n < 0,
      m = Math.abs(n);
    this.width = Math.max(this.width, m.toString(2).length); // never shrinks during a run, so bits keep their place
    const bits = m.toString(2).padStart(this.width, "0");
    if (this.el.children.length !== this.width + 1) {
      this.el.replaceChildren(el("span", "vz-sign"));
      for (let k = this.width - 1; k >= 0; k--) {
        const b = el("span", "vz-bit");
        b.append(el("span", "vz-v"), el("span", "vz-i", String(k)));
        this.el.append(b);
      }
    }
    this.el.firstChild.textContent = neg ? "−" : "";
    [...bits].forEach((bit, j) => {
      const b = this.el.children[j + 1];
      if (b.firstChild.textContent !== bit) {
        if (animate && this.prev !== null) flash(b);
        b.firstChild.textContent = bit;
      }
      b.classList.toggle("one", bit === "1");
    });
    this.prev = n;
  }
}

// Lists of lists that aren't a table (buckets, adjacency): one row per index, its items as chips.
class RowsView {
  constructor() {
    this.el = el("div", "vz-rows");
    this.rows = [];
  }
  update(rows, hot, animate) {
    while (this.rows.length < rows.length) {
      const r = el("div", "vz-row");
      r.append(el("span", "vz-ri", String(this.rows.length)), el("span", "vz-rv"));
      if (animate) r.classList.add("enter");
      this.el.append(r);
      this.rows.push({ el: r, text: null });
    }
    while (this.rows.length > rows.length) this.rows.pop().el.remove();
    rows.forEach((items, i) => {
      const r = this.rows[i];
      const text = items.join("|");
      if (r.text !== text) {
        r.el.lastChild.replaceChildren(...(items.length ? items.map((t) => el("span", "vz-chip", t)) : [el("span", "vz-empty", "empty")]));
        if (animate && r.text !== null) flash(r.el);
        r.text = text;
      }
      r.el.classList.toggle("hot", hot.has(i));
    });
  }
}

// A graph from an adjacency list: nodes on a circle, directed arrows (plain lines when both directions exist), marked nodes = the
// variables currently pointing at them.
class GraphView {
  constructor() {
    this.el = el("div", "vz-nodes vz-graph");
    this.svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.svg.classList.add("vz-links");
    this.svg.innerHTML =
      '<defs><marker id="vz-garrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z"/></marker></defs>';
    this.el.append(this.svg);
    this.nodeEls = new Map();
  }
  update({ nodes, edges }, labels, animate) {
    const n = nodes.length,
      rad = Math.max(46, n * 13),
      R = 16;
    const pos = new Map(
      nodes.map((id, i) => [
        id,
        [rad + 28 + rad * Math.cos((2 * Math.PI * i) / n - Math.PI / 2), rad + 26 + rad * Math.sin((2 * Math.PI * i) / n - Math.PI / 2)],
      ]),
    );
    const W = 2 * rad + 56,
      H = 2 * rad + 52;
    this.el.style.width = `${W}px`;
    this.el.style.height = `${H}px`;
    this.svg.setAttribute("width", String(W));
    this.svg.setAttribute("height", String(H));
    const set = new Set(edges.map(([a, b]) => `${a}>${b}`));
    const drawn = new Set();
    const paths = [];
    for (const [a, b] of edges) {
      if (!pos.has(a) || !pos.has(b) || a === b || drawn.has(`${a}>${b}`)) continue;
      const both = set.has(`${b}>${a}`);
      drawn.add(`${a}>${b}`);
      if (both) drawn.add(`${b}>${a}`);
      const [x1, y1] = pos.get(a),
        [x2, y2] = pos.get(b);
      const dx = x2 - x1,
        dy = y2 - y1,
        d = Math.hypot(dx, dy) || 1;
      paths.push(
        `<path class="vz-link" d="M${x1 + (dx / d) * R},${y1 + (dy / d) * R} L${x2 - (dx / d) * (R + 2)},${y2 - (dy / d) * (R + 2)}" ${both ? "" : 'marker-end="url(#vz-garrow)"'}/>`,
      );
    }
    this.svg.querySelectorAll(".vz-link").forEach((p) => p.remove());
    this.svg.insertAdjacentHTML("beforeend", paths.join(""));
    const keep = new Set();
    for (const id of nodes) {
      let e = this.nodeEls.get(id);
      if (!e) {
        e = el("div", "vz-node");
        e.append(el("span", "vz-nv", id), el("div", "vz-nl"));
        if (animate) e.classList.add("enter");
        this.el.append(e);
        this.nodeEls.set(id, e);
      }
      const [x, y] = pos.get(id);
      e.style.transform = `translate(${x - R - 2}px, ${y - R - 2}px)`;
      const names = labels.get(id) || [];
      e.lastChild.textContent = names.join(", ");
      e.classList.toggle("hot", names.length > 0);
      keep.add(id);
    }
    for (const [id, e] of this.nodeEls)
      if (!keep.has(id)) {
        e.remove();
        this.nodeEls.delete(id);
      }
  }
}

// Linked lists, trees and graphs: nodes as circles, links as arrows, and the variables pointing at a node above it.
// Node places are kept between steps (a node never jumps around), so relinking (reversing a list) is seen as arrows turning.
class NodesView {
  constructor() {
    this.el = el("div", "vz-nodes");
    this.svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.svg.classList.add("vz-links");
    this.svg.innerHTML =
      '<defs><marker id="vz-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z"/></marker></defs>';
    this.el.append(this.svg);
    this.nodeEls = new Map();
    this.slots = new Map(); // node id -> place in a chain
  }
  update(roots, heap, labels, animate, path = new Set()) {
    // every node reachable from the roots
    const ids = [],
      seen = new Set(),
      todo = [...roots];
    while (todo.length && ids.length < 60) {
      const id = todo.shift();
      if (seen.has(id) || !heap[id] || heap[id].t !== "obj") continue;
      seen.add(id);
      ids.push(id);
      for (const k of LINKS) {
        const v = attr(heap[id], k);
        if (isRef(v)) {
          const o = heap[v.r];
          if (o && o.t === "list") for (const x of o.v) isRef(x) && todo.push(x.r);
          else todo.push(v.r);
        }
      }
    }
    const tree = ids.some((id) => hasAttr(heap[id], "left") || hasAttr(heap[id], "right"));
    const graph = !tree && ids.some((id) => hasAttr(heap[id], "neighbors") || hasAttr(heap[id], "children"));
    const pos = new Map();
    const R = 18;
    if (tree) {
      // in-order position across, depth down
      let x = 0;
      const depth = new Map();
      const visit = (id, d, guard) => {
        if (!id || guard.has(id) || !heap[id]) return;
        guard.add(id);
        const l = attr(heap[id], "left"),
          r = attr(heap[id], "right");
        visit(isRef(l) && l.r, d + 1, guard);
        depth.set(id, d);
        pos.set(id, [x++ * 40 + 24, d * 58 + 34]);
        visit(isRef(r) && r.r, d + 1, guard);
      };
      const guard = new Set();
      for (const r of roots) if (!guard.has(r)) visit(r, 0, guard);
      ids.forEach((id) => !pos.has(id) && pos.set(id, [x++ * 40 + 24, 34]));
    } else if (graph) {
      const n = ids.length,
        rad = Math.max(50, n * 14);
      ids.forEach((id, i) =>
        pos.set(id, [
          rad + 30 + rad * Math.cos((2 * Math.PI * i) / n - Math.PI / 2),
          rad + 34 + rad * Math.sin((2 * Math.PI * i) / n - Math.PI / 2),
        ]),
      );
    } else {
      for (const id of ids) if (!this.slots.has(id)) this.slots.set(id, this.slots.size);
      const order = [...ids].sort((a, b) => this.slots.get(a) - this.slots.get(b));
      order.forEach((id, i) => pos.set(id, [i * 64 + 26, 56]));
    }
    const W = Math.max(...[...pos.values()].map((p) => p[0]), 0) + 34,
      H = Math.max(...[...pos.values()].map((p) => p[1]), 0) + (tree || graph ? 30 : 46);
    this.el.style.width = `${W}px`;
    this.el.style.height = `${H}px`;
    this.svg.setAttribute("width", String(W));
    this.svg.setAttribute("height", String(H));
    // links
    const paths = [];
    for (const id of ids) {
      const [x1, y1] = pos.get(id);
      for (const k of LINKS) {
        const v = attr(heap[id], k);
        const targets = isRef(v) ? (heap[v.r] && heap[v.r].t === "list" ? heap[v.r].v.filter(isRef).map((x) => x.r) : [v.r]) : [];
        for (const t of targets) {
          if (!pos.has(t)) continue;
          const [x2, y2] = pos.get(t);
          const dx = x2 - x1,
            dy = y2 - y1,
            d = Math.hypot(dx, dy) || 1;
          const sx = x1 + (dx / d) * R,
            sy = y1 + (dy / d) * R,
            ex = x2 - (dx / d) * (R + 2),
            ey = y2 - (dy / d) * (R + 2);
          const back = !tree && !graph && x2 <= x1;
          const bend = k === "prev" || k === "random" ? 26 : back ? -30 : Math.abs(this.slots.get(t) - this.slots.get(id)) > 1 ? -22 : 0;
          const cls = `vz-link ${k === "random" || k === "prev" || k === "parent" ? "dash" : ""}`;
          if (tree || graph || !bend)
            paths.push(
              `<path class="${cls}" d="M${sx},${sy} L${ex},${ey}" marker-end="${graph && k === "neighbors" ? "" : "url(#vz-arrow)"}"/>`,
            );
          else {
            const mx = (x1 + x2) / 2,
              my = y1 + bend * (back || bend > 0 ? -1 : 1) * -1;
            paths.push(
              `<path class="${cls}" d="M${x1},${y1 + (bend > 0 ? R : -R)} Q${mx},${my + (bend > 0 ? R : -R)} ${x2},${y2 + (bend > 0 ? R : -R)}" marker-end="url(#vz-arrow)"/>`,
            );
          }
        }
      }
    }
    this.svg.querySelectorAll(".vz-link").forEach((p) => p.remove());
    this.svg.insertAdjacentHTML("beforeend", paths.join(""));
    // nodes
    const keep = new Set();
    for (const id of ids) {
      let n = this.nodeEls.get(id);
      const text = nodeLabel(heap[id], heap) ?? heap[id].cls;
      if (!n) {
        n = el("div", "vz-node");
        n.append(el("span", "vz-nv"), el("div", "vz-nl"));
        if (animate) n.classList.add("enter");
        this.el.append(n);
        this.nodeEls.set(id, n);
        n.style.transform = `translate(${pos.get(id)[0] - R}px, ${pos.get(id)[1] - R}px)`;
      }
      const v = n.firstChild;
      if (v.textContent !== String(text)) {
        if (v.textContent && animate) flash(n);
        v.textContent = String(text);
      }
      n.style.transform = `translate(${pos.get(id)[0] - R}px, ${pos.get(id)[1] - R}px)`;
      const names = labels.get(id) || [];
      n.lastChild.textContent = names.join(", ");
      n.classList.toggle("hot", names.length > 0);
      n.classList.toggle("path", !names.length && path.has(id));
      keep.add(id);
    }
    for (const [id, n] of this.nodeEls)
      if (!keep.has(id)) {
        n.remove();
        this.nodeEls.delete(id);
      }
  }
}

// ---------------------------------------------------------------- the call tree (who called whom, and what came back)
const clip = (t, n) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
/** Every call the run made, as a tree built from the trace: { id, label, full, value, call, ret, last, children }. call / ret / last are
 * step numbers (ret is -1 when the call raised instead of returning). The root (id 0) stands for the input, which made the first calls. */
export function callTree(steps) {
  const root = { id: 0, label: "run", full: "run", value: null, call: 0, ret: -1, last: Infinity, children: [] };
  const nodes = new Map();
  steps.forEach((s, i) => {
    s.stack.forEach((f, d) => {
      let n = nodes.get(f.id);
      if (!n) {
        // the arguments are the frame's parameters at its call (its other locals include a closure's outer variables)
        const loc = new Map(f.loc);
        const args = (s.ev === "call" && d === s.stack.length - 1 ? s.params || [] : [])
          .filter((k) => k !== "self" && loc.has(k))
          .map((k) => fmt(loc.get(k), s.heap));
        const name = fnName(f.fn);
        const call = f.fn === "<module>" ? name : `${name}(${args.join(", ")})`;
        const label = f.fn === "<module>" ? name : `${name}(${args.map((a) => clip(a, 16)).join(", ")})`;
        n = { id: f.id, label: clip(label, 30), full: call, value: null, call: i, ret: -1, last: i, children: [] };
        (d ? nodes.get(s.stack[d - 1].id) : root).children.push(n);
        nodes.set(f.id, n);
      }
      n.last = i;
    });
    if (s.ev === "return") {
      const n = nodes.get(s.stack[s.stack.length - 1].id);
      n.ret = i;
      n.value = fmt(s.ret, s.heap);
    }
  });
  return root;
}

// Draws the call tree, growing as the run goes: a call appears when it's made, the calls on the stack are the path down to the current one,
// and a finished call shows what it returned. Places come from the whole run, so nothing moves while it plays. Click a call to go there.
const CT_ROW = 64,
  CT_GAP = 12;
class CallTreeView {
  constructor(onPick) {
    this.el = el("div", "vz-ctree");
    this.onPick = onPick;
    this.items = [];
  }
  build(root) {
    const top = root.children.length === 1 ? root.children[0] : root; // one first call is the root; several (a class's calls) hang under "run"
    // each subtree gets the room of its widest level: leaves side by side, a parent centred over its children
    let depth = 0;
    const size = (n, d) => {
      n.d = d;
      depth = Math.max(depth, d);
      n.w = Math.min(200, Math.max(46, Math.max(n.label.length, n.value ? Math.min(n.value.length, 24) + 2 : 0) * 7 + 18));
      const kids = n.children.reduce((a, c) => a + size(c, d + 1) + CT_GAP, -CT_GAP);
      return (n.span = Math.max(n.w, kids));
    };
    const placed = [];
    const place = (n, left, parent) => {
      n.x = left + n.span / 2;
      placed.push([n, parent]);
      const kids = n.children.reduce((a, c) => a + c.span + CT_GAP, -CT_GAP);
      let x = left + (n.span - Math.max(0, kids)) / 2;
      for (const c of n.children) {
        place(c, x, n);
        x += c.span + CT_GAP;
      }
    };
    size(top, 0);
    place(top, 8, null);
    const W = top.span + 16,
      H = depth * CT_ROW + 52;
    const svg = svgEl("svg");
    svg.classList.add("vz-links");
    svg.setAttribute("width", String(W));
    svg.setAttribute("height", String(H));
    this.el.replaceChildren(svg);
    this.el.style.width = `${W}px`;
    this.el.style.height = `${H}px`;
    this.items = placed.map(([n, parent]) => {
      const b = el("button", "vz-cnode");
      b.append(el("span", "vz-cl", n.label), el("span", "vz-cr"));
      b.style.cssText = `left:${n.x - n.w / 2}px;top:${n.d * CT_ROW + 6}px;width:${n.w}px`;
      b.title = n.value === null ? n.full : `${n.full} → ${n.value}`;
      if (n.id) b.onclick = () => this.onPick(n.call);
      this.el.append(b);
      let path = null;
      if (parent) {
        const y1 = parent.d * CT_ROW + 44,
          y2 = n.d * CT_ROW + 6;
        path = svgEl("path");
        path.setAttribute("class", "vz-link");
        path.setAttribute("d", `M${parent.x},${y1} C${parent.x},${(y1 + y2) / 2} ${n.x},${(y1 + y2) / 2} ${n.x},${y2}`);
        svg.append(path);
      }
      return { n, b, path };
    });
  }
  update(i, step) {
    const live = new Set(step.stack.map((f) => f.id)),
      cur = step.stack.length ? step.stack[step.stack.length - 1].id : -1;
    let curEl = null;
    for (const { n, b, path } of this.items) {
      const shown = !n.id || n.call <= i;
      const done = n.ret >= 0 && n.ret <= i;
      const raised = !!n.id && !done && !live.has(n.id) && n.last < i;
      b.classList.toggle("off", !shown);
      b.classList.toggle("live", live.has(n.id));
      b.classList.toggle("cur", n.id === cur);
      b.classList.toggle("done", done);
      b.classList.toggle("bad", raised);
      b.lastChild.textContent = done ? `→ ${clip(n.value, 24)}` : raised ? "raised" : "";
      path?.classList.toggle("off", !shown);
      path?.classList.toggle("live", live.has(n.id));
      if (n.id === cur) curEl = b;
    }
    // keep the current call in view
    const pane = this.el.parentElement;
    if (curEl && pane) {
      const x = this.el.offsetLeft + curEl.offsetLeft + curEl.offsetWidth / 2,
        y = this.el.offsetTop + curEl.offsetTop + curEl.offsetHeight / 2;
      if (x < pane.scrollLeft || x > pane.scrollLeft + pane.clientWidth || y < pane.scrollTop || y > pane.scrollTop + pane.clientHeight)
        pane.scrollTo({ left: x - pane.clientWidth / 2, top: y - pane.clientHeight / 2 });
    }
  }
}

// The code as a tree of statements (from Python's own parser): what is inside what. The statements around the line about to run are
// marked, and each shows how many times its line has run so far. Click one to go to the next time it runs.
class CodeTreeView {
  constructor(onPick) {
    this.el = el("div", "vz-otree");
    this.onPick = onPick;
    this.items = [];
  }
  build(outline, code) {
    this.items = [];
    const list = (nodes) => {
      const ul = el("ul");
      for (const n of nodes) {
        const b = el("button", "vz-onode");
        b.append(
          el("span", `vz-ok k-${n.t.replace(/ /g, "-")}`, n.t),
          el("span", "vz-os", (code[n.l - 1] || "").trim()),
          el("span", "vz-oc"),
        );
        b.title = `Line ${n.l}: go to the next time it runs`;
        b.onclick = () => this.onPick(n.l);
        const li = el("li");
        li.append(b);
        if (n.c.length) li.append(list(n.c));
        ul.append(li);
        this.items.push({ n, b });
      }
      return ul;
    };
    this.el.replaceChildren(outline.length ? list(outline) : el("span", "vz-empty", "No statements"));
  }
  update(line, counts) {
    let cur = null;
    for (const it of this.items) {
      const on = line >= it.n.l && line <= it.n.e;
      it.b.classList.toggle("on", on);
      if (on && (!cur || it.n.l >= cur.n.l)) cur = it; // the innermost statement (a child comes after its parent)
      const k = counts.get(it.n.l) || 0;
      it.b.lastChild.textContent = k ? `×${k}` : "";
    }
    for (const it of this.items) it.b.classList.toggle("cur", it === cur);
    cur?.b.scrollIntoView({ block: "nearest" });
  }
}

// ---------------------------------------------------------------- the player
// Code selected on a page is often indented (a method out of its class) and may hold non-breaking spaces: Python takes neither.
export function clean(code) {
  const lines = code
    .replace(/\u00a0/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/^\s*\n|\s+$/g, "")
    .split("\n");
  const pad = Math.min(...lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)[0].length));
  return lines.map((l) => l.slice(pad)).join("\n");
}

/** Python or JavaScript, from how the code looks (code selected on a page doesn't say which). Ties go to Python. */
export function detectLanguage(code) {
  const count = (tests) => tests.filter((re) => re.test(code)).length;
  const py = count([
    /^\s*(async\s+)?def \w+\s*\(.*\)\s*(->[^:]*)?:\s*(#.*)?$/m,
    /^\s*(if|elif|else|for|while|try|except|finally|with|class)\b[^{;]*:\s*(#.*)?$/m,
    /\b(None|True|False|elif|self|lambda|nonlocal)\b/,
    /^\s*#/m,
    /^\s*from\s+[\w.]+\s+import\b/m,
    /\b(and|or|not) /,
  ]);
  const js = count([
    /\b(function|const|let|var|undefined|null)\b/,
    /=>/,
    /[;{}]\s*$/m,
    /===|!==|&&|\|\|/,
    /^\s*\/\//m,
    /\bthis\./,
    /\bconsole\.\w+\(/,
  ]);
  return js > py ? "javascript" : "python";
}

/** The whole app, in `host`; `picker` is the examples <select>. Returns { take(code, input, lang) }: run code from elsewhere (null: the
 * first example; the language is detected when not given), and { now() }: the code, input and language as they are.
 * @param {HTMLElement} host @param {HTMLSelectElement} picker @param {{ group: string, title: string, code: string, input: string }[]} examples */
export function mountApp(host, picker, examples) {
  let code = []; // the lines of the code that was traced
  let tracedCode = null,
    tracedLang = null,
    suggested = null; // the input that was filled in for the user (replaced when the code changes)
  let result = null; // the trace
  let i = 0,
    playing = false,
    speed = 1,
    timer = null,
    tab = "data";

  // static parts
  const editKeys = (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      run();
    } else if (e.key === "Tab" && !e.shiftKey && e.target === editor) {
      e.preventDefault();
      document.execCommand("insertText", false, "    "); // (keeps undo working; Esc then Tab leaves the editor)
    } else if (e.key === "Escape") e.target.blur();
  };
  const editor = h("textarea.vz-editor", { spellcheck: false, ariaLabel: "Code", onkeydown: editKeys });
  const langPick = h(
    "select.vz-lang",
    { ariaLabel: "Language" },
    h("option", { value: "python", textContent: "Python" }),
    h("option", { value: "javascript", textContent: "JavaScript" }),
  );
  editor.setAttribute("autocapitalize", "off");
  const input = h("textarea.vz-input", {
    spellcheck: false,
    rows: 2,
    ariaLabel: "Input: the call to run",
    placeholder: "e.g. fib(5). Leave empty to run a script as is, or to get a suggested call.",
    onkeydown: editKeys,
  });
  const runBtn = h("button.primary.vz-run", { textContent: "Run", title: "Run (Ctrl+Enter)", onclick: () => run() });
  const editBtn = h("button.vz-btn.vz-edit", { textContent: "Edit code", hidden: true, onclick: () => edit(true) });
  const note = h("p.vz-note");
  const codeBox = h("div.vz-code", { hidden: true });
  const caption = h("div.vz-caption");
  const stage = h("div.vz-stage");
  const outBox = h("div.vz-out");
  const status = h("p.vz-status");
  const counter = h("span.vz-count");
  const slider = h("input.vz-slider", {
    type: "range",
    min: 0,
    max: 0,
    value: 0,
    ariaLabel: "Step",
    oninput: () => go(+slider.value, false),
  });
  const btn = (label, title, fn) => h("button.vz-btn", { textContent: label, title, ariaLabel: title, onclick: fn });
  const playBtn = btn("▶", "Play / pause (space)", () => toggle());
  const speedBtn = btn("1×", "Speed", () => {
    speed = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
    speedBtn.textContent = `${speed}×`;
    host.style.setProperty("--vz-dur", `${Math.round(320 / speed)}ms`);
    if (playing) schedule();
  });
  // the pictures: the data (frames and their structures), the call tree, the code's statement tree
  const calls = new CallTreeView((n) => go(n));
  const codeTree = new CodeTreeView((line) => jumpToLine(line));
  const panes = { data: stage, calls: h("div.vz-pane", {}, calls.el), outline: h("div.vz-pane", {}, codeTree.el) };
  const TABS = { data: "Data", calls: "Call tree", outline: "Code tree" };
  const tabBtns = Object.entries(TABS).map(([k, label]) => h("button.vz-tab", { textContent: label, onclick: () => show(k) }));
  const controls = h(
    "div.vz-controls",
    {},
    btn("⏮", "First step (Home)", () => go(0)),
    btn("◀", "Back (←)", () => go(i - 1)),
    playBtn,
    btn("▶❘", "Next (→)", () => go(i + 1)),
    btn("⏭", "Last step (End)", () => go(steps().length - 1)),
    slider,
    counter,
    speedBtn,
  );
  host.append(
    h(
      "div.vz-body",
      {},
      h(
        "section.vz-left",
        { ariaLabel: "Code and input" },
        h("div.vz-head", {}, langPick, editBtn),
        editor,
        codeBox,
        h("div.vz-head", {}, h("b", { textContent: "Input" })),
        h("div.vz-inrow", {}, input, runBtn),
        note,
        status,
      ),
      h(
        "section.vz-right",
        { ariaLabel: "What the program does" },
        caption,
        h("div.vz-tabs", { role: "group", ariaLabel: "Picture" }, tabBtns),
        ...Object.values(panes),
        outBox,
      ),
    ),
    controls,
  );

  const steps = () => (result ? result.steps : []);
  const currentStep = () => steps()[i];
  function onKey(e) {
    // typing goes to the text boxes; a focused slider or button already handles its own keys
    if (e.target.matches("textarea, input, select") || (e.key === " " && e.target.matches("button")) || e.ctrlKey || e.metaKey || e.altKey)
      return;
    if (e.key === "ArrowRight") go(i + 1);
    else if (e.key === "ArrowLeft") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(steps().length - 1);
    else if (e.key === " ") toggle();
    else return;
    e.preventDefault();
  }
  function show(k) {
    tab = k;
    for (const [name, pane] of Object.entries(panes)) pane.hidden = name !== k;
    tabBtns.forEach((b, n) => (b.ariaPressed = String(Object.keys(TABS)[n] === k)));
    if (steps().length) draw(false);
  }
  function edit(on) {
    editor.hidden = !on;
    codeBox.hidden = on;
    editBtn.hidden = on;
    if (on) {
      stop();
      editor.focus();
    }
  }
  // the code panel shows the traced code, line by line; a click on a line goes to the next time it runs
  function setCode(src) {
    code = src.split("\n");
    codeBox.replaceChildren(
      ...code.map((line, n) =>
        h(
          "div.vz-line",
          { title: "Go to the next time this line runs", onclick: () => jumpToLine(n + 1) },
          h("span.vz-ln", { textContent: String(n + 1) }),
          h("span.vz-hits"),
          h("span.vz-src", { textContent: line || " " }),
        ),
      ),
    );
  }
  function jumpToLine(line) {
    const all = steps();
    const at = (k) => all[k].ev === "line" && all[k].line === line;
    let k = all.findIndex((_, n) => n > i && at(n));
    if (k < 0) k = all.findIndex((_, n) => at(n)); // (wraps around to the first time)
    if (k >= 0) go(k);
  }
  function load(ex) {
    editor.value = ex.code;
    input.value = ex.input;
    langPick.value = ex.lang;
    suggested = null;
    picker.value = String(examples.indexOf(ex));
    run();
  }
  function stop() {
    playing = false;
    clearTimeout(timer);
    playBtn.textContent = "▶";
  }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (i >= steps().length - 1) return stop();
      go(i + 1);
      schedule();
    }, STEP_MS / speed);
  }
  function toggle() {
    if (!steps().length) return;
    if (playing) return stop();
    if (i >= steps().length - 1) go(0);
    playing = true;
    playBtn.textContent = "⏸";
    schedule();
  }

  // views live as long as their frame and variable, so a change animates instead of redrawing
  const frameEls = new Map(); // frame id -> { el, vars, views: Map(name -> { kind, view, wrap }) }
  const barsPref = new Map(); // "function:variable" -> draw that number list as bars
  function go(n, fromUser = true) {
    const all = steps();
    if (!all.length) return;
    n = Math.max(0, Math.min(all.length - 1, n));
    const animate = Math.abs(n - i) === 1 || n === i;
    if (fromUser && playing && n !== i + 1) stop();
    i = n;
    draw(animate);
  }

  function draw(animate) {
    const all = steps(),
      s = all[i],
      prev = all[i - 1];
    slider.max = String(all.length - 1);
    slider.value = String(i);
    counter.textContent = `${i + 1} / ${all.length}`;
    // code: the line about to run, the line that just ran, and how many times each line has run so far (also in the code tree)
    const ran = prev && prev.stack.length ? prev.line : 0;
    const counts = new Map();
    for (let k = 0; k <= i; k++) if (all[k].ev === "line") counts.set(all[k].line, (counts.get(all[k].line) || 0) + 1);
    [...codeBox.children].forEach((line, n) => {
      line.classList.toggle("cur", n + 1 === s.line);
      line.classList.toggle("ran", n + 1 === ran && ran !== s.line);
      line.classList.toggle("bad", n + 1 === s.line && s.ev === "exception");
      const hits = counts.has(n + 1) ? `×${counts.get(n + 1)}` : "";
      if (line.children[1].textContent !== hits) line.children[1].textContent = hits;
    });
    const curLine = codeBox.children[s.line - 1];
    if (curLine) {
      const top = curLine.offsetTop, // (.vz-code is positioned, so this is already measured from its top)
        bottom = top + curLine.offsetHeight;
      if (top < codeBox.scrollTop || bottom > codeBox.scrollTop + codeBox.clientHeight) codeBox.scrollTop = top - codeBox.clientHeight / 2;
    }
    caption.replaceChildren(...captionFor(s, prev));
    drawStack(s, prev, animate);
    if (tab === "calls") calls.update(i, s);
    else if (tab === "outline") codeTree.update(s.line, counts);
    // output and the final result
    const out = [...all.slice(0, i + 1)].reverse().find((x) => x.out)?.out;
    const last = i === all.length - 1;
    outBox.replaceChildren(
      ...(out ? [h("div.vz-label", { textContent: "Printed" }), h("pre.vz-print", { textContent: out })] : []),
      ...(last && result.result
        ? [h("div.vz-result", {}, h("span", { textContent: "Result " }), h("b", { textContent: fmt(result.result.v, result.result.heap) }))]
        : []),
      ...(last && result.error ? [h("div.vz-error", { textContent: result.error })] : []),
      ...(last && result.truncated
        ? [h("div.vz-error", { textContent: "Stopped after 1,500 steps. Try a smaller input to see the whole run." })]
        : []),
    );
  }

  function captionFor(s, prev) {
    const top = s.stack[s.stack.length - 1];
    const parts = [];
    const script = top.fn === "<module>";
    const args = top.loc.filter(([k]) => k !== "self" && (s.params || []).includes(k)); // (a closure's outer variables aren't arguments)
    if (s.ev === "call")
      parts.push(script ? "The program starts" : `${top.fn}(${args.map(([k, v]) => `${k}=${fmt(v, s.heap)}`).join(", ")})`);
    else if (s.ev === "return") parts.push(script ? "The program ends" : `${top.fn} returns ${fmt(s.ret, s.heap)}`);
    else if (s.ev === "exception") parts.push(s.exc);
    else if (prev) {
      const ptop = prev.stack[prev.stack.length - 1];
      if (prev.ev === "return" && ptop.id !== top.id)
        parts.push(`Back in ${fnName(top.fn)}, ${ptop.fn} returned ${fmt(prev.ret, prev.heap)}`);
      else if (prev.ev === "call" && ptop.id === top.id) parts.push(script ? "Start of the program" : `Start of ${top.fn}`);
      else if (ptop && ptop.id === top.id) {
        const changes = diff(variables(ptop, prev.heap), variables(top, s.heap), prev.heap, s.heap);
        const br = branch(code, prev.line, s.line);
        parts.push(...changes.slice(0, 3));
        if (br) parts.push(br);
        if (!parts.length) parts.push("No variable changed");
      }
    } else parts.push("Start");
    if (s.ev === "line") parts.push(...lookups(s, top).map((l) => l.text));
    const ranLine = prev && prev.ev === "line" && prev.stack.length ? prev.line : 0;
    return [
      h("span.vz-step", {
        textContent:
          ranLine && s.ev === "line"
            ? `Line ${ranLine} ran`
            : s.ev === "call"
              ? "Call"
              : s.ev === "return"
                ? "Return"
                : s.ev === "exception"
                  ? "Error"
                  : `Line ${s.line}`,
      }),
      h("span.vz-what", { textContent: parts.join(" · ") }),
    ];
  }

  // The lookups the line about to run will do, worked out from the current values: "next: is 9 - 7 = 2 in seen? yes".
  function lookups(s, frame) {
    const info = (result.pointers || {})[frame.fn];
    if (!info || !info.probes) return [];
    const vars = variables(frame, s.heap);
    const ints = new Map(vars.filter(([, v]) => Number.isInteger(v)).map(([k, v]) => [k, v]));
    const byName = new Map(vars);
    const out = [];
    for (const p of info.probes) {
      if (p.line !== s.line || !byName.has(p.on)) continue;
      const val = evaluate(p.e, ints);
      if (val === null) continue;
      const o = objOf(byName.get(p.on), s.heap);
      const key = keyOf(val, o, s.heap);
      const shown = p.text.replace(/\s+/g, " ");
      const math = shown === key ? key : `${shown} = ${key}`;
      if (p.kind === "in" && o) {
        const keys = o.t === "dict" ? o.kv.map(([k]) => keyOf(k, o, s.heap)) : (o.v || []).map((x) => fmt(x, s.heap));
        out.push({ on: p.on, key, idx: val, text: `next: is ${math} in ${p.on}? ${keys.includes(key) ? "yes" : "no"}` });
      } else out.push({ on: p.on, key, idx: val, label: shown, text: `next: reads ${p.on}[${math}]` });
    }
    return out.slice(0, 2);
  }

  function drawStack(s, prev, animate) {
    const live = new Set(s.stack.map((f) => f.id));
    for (const [id, fe] of frameEls)
      if (!live.has(id)) {
        fe.el.remove();
        frameEls.delete(id);
      }
    const prevFrames = new Map((prev ? prev.stack : []).map((f) => [f.id, f]));
    s.stack.forEach((f, depth) => {
      const isTop = depth === s.stack.length - 1;
      let fe = frameEls.get(f.id);
      if (!fe) {
        fe = {
          el: h("div.vz-frame"),
          head: h("div.vz-fhead"),
          scalars: h("div.vz-scalars"),
          structs: h("div.vz-structs"),
          views: new Map(),
          chips: new Map(),
        };
        fe.el.append(fe.head, fe.scalars, fe.structs);
        if (animate) fe.el.classList.add("enter");
        frameEls.set(f.id, fe);
      }
      if (stage.children[depth] !== fe.el) stage.insertBefore(fe.el, stage.children[depth] || null);
      fe.el.classList.toggle("top", isTop);
      fe.el.classList.toggle("ret", isTop && s.ev === "return");
      fe.head.textContent = `${f.fn === "<module>" ? "global frame" : `${f.fn}()`}${s.stack.length > 1 ? `  · depth ${depth + 1}` : ""}${isTop && s.ev === "return" ? `  → returns ${fmt(s.ret, s.heap)}` : ""}`;
      // nodes the outer frames point at (recursion on a tree): drawn too, so the top frame shows the whole tree and the path down it
      const outerNodes = s.stack.slice(0, depth).flatMap((o) => o.loc.filter(([, x]) => isNode(objOf(x, s.heap))).map(([, x]) => x.r));
      drawFrame(fe, f, s.heap, prevFrames.get(f.id), prev ? prev.heap : {}, animate && prevFrames.has(f.id), isTop, outerNodes);
    });
  }

  function drawFrame(fe, frame, heap, prevFrame, prevHeap, animate, isTop, outerNodes = []) {
    const vars = variables(frame, heap);
    const ptrInfo = (result.pointers || {})[frame.fn] || { idx: {}, keys: {}, grid: {} };
    const looks = isTop && currentStep().ev === "line" ? lookups(currentStep(), frame) : [];
    const ints = new Map(vars.filter(([, v]) => Number.isInteger(v)).map(([k, v]) => [k, v]));
    const valuesByName = new Map(vars.map(([k, v]) => [k, v]));
    // which variable points at which node (for lists, trees, graphs)
    const nodeLabels = new Map();
    for (const [k, v] of vars) {
      const o = objOf(v, heap);
      if (o && isNode(o)) nodeLabels.set(v.r, [...(nodeLabels.get(v.r) || []), k]);
    }
    const shownRefs = new Set();
    const seenNames = new Set();
    let order = 0;
    // structures first (in variable order), scalars as chips
    for (const [name, v] of vars) {
      const ptrs = (ptrInfo.idx[name] || [])
        .filter((p) => ints.has(p))
        .map((p) => ({ name: p, idx: ints.get(p) }))
        .filter((p) => {
          const len = typeof v === "string" ? v.length : (objOf(v, heap)?.v?.length ?? 0);
          return p.idx >= 0 && p.idx <= len;
        });
      for (const l of looks) {
        const len = typeof v === "string" ? v.length : (objOf(v, heap)?.v?.length ?? 0);
        if (l.on === name && l.label && Number.isInteger(l.idx) && l.idx >= 0 && l.idx < len)
          ptrs.push({ name: l.label, idx: l.idx, probe: true });
      }
      let kind = kindOf(v, heap, ptrs, name);
      if (kind === "scalar") continue;
      // how the code uses the list picks a richer picture (static, from the code: see analyse() in viz/tracer.py)
      const o0 = objOf(v, heap);
      if (o0 && (o0.t === "list" || o0.t === "deque") && ["array", "grid", "rows"].includes(kind)) {
        if ((ptrInfo.heaps || []).includes(name)) kind = "heap";
        else if ((ptrInfo.queues || []).includes(name))
          kind = "queue"; // (a deque used at both ends is a queue, not a stack)
        else if ((ptrInfo.stacks || []).includes(name)) kind = "stack";
        else if (o0.t === "deque") kind = "queue";
        else if (kind === "grid" && isIntervals(o0, heap, name, vars)) kind = "intervals";
      }
      if (isRef(v) && shownRefs.has(v.r)) {
        const owner = [...fe.views.values()].find((x) => x.ref === v.r);
        if (owner) owner.alias.add(name);
        continue;
      }
      if (kind === "nodes" && isRef(v) && [...shownRefs].some((r) => heap[r] && isNode(heap[r]))) continue; // one picture for all nodes
      if (isRef(v)) shownRefs.add(v.r);
      seenNames.add(name);
      let item = fe.views.get(name);
      if (!item || item.kind !== kind) {
        item?.wrap.remove();
        const VIEWS = {
          graph: GraphView,
          rows: RowsView,
          grid: GridView,
          dict: DictView,
          set: SetView,
          nodes: NodesView,
          array: ArrayView,
          chars: ArrayView,
          queue: ArrayView,
          heap: HeapView,
          stack: StackView,
          intervals: IntervalsView,
        };
        const view = kind === "obj" ? null : new VIEWS[kind]();
        const label = h("div.vz-sname");
        const wrap = h("div.vz-struct", {}, label);
        if (view) wrap.append(h("div.vz-scroll", {}, view.el));
        else wrap.append(h("div.vz-objbody"));
        item = { kind, view, wrap, label, alias: new Set() };
        fe.views.set(name, item);
        if (animate) wrap.classList.add("enter");
      }
      item.ref = isRef(v) ? v.r : null;
      item.alias = new Set();
      if (fe.structs.children[order] !== item.wrap) fe.structs.insertBefore(item.wrap, fe.structs.children[order] || null);
      order++;
      const o = objOf(v, heap);
      const typeText =
        typeof v === "string"
          ? `${SYN.js ? "string" : "str"} · ${v.length}`
          : o
            ? `${o.cls || SYN.names[o.t] || o.t}${o.n !== undefined ? ` · ${o.n}` : ""}`
            : "";
      const changedRef = prevFrame && (prevFrame.loc.find(([k]) => k === name) || [])[1];
      const reassigned = animate && changedRef !== undefined && isRef(changedRef) && isRef(v) && changedRef.r !== v.r;
      if (reassigned) flash(item.wrap, "chg-box");
      if (kind === "array" || kind === "chars") {
        const items = typeof v === "string" ? [...v] : o.v.map((x) => cellText(x, heap));
        const nums = typeof v !== "string" && o.v.length > 1 && o.v.every((x) => typeof x === "number") ? o.v : null;
        const key = `${frame.fn}:${name}`;
        if (nums && !barsPref.has(key)) barsPref.set(key, (ptrInfo.swaps || []).includes(name)); // sorting code starts as bars
        item.view.update(items, ptrs, animate && !reassigned, nums, !!nums && barsPref.get(key));
        item.toggle = nums ? key : null;
      } else if (kind === "queue") {
        const items = o.v.map((x) => itemText(x, heap));
        const meta = items.length
          ? [{ name: "front", idx: 0, meta: true }, ...(items.length > 1 ? [{ name: "back", idx: items.length - 1, meta: true }] : [])]
          : [];
        item.view.update(items, ptrs, animate && !reassigned, null, false, meta);
      } else if (kind === "heap")
        item.view.update(
          o.v.map((x) => itemText(x, heap)),
          ptrs,
          animate && !reassigned,
        );
      else if (kind === "stack")
        item.view.update(
          o.v.map((x) => itemText(x, heap)),
          animate && !reassigned,
        );
      else if (kind === "intervals") {
        item.view.update(
          o.v.map((x) => objOf(x, heap).v),
          new Set(ptrs.map((p) => p.idx)),
          animate && !reassigned,
        );
      } else if (kind === "grid") {
        const rows = o.v.map((r) => objOf(r, heap).v.map((x) => cellText(x, heap)));
        const g = ptrInfo.grid[name];
        let cur = null;
        if (g) {
          const r = g[0].find((p) => ints.has(p) && ints.get(p) >= 0 && ints.get(p) < rows.length);
          const c = g[1].find((p) => ints.has(p) && ints.get(p) >= 0 && ints.get(p) < (rows[0] || []).length);
          if (r !== undefined && c !== undefined) cur = [ints.get(r), ints.get(c)];
        }
        item.view.update(rows, cur, animate);
      } else if (kind === "dict") {
        const keyVars = (ptrInfo.keys[name] || []).filter((k) => valuesByName.has(k)).map((k) => keyOf(valuesByName.get(k), o, heap));
        keyVars.push(...looks.filter((l) => l.on === name).map((l) => l.key));
        item.view.update(
          o.kv.map(([k, x]) => [keyOf(k, o, heap), fmt(x, heap)]),
          new Set(keyVars),
          animate,
        );
      } else if (kind === "graph") {
        const g = adjacency(o, heap, name);
        const labels = new Map();
        for (const p of ptrs) labels.set(String(p.idx), [...(labels.get(String(p.idx)) || []), p.name]);
        for (const k of ptrInfo.keys[name] || [])
          if (valuesByName.has(k)) {
            const key = keyOf(valuesByName.get(k), o, heap);
            if (!labels.get(key)?.includes(k)) labels.set(key, [...(labels.get(key) || []), k]);
          }
        item.view.update(g, labels, animate);
      } else if (kind === "rows") {
        item.view.update(
          o.v.map((r) => objOf(r, heap).v.map((x) => fmt(x, heap))),
          new Set(ptrs.map((p) => p.idx)),
          animate,
        );
      } else if (kind === "set")
        item.view.update(
          o.v.map((x) => fmt(x, heap)),
          animate,
          new Set(looks.filter((l) => l.on === name).map((l) => l.key)),
        );
      else if (kind === "nodes") {
        const roots = [...outerNodes, ...(o.t === "list" ? o.v.filter(isRef).map((x) => x.r) : [v.r])]; // outer frames first: the whole tree
        for (const [, x] of vars) {
          const xo = objOf(x, heap);
          if (xo && isNode(xo)) roots.push(x.r);
          if (xo && xo.t === "dict") xo.kv.forEach(([, y]) => isRef(y) && isNode(heap[y.r]) && roots.push(y.r));
        }
        item.view.update(roots, heap, nodeLabels, animate, new Set(outerNodes));
      } else if (kind === "obj") {
        item.wrap.lastChild.replaceChildren(...o.a.map(([k, x]) => h("span.vz-chip", { textContent: `${k} = ${fmt(x, heap)}` })));
      }
      const names = [name, ...item.alias];
      const picture = { heap: "heap", stack: "stack", queue: "queue", intervals: "intervals" }[kind];
      item.label.replaceChildren(
        ...[
          h("b", { textContent: names.join(" = ") }),
          h("span", { textContent: picture ? `${picture} · ${typeText}` : typeText }),
          item.toggle &&
            h("button.vz-toggle", {
              textContent: barsPref.get(item.toggle) ? "cells" : "bars",
              title: "Draw the numbers as bars or as cells",
              onclick: () => {
                barsPref.set(item.toggle, !barsPref.get(item.toggle));
                draw(false);
              },
            }),
        ].filter(Boolean),
      );
    }
    // numbers the code uses with bit operators also get their bits drawn
    for (const [name, v] of vars) {
      if (!(ptrInfo.bits || []).includes(name) || !Number.isInteger(v) || Math.abs(v) >= 2 ** 40) continue;
      const key = `#bits:${name}`;
      seenNames.add(key);
      let item = fe.views.get(key);
      if (!item) {
        const view = new BitsView();
        const label = h("div.vz-sname", {}, h("b", { textContent: name }), h("span", { textContent: "bits" }));
        const wrap = h("div.vz-struct", {}, label, h("div.vz-scroll", {}, view.el));
        item = { kind: "bits", view, wrap, label, alias: new Set() };
        fe.views.set(key, item);
        if (animate) wrap.classList.add("enter");
      }
      if (fe.structs.children[order] !== item.wrap) fe.structs.insertBefore(item.wrap, fe.structs.children[order] || null);
      order++;
      item.view.update(v, animate);
      item.label.lastChild.textContent = `bits · ${v}`;
    }
    for (const [name, item] of fe.views)
      if (!seenNames.has(name)) {
        item.wrap.remove();
        fe.views.delete(name);
      }
    // scalar chips (numbers, strings, None, booleans) and nodes as their label
    const before = new Map(prevFrame ? variables(prevFrame, prevHeap) : []);
    const chipSeen = new Set();
    let ci = 0;
    for (const [name, v] of vars) {
      if (seenNames.has(name)) continue;
      if (isRef(v) && objOf(v, heap) && !isNode(objOf(v, heap)) && kindOf(v, heap) !== "scalar") continue; // shown as an alias of a picture
      chipSeen.add(name);
      let c = fe.chips.get(name);
      if (!c) {
        c = h("span.vz-var", {}, h("b", { textContent: name }), h("span"));
        if (animate) c.classList.add("enter");
        fe.chips.set(name, c);
      }
      if (fe.scalars.children[ci] !== c) fe.scalars.insertBefore(c, fe.scalars.children[ci] || null);
      ci++;
      const text = fmt(v, heap);
      if (c.lastChild.textContent !== text) {
        c.lastChild.textContent = text;
        if (animate && before.has(name) && fmt(before.get(name), prevHeap) !== text) flash(c);
      }
    }
    for (const [name, c] of fe.chips)
      if (!chipSeen.has(name)) {
        c.remove();
        fe.chips.delete(name);
      }
    fe.el.classList.toggle("collapsed", !isTop);
  }

  let runs = 0;
  async function run() {
    stop();
    const my = ++runs;
    const src = editor.value,
      lang = langPick.value;
    // an input that was filled in for other code gets suggested again for this code
    const driver = input.value === suggested && (src !== tracedCode || lang !== tracedLang) ? "" : input.value;
    runBtn.disabled = true;
    note.textContent = "";
    status.className = "vz-status";
    status.textContent = (box && box.warm) || lang === "javascript" ? "Running…" : "Starting Python…";
    try {
      const r = await ask({ mode: "trace", lang, code: src, driver, text: "" });
      if (my !== runs) return; // a newer run started meanwhile
      result = r;
      setLanguage(r.lang || "python");
      tracedCode = src;
      tracedLang = lang;
      status.textContent = "";
      if (!driver.trim() && r.driver) input.value = suggested = r.driver;
      input.rows = Math.min(8, Math.max(2, input.value.split("\n").length));
      const who = r.guessed.includes("operations")
        ? "These calls were"
        : r.guessed.length
          ? `The input for ${r.guessed.join(", ")} was`
          : "This call was";
      note.textContent = r.script
        ? "No input, so the code ran as a script."
        : driver.trim()
          ? ""
          : `${who} picked automatically. Edit it to try your own, then press Run.`;
      setCode(src);
      edit(false);
      frameEls.forEach((fe) => fe.el.remove());
      frameEls.clear();
      barsPref.clear();
      calls.build(callTree(r.steps));
      codeTree.build(r.outline, code);
      if (!r.steps.length) {
        status.className = "vz-status err";
        status.textContent = r.error || "Nothing to show: the input didn't call any of the code's functions.";
        stage.replaceChildren();
        caption.replaceChildren();
        outBox.replaceChildren();
        return;
      }
      i = 0;
      // recursion is best seen as its call tree; anything else starts on the data (unless the code tree is open)
      const recursive = r.steps.some((st) => new Set(st.stack.map((f) => f.fn)).size < st.stack.length);
      if (tab === "outline") draw(false);
      else show(recursive ? "calls" : "data");
    } catch (e) {
      if (my !== runs) return;
      status.className = "vz-status err";
      status.textContent = e.message;
    } finally {
      if (my === runs) runBtn.disabled = false;
    }
  }

  document.addEventListener("keydown", onKey);
  host.style.setProperty("--vz-dur", "320ms");
  const groups = new Map();
  examples.forEach((ex, n) => {
    if (!groups.has(ex.group)) groups.set(ex.group, h("optgroup", { label: ex.group }));
    groups.get(ex.group).append(h("option", { value: String(n), textContent: ex.title }));
  });
  picker.append(h("option", { value: "", textContent: "Your code", hidden: true }), ...groups.values());
  picker.onchange = () => load(examples[+picker.value]);
  editor.addEventListener("input", () => (picker.value = "")); // edited: no longer the example
  show("data");
  return {
    take(src, driver = "", lang = src == null ? "python" : detectLanguage(src)) {
      if (src == null) return load(examples[0]);
      editor.value = clean(src);
      input.value = driver;
      langPick.value = lang;
      suggested = null;
      picker.value = "";
      run();
    },
    now: () => ({ code: editor.value, input: input.value, lang: langPick.value }),
  };
}
