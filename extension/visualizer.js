// Visualizer: runs any Python code on an input (in Pyodide, in a Web Worker: see worker.js and tracer.py), records every step, and replays
// it as animated pictures: lists with their index pointers, grids, dictionaries, sets, linked lists, trees and graphs, the call stack, the
// tree of calls, the code's own statement tree, and the line that just ran. Nothing is generated: every picture is the real state of the
// program at that step, and every caption is computed from the difference between two steps.

import { calls as testCalls, compare, parseCases } from "./leetcode.js";

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
/** A list's index variables, with the other end of each window: a sliding window's `left` only moves (left += 1, left = seen[ch] + 1)
 * and is never used as an index, but it's the window's edge as much as `right` is. Also slow with fast. */
export function windowEnds(names, ints) {
  const out = [...names];
  for (const [a, b] of [...RANGE_PAIRS, ["slow", "fast"]])
    for (const [x, y] of [
      [a, b],
      [b, a],
    ])
      if (out.includes(x) && !out.includes(y) && ints.has(y)) out.push(y);
  return out;
}

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
/** A result as LeetCode prints it (JSON): numbers, strings, booleans, null and lists as they are; a linked list as its values; a binary
 * tree in level order (null for a missing child, none at the end). undefined when it can't be told (a dict, a list cut short, a cycle). */
export function toJSON(v, heap, depth = 0) {
  if (v === null || v === undefined) return null;
  if (typeof v !== "object") return v;
  const o = isRef(v) ? heap[v.r] : null;
  if (!o || depth > 30) return undefined;
  const val = (n) => toJSON(attr(n, "val") ?? attr(n, "value") ?? null, heap, depth + 1);
  if (["list", "tuple", "deque", "set"].includes(o.t)) {
    if (o.n !== undefined && o.n !== o.v.length) return undefined;
    const out = o.v.map((x) => toJSON(x, heap, depth + 1));
    return out.includes(undefined) ? undefined : out;
  }
  if (o.t !== "obj") return undefined;
  if (hasAttr(o, "left") || hasAttr(o, "right")) {
    const out = [],
      q = [v],
      seen = new Set();
    while (q.length) {
      const x = q.shift();
      if (!isRef(x)) {
        out.push(null);
        continue;
      }
      if (seen.has(x.r) || !heap[x.r]) return undefined;
      seen.add(x.r);
      out.push(val(heap[x.r]));
      q.push(attr(heap[x.r], "left") ?? null, attr(heap[x.r], "right") ?? null);
    }
    while (out.length && out[out.length - 1] === null) out.pop();
    return out.includes(undefined) ? undefined : out;
  }
  if (hasAttr(o, "next")) {
    const out = [],
      seen = new Set();
    for (let x = v; isRef(x); x = attr(heap[x.r], "next")) {
      if (seen.has(x.r) || !heap[x.r]) return undefined;
      seen.add(x.r);
      out.push(val(heap[x.r]));
    }
    return out.includes(undefined) ? undefined : out;
  }
  return undefined;
}
const LINKS = ["next", "prev", "random", "left", "right", "neighbors", "children", "parent"];
const isNode = (o) => !!(o && o.t === "obj" && o.a.some(([k]) => LINKS.includes(k)));
const primitive = (v) => !isRef(v);

const GRAPH_NAME = /^(adj|adjacency|graph|g|neighbors|nbrs|children|tree|edges_of|out|succ)$/i;
// A neighbour in an adjacency list: a node (3, 'B'), or a (node, weight) pair. [node, weight or null], or null when it's neither.
function neighbour(y, heap) {
  if (primitive(y)) return [y, null];
  const p = objOf(y, heap);
  return p && (p.t === "tuple" || p.t === "list") && p.v.length === 2 && p.v.every(primitive) ? [p.v[0], fmt(p.v[1], heap)] : null;
}
/** A list of lists (or dict of lists) whose items are all nodes of it, or (node, weight) pairs: an adjacency list, drawn as a graph.
 * { nodes: [key], edges: [[from, to, weight or null]] }, the nodes named as the dict's keys are (keyOf), or null. */
export function adjacency(o, heap, name) {
  if (o.t === "dict") {
    if (!GRAPH_NAME.test(name) || !o.kv.length) return null;
    const keys = o.kv.map(([k]) => keyOf(k, o, heap));
    const edges = [];
    for (const [k, x] of o.kv) {
      const l = objOf(x, heap);
      if (!l || !["list", "set", "tuple"].includes(l.t)) return null;
      for (const y of l.v) {
        const nb = neighbour(y, heap);
        if (!nb) return null;
        edges.push([keyOf(k, o, heap), keyOf(nb[0], o, heap), nb[1]]);
      }
    }
    const all = [...new Set([...keys, ...edges.map((e) => e[1])])];
    return all.length <= 24 ? { nodes: all, edges } : null;
  }
  if (o.t !== "list" || !o.v.length || o.v.length > 24) return null;
  const rows = o.v.map((x) => objOf(x, heap));
  const inside = (y) => Number.isInteger(y) && y >= 0 && y < o.v.length;
  if (!rows.every((r) => r && ["list", "set", "tuple"].includes(r.t))) return null;
  const nbs = rows.map((r) => r.v.map((y) => neighbour(y, heap)));
  if (!nbs.every((r) => r.every((nb) => nb && inside(nb[0])))) return null;
  const weighted = nbs.some((r) => r.some((nb) => nb[1] !== null));
  const rect = rows.every((r) => r.v.length === rows[0].v.length);
  if (rect && !weighted && !GRAPH_NAME.test(name)) return null; // equal rows are a table (edges, a board), not a graph
  const nodes = o.v.map((_, i) => String(i));
  return { nodes, edges: nbs.flatMap((r, i) => r.map(([y, w]) => [String(i), String(y), w])) };
}
/** Places for a graph's nodes, in layers: a graph without cycles flows down from its sources (each node a layer below everything that
 * points at it, as a topological order does); any other graph, or a weighted one (`byDistance`: a shortest-path problem), is laid out by
 * distance from its sources or its first node (a BFS's levels). In a layer, nodes sit under the middle of their neighbours above.
 * Returns { pos: Map(node -> [x, y]), W, H, layer: Map(node -> layer) }. */
export function layered(nodes, edges, byDistance = false, gapX = 58, gapY = 74) {
  const out = new Map(nodes.map((id) => [id, []])),
    both = new Map(nodes.map((id) => [id, new Set()]));
  const indeg = new Map(nodes.map((id) => [id, 0]));
  for (const [a, b] of edges)
    if (out.has(a) && out.has(b) && a !== b) {
      out.get(a).push(b);
      indeg.set(b, indeg.get(b) + 1);
      both.get(a).add(b);
      both.get(b).add(a);
    }
  const pairs = new Set(edges.map(([a, b]) => `${a}>${b}`));
  const undirected = edges.every(([a, b]) => a === b || pairs.has(`${b}>${a}`));
  const layer = new Map();
  if (!undirected && !byDistance) {
    // Kahn's order: each node one layer below the lowest node pointing at it
    const left = new Map(indeg),
      todo = nodes.filter((id) => !left.get(id));
    todo.forEach((id) => layer.set(id, 0));
    while (todo.length) {
      const a = todo.shift();
      for (const b of out.get(a)) {
        layer.set(b, Math.max(layer.get(b) ?? 0, layer.get(a) + 1));
        left.set(b, left.get(b) - 1);
        if (!left.get(b)) todo.push(b);
      }
    }
    if (layer.size < nodes.length) layer.clear(); // a cycle: by distance instead
  }
  if (!layer.size)
    for (const start of [...(undirected ? [] : nodes.filter((id) => !indeg.get(id))), ...nodes]) {
      if (layer.has(start)) continue;
      layer.set(start, 0);
      const q = [start];
      while (q.length) {
        const a = q.shift();
        for (const b of undirected ? both.get(a) : out.get(a))
          if (!layer.has(b)) {
            layer.set(b, layer.get(a) + 1);
            q.push(b);
          }
      }
    }
  const rows = [];
  for (const id of nodes) (rows[layer.get(id)] ||= []).push(id);
  const at = new Map();
  rows.forEach((row) => row.forEach((id, j) => at.set(id, j - row.length / 2)));
  // under the middle of the neighbours above (twice, so the second pass sees the first's order)
  for (let pass = 0; pass < 2; pass++)
    rows.forEach((row, L) => {
      if (!L) return;
      const mid = (id) => {
        const up = [...both.get(id)].filter((x) => layer.get(x) < L).map((x) => at.get(x));
        return up.length ? up.reduce((a, b) => a + b, 0) / up.length : at.get(id);
      };
      row.sort((a, b) => mid(a) - mid(b));
      row.forEach((id, j) => at.set(id, j - row.length / 2));
    });
  const wide = Math.max(1, ...rows.map((r) => r?.length || 0));
  const W = wide * gapX + 24,
    pos = new Map();
  rows.forEach((row, L) => row.forEach((id, j) => pos.set(id, [W / 2 + (j - (row.length - 1) / 2) * gapX, 30 + L * gapY])));
  return { pos, W, H: (rows.length - 1) * gapY + 56, layer };
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

// Whether a list of equal-length lists is a table (a DP table, a board) rather than a collection of items (the permutations found so far):
// a table is indexed as one, `x[r][c]`. The object counts when any call on the stack indexes it under its name there (a board handed to a
// dfs helper), and the name counts when any function indexes it (a dp a nested helper fills in, before that helper is first called).
export function isRefGridInStack(ref, stack, pointers, name = "") {
  if (name && Object.values(pointers || {}).some((p) => p?.grid?.[name])) return true;
  return stack.some((f) => {
    const grid = (pointers || {})[f.fn]?.grid;
    return !!grid && f.loc.some(([n, v]) => isRef(v) && v.r === ref && grid[n]);
  });
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
function evaluate(e, ints, frame = null, heap = null) {
  if (!e) return null;
  if (e[0] === "n") return ints.has(e[1]) ? ints.get(e[1]) : null;
  if (e[0] === "c") return e[1];
  if (e[0] === "neg") {
    const v = evaluate(e[1], ints, frame, heap);
    return v === null ? null : -v;
  }
  if (e[0] === "len") {
    // ["len", varname]: return the length of a list or string
    if (!frame || !heap) return null;
    const varEntry = frame.loc.find(([name]) => name === e[1]);
    if (!varEntry) return null;
    const val = varEntry[1];
    if (typeof val === "string") return val.length;
    if (!isRef(val)) return null;
    const obj = heap[val.r];
    if (!obj || !obj.v) return null;
    return obj.v.length;
  }
  if (e[0] === "sub") {
    // ["sub", varname, index_expr]: look up varname as a list, evaluate index_expr, return the element
    if (!frame || !heap) return null;
    const listName = e[1];
    const idxExpr = e[2];
    // Find the variable in the frame
    const varEntry = frame.loc.find(([name]) => name === listName);
    if (!varEntry) return null;
    const listVal = varEntry[1];
    // Check if it's a reference to a list
    if (!isRef(listVal)) return null;
    const listObj = heap[listVal.r];
    if (!listObj || (listObj.t !== "list" && listObj.t !== "deque")) return null;
    // Evaluate the index expression
    const idx = evaluate(idxExpr, ints, frame, heap);
    if (idx === null || !Number.isInteger(idx)) return null;
    // Handle negative indexes
    const actualIdx = idx < 0 ? listObj.v.length + idx : idx;
    if (actualIdx < 0 || actualIdx >= listObj.v.length) return null;
    // Return the value at that index (must be an integer)
    const elem = listObj.v[actualIdx];
    return typeof elem === "number" && Number.isInteger(elem) ? elem : null;
  }
  const a = evaluate(e[1], ints, frame, heap),
    b = evaluate(e[2], ints, frame, heap);
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
// `queues`: the lists the code takes from the front (when one item goes, that's a popleft / shift, not a pop)
function diff(prevVars, curVars, prevHeap, heap, queues = new Set()) {
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
      msgs.push(...containerDiff(name, a, b, prevHeap, heap, queues.has(name)));
    } else if (fmt(p, prevHeap) !== fmt(v, heap)) {
      msgs.push(primitive(p) && primitive(v) ? `${name}: ${fmt(p, prevHeap)} → ${fmt(v, heap)}` : `${name} = ${fmt(v, heap)}`);
    }
  }
  return msgs;
}
function containerDiff(name, a, b, ha, hb, queue = false) {
  const f = (x, h) => fmt(x, h);
  if ((a.t === "list" || a.t === "deque" || a.t === "tuple") && a.t === b.t) {
    const A = a.v.map((x) => f(x, ha)),
      B = b.v.map((x) => f(x, hb));
    if (B.length === A.length + 1 && A.every((x, i) => x === B[i])) return [`${name}.${SYN.push}(${B[B.length - 1]})`];
    if (B.length === A.length + 1 && A.every((x, i) => x === B[i + 1])) return [`${name}.${SYN.unshift}(${B[0]})`];
    const fromFront = B.length === A.length - 1 && B.every((x, i) => x === A[i + 1]);
    if (queue && fromFront) return [`${name}.${SYN.shift}() → ${A[0]}`];
    if (B.length === A.length - 1 && B.every((x, i) => x === A[i])) return [`${name}.pop() → ${A[A.length - 1]}`];
    if (fromFront) return [`${name}.${SYN.shift}() → ${A[0]}`];
    if (A.length === B.length) {
      const ch = A.map((x, i) => (x !== B[i] ? i : -1)).filter((i) => i >= 0);
      if (ch.length === 2 && A[ch[0]] === B[ch[1]] && A[ch[1]] === B[ch[0]]) return [`swap ${name}[${ch[0]}] ↔ ${name}[${ch[1]}]`];
      // an item that is itself a list changed in place (a row of a DP table): say which of its items, dp[4][1]: 0 → 1
      const inner = (i) => {
        const x = a.v[i],
          y = b.v[i];
        return isRef(x) && isRef(y) && x.r === y.r && ha[x.r] && hb[y.r] ? containerDiff(`${name}[${i}]`, ha[x.r], hb[y.r], ha, hb) : [];
      };
      if (ch.length && ch.length <= 3)
        return ch.flatMap((i) => {
          const sub = inner(i);
          return sub.length ? sub : [`${name}[${i}]: ${A[i]} → ${B[i]}`];
        });
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

/** A tested condition (the tracer's `conds[k]` and a step's `cond`) with the values its operands had put in: "a[j] > a[j + 1]" ->
 * "5 > 1". An operand stays as written when its value is long, or when it wasn't worked out (an and / or stopped before it). null when
 * no value would show. */
export function condValues(c, cond, heap) {
  const got = new Map(cond.o);
  let out = "",
    last = 0,
    shown = false;
  [...c.ops.entries()]
    .sort((x, y) => x[1].a - y[1].a)
    .forEach(([k, op]) => {
      if (!got.has(k) || op.a < last) return;
      const v = fmt(got.get(k), heap);
      if (v.length > 14 || v === c.t.slice(op.a, op.b)) return;
      out += c.t.slice(last, op.a) + v;
      last = op.b;
      shown = true;
    });
  return shown ? (out + c.t.slice(last)).replace(/\s+/g, " ") : null;
}
// what the program does after a test came out true / false
function outcome(kind, yes) {
  if (kind === "while" || kind === "for") return yes ? "so the loop body runs" : "so the loop ends";
  const name = kind === "elif" ? (SYN.js ? "else if" : "elif") : "if";
  return yes ? `so the ${name} block runs` : `so it skips the ${name} block`;
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
  // bars: draw numbers as bar heights (sorting); `nums` are the numeric values, or null when the list isn't all numbers. `marks`: the cells
  // the code is comparing (cmp), the two it just swapped (swp), the ones already where they'll be once sorted (done), the ones the line
  // that ran read (rd) and wrote (wr), the ones written at some point so far (fill), and the ones whose index is in another list (held:
  // a monotonic stack of indexes).
  update(items, ptrs, animate, nums = null, bars = false, meta = [], marks = {}) {
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
    // map cell index to variable names pointing at it (for hover linking)
    const cellVars = new Map();
    for (const p of ptrs) if (!p.probe && !p.meta) cellVars.set(p.idx, [...(cellVars.get(p.idx) || []), p.name]);
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
      for (const m of MARKS) c.classList.toggle(m, !!marks[m]?.has(i));
      // add data-var for hover linking if a variable points at this cell
      if (cellVars.has(i)) c.dataset.var = cellVars.get(i).join(" ");
      else delete c.dataset.var;
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
      // add data-var for hover linking (skip probes and meta pointers)
      if (!p.probe && !p.meta) e.dataset.var = p.name;
      else delete e.dataset.var;
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
// what the marks on a list's or a grid's cells mean (shown next to its name; seen, front and held are named after the variable)
const LEGEND = {
  cmp: "compared",
  swp: "swapped",
  done: "in place",
  rd: "read",
  wr: "written",
  fill: "filled",
  path: "on the stack",
  slice: "passed to callee",
};
const MARKS = ["cmp", "swp", "done", "rd", "wr", "fill", "held", "path", "seen", "front", "slice"];
function swapOf(a, b) {
  if (a.length !== b.length) return null;
  const ch = a.map((x, i) => (x !== b[i] ? i : -1)).filter((i) => i >= 0);
  return ch.length === 2 && a[ch[0]] === b[ch[1]] && a[ch[1]] === b[ch[0]] ? ch : null;
}
/** Detects if `callee` is a contiguous slice of `caller` (same values in order). Returns [start, end) indices in caller, or null. */
export function sliceOf(caller, callee) {
  if (!callee.length || callee.length > caller.length) return null;
  for (let i = 0; i <= caller.length - callee.length; i++) {
    if (caller.slice(i, i + callee.length).every((x, j) => x === callee[j])) return [i, i + callee.length];
  }
  return null;
}
/** Splits a call's arguments at top-level commas, respecting brackets, parens, and strings. Returns array of arg strings. */
export function splitArgs(callText) {
  const args = [];
  let depth = 0,
    inStr = null,
    start = 0;
  for (let i = 0; i < callText.length; i++) {
    const c = callText[i],
      prev = callText[i - 1];
    if (inStr) {
      if (c === inStr && prev !== "\\") inStr = null;
    } else if (c === '"' || c === "'" || c === "`") {
      inStr = c;
    } else if (c === "(" || c === "[" || c === "{") {
      depth++;
    } else if (c === ")" || c === "]" || c === "}") {
      depth--;
    } else if (c === "," && depth === 0) {
      args.push(callText.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (start < callText.length) args.push(callText.slice(start).trim());
  return args;
}
/** The text between the parentheses of the first call to `fn` on a line (`merge_sort(a[:len(a) // 2])` -> `a[:len(a) // 2]`), brackets and
 * strings inside it included; null when the line makes no such call. */
export function callArgs(line, fn) {
  const re = new RegExp(`(?<!\\w)${fn.replace(/[$]/g, "\\$")}\\s*\\(`, "g");
  for (const m of line.matchAll(re)) {
    let depth = 1,
      quote = null;
    const start = m.index + m[0].length;
    for (let i = start; i < line.length; i++) {
      const c = line[i];
      if (quote) {
        if (c === quote && line[i - 1] !== "\\") quote = null;
      } else if (c === '"' || c === "'" || c === "`") quote = c;
      else if ("([{".includes(c)) depth++;
      else if (")]}".includes(c) && --depth === 0) return line.slice(start, i);
    }
  }
  return null;
}
/** Parses a slice expression. Returns {name, lo, hi} or null. Python: name[lo:hi], JS: name.slice(lo, hi). */
export function parseSlice(arg, isJs) {
  if (isJs) {
    const m = arg.match(/^(\w+)\.slice\((.*)\)$/);
    if (!m) return null;
    const [lo, hi] = splitArgs(m[2]);
    return { name: m[1], lo: lo || "0", hi: hi || null };
  } else {
    const m = arg.match(/^(\w+)\[(.*?):(.*?)\]$/);
    if (!m) return null;
    return { name: m[1], lo: m[2] || "0", hi: m[3] || null };
  }
}
/** Evaluates a slice bound expression (lo or hi) given the caller's integer variables and list length. Returns number or null. */
export function evalBound(expr, ints, len, name = "") {
  if (expr === null || expr === undefined) return len;
  expr = expr.trim();
  if (expr === "") return 0;
  if (/^\d+$/.test(expr)) return +expr;
  if (/^-\d+$/.test(expr)) return len + +expr;
  if (ints.has(expr)) return ints.get(expr);
  const lenPat = /^len\((\w+)\)$|^(\w+)\.length$/;
  const m = expr.match(lenPat);
  if (m && (m[1] || m[2]) === name) return len; // (the length of the list being sliced: a[0:len(a)])
  const add = expr.match(/^(\w+)\s*\+\s*(\d+)$/);
  if (add && ints.has(add[1])) return ints.get(add[1]) + +add[2];
  const sub = expr.match(/^(\w+)\s*-\s*(\d+)$/);
  if (sub && ints.has(sub[1])) return ints.get(sub[1]) - +sub[2];
  return null;
}

// A table: lists of equal-length lists (DP tables, boards, matrices). The current cell and its row/column are marked, and `marks` (sets
// of "r,c", see ArrayView). `axes`: what each row / column stands for ({ rows, cols }: a DP table over two strings has a letter per row).
class GridView {
  constructor() {
    this.el = el("div", "vz-grid");
    this.prev = [];
  }
  update(rows, cur, animate, marks = {}, axes = null, curVars = null) {
    const h = rows.length,
      w = rows[0] ? rows[0].length : 0;
    const axesKey = JSON.stringify(axes);
    if (this.h !== h || this.w !== w || this.axesKey !== axesKey) {
      this.el.replaceChildren();
      this.el.style.gridTemplateColumns = `minmax(18px, auto) repeat(${w}, minmax(26px, auto))`;
      // a header: the index, and what the row / column stands for
      const head = (k, label) => {
        const e = el("span", "vz-gh");
        e.append(el("i", "", String(k)));
        if (label) e.append(el("b", "", label));
        return e;
      };
      this.el.append(el("span", "vz-gh"));
      for (let c = 0; c < w; c++) this.el.append(head(c, axes?.cols?.[c]));
      this.cells = [];
      for (let r = 0; r < h; r++) {
        this.el.append(head(r, axes?.rows?.[r]));
        this.cells.push([]);
        for (let c = 0; c < w; c++) {
          const e = el("span", "vz-gc");
          this.el.append(e);
          this.cells[r].push(e);
        }
      }
      this.el.classList.toggle("axes", !!axes);
      this.h = h;
      this.w = w;
      this.axesKey = axesKey;
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
        for (const m of MARKS) e.classList.toggle(m, !!marks[m]?.has(`${r},${c}`));
        // add data-var for hover linking if this is the current cell
        if (curVars && cur && cur[0] === r && cur[1] === c) e.dataset.var = curVars.join(" ");
        else delete e.dataset.var;
      }),
    );
    this.prev = rows;
  }
}

// A key the line about to run looks for and won't find (`x in seen` that comes out false): a dashed row / chip at the end, so the miss is
// seen as plainly as a hit. (The views take the old ones out first, so they never count as one of their items.)
function showMissing(box, keys, make) {
  for (const k of keys) box.append(make(k));
}
// Key -> value rows; new keys slide in, changed values flash, the key being looked at is marked.
class DictView {
  constructor() {
    this.el = el("div", "vz-dict");
    this.rows = new Map();
    this.prev = new Map(); // previous key-value pairs
  }
  update(pairs, hot, animate, missing = [], hotVars = []) {
    this.el.querySelectorAll(":scope > .miss").forEach((e) => e.remove());
    const seen = new Set();
    // map hot keys to their variable names
    const keyToVars = new Map();
    hotVars.forEach(({ key, varName }) => keyToVars.set(key, [...(keyToVars.get(key) || []), varName]));
    const current = new Map(pairs);
    pairs.forEach(([k, v], i) => {
      let row = this.rows.get(k);
      const isNew = !row;
      const changed = !isNew && this.prev.has(k) && this.prev.get(k) !== v;
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
      // Persistent mark for new keys or changed values
      row.classList.toggle("wr", this.prev.size > 0 && (isNew || changed));
      row.classList.toggle("hot", hot.has(k));
      // add data-var to hot rows for hover linking
      if (keyToVars.has(k)) row.dataset.var = keyToVars.get(k).join(" ");
      else delete row.dataset.var;
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
    showMissing(this.el, missing, (k) => {
      const row = el("div", "vz-kv miss");
      row.append(el("span", "vz-k", k), el("span", "vz-val", "not there"));
      return row;
    });
    this.prev = current;
  }
}

// Set members as chips.
class SetView {
  constructor() {
    this.el = el("div", "vz-set");
    this.items = new Map();
    this.prev = new Set(); // previous members
  }
  update(items, animate, hot = new Set(), missing = []) {
    this.el.querySelectorAll(":scope > .miss").forEach((e) => e.remove());
    const seen = new Set();
    const current = new Set(items);
    items.forEach((t, i) => {
      let c = this.items.get(t);
      const isNew = !c;
      if (!c) {
        c = el("span", "vz-chip", t);
        if (animate) c.classList.add("enter");
        this.items.set(t, c);
      }
      // Persistent mark for newly added members
      c.classList.toggle("wr", this.prev.size > 0 && isNew);
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
    showMissing(this.el, missing, (k) => el("span", "vz-chip miss", `${k}?`));
    this.prev = current;
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
    this.prev = []; // previous items
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
    this.tree.style.width = n ? `${W}px` : "0";
    this.tree.style.height = n ? `${levels * 52 + 6}px` : "0";
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
    // Find items that moved or were added (simple heuristic: items not in prev or at different positions)
    const changed = new Set();
    if (this.prev.length > 0) {
      items.forEach((text, i) => {
        if (i >= this.prev.length || this.prev[i] !== text) {
          // Item at position i either didn't exist before or has a different value
          const prevIdx = this.prev.indexOf(text);
          if (prevIdx < 0 || prevIdx !== i) changed.add(i);
        }
      });
    }
    items.forEach((text, i) => {
      const e = this.nodes[i];
      e.style.transform = `translate(${pos[i][0] - R - 1}px, ${pos[i][1] - R - 1}px)`;
      if (e.firstChild.textContent !== text) {
        if (e.firstChild.textContent && animate) flash(e);
        e.firstChild.textContent = text;
      }
      e.title = text;
      // Mark items that were added or moved
      e.classList.toggle("wr", changed.has(i));
      e.classList.toggle("hot", hot.has(i) || i === 0);
    });
    this.arr.update(items, ptrs, animate);
    this.prev = items.slice();
  }
}

// A stack (a list used with append and pop()): a column with the top at the top; pushes slide in, pops slide out.
class StackView {
  constructor() {
    this.el = el("div", "vz-stack");
    this.items = [];
    this.prev = []; // previous items
  }
  update(items, animate) {
    const prevLen = this.prev.length;
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
      // Persistent mark for newly pushed items
      const isNew = prevLen > 0 && i >= prevLen;
      e.classList.toggle("wr", isNew);
      e.classList.toggle("top", i === items.length - 1);
    });
    this.el.classList.toggle("empty", !items.length);
    this.prev = items.slice();
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

// A graph from an adjacency list, in layers (see layered()): directed arrows (plain lines when both directions exist), weights on the
// edges. Marked: the nodes variables are at (their names above), the nodes in a visited set (seen) and in a queue / stack / heap (front),
// a number kept per node (dist, indegree) under it, and the edge the code is looking at (from a node to the neighbour its loop is on).
class GraphView {
  constructor() {
    this.el = el("div", "vz-nodes vz-graph");
    this.svg = svgEl("svg");
    this.svg.classList.add("vz-links");
    this.svg.innerHTML =
      '<defs><marker id="vz-garrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z"/></marker></defs>';
    this.el.append(this.svg);
    this.nodeEls = new Map();
  }
  update({ nodes, edges }, labels, animate, { seen = new Set(), front = new Set(), notes = new Map(), edge = null } = {}) {
    const R = 16;
    const { pos, W, H, layer } = layered(
      nodes,
      edges,
      edges.some((e) => e[2] !== null && e[2] !== undefined),
    );
    this.el.style.width = `${W}px`;
    this.el.style.height = `${H}px`;
    this.svg.setAttribute("width", String(W));
    this.svg.setAttribute("height", String(H));
    const set = new Set(edges.map(([a, b]) => `${a}>${b}`));
    const drawn = new Set();
    const items = [];
    for (const [a, b, w] of edges) {
      if (!pos.has(a) || !pos.has(b) || a === b || drawn.has(`${a}>${b}`)) continue;
      const both = set.has(`${b}>${a}`);
      drawn.add(`${a}>${b}`);
      if (both) drawn.add(`${b}>${a}`);
      const [x1, y1] = pos.get(a),
        [x2, y2] = pos.get(b);
      const dx = x2 - x1,
        dy = y2 - y1,
        d = Math.hypot(dx, dy) || 1;
      const sx = x1 + (dx / d) * R,
        sy = y1 + (dy / d) * R,
        ex = x2 - (dx / d) * (R + 2),
        ey = y2 - (dy / d) * (R + 2);
      // an edge inside a layer, or across more than one, bends (so it doesn't run through the nodes between): up, or out to the side
      const span = Math.abs(layer.get(a) - layer.get(b));
      const side = x2 >= x1 ? 1 : -1;
      const bend = span === 1 ? 0 : span === 0 ? -Math.min(46, 14 + Math.abs(dx) / 4) : side * (10 + 16 * span);
      const mx = (sx + ex) / 2 + (span > 1 ? bend : 0),
        my = (sy + ey) / 2 + (span === 0 ? bend : 0);
      const p = svgEl("path");
      p.setAttribute("class", "vz-link");
      p.setAttribute("d", bend ? `M${sx},${sy} Q${mx},${my} ${ex},${ey}` : `M${sx},${sy} L${ex},${ey}`);
      if (!both) p.setAttribute("marker-end", "url(#vz-garrow)");
      const on = !!edge && ((edge[0] === a && edge[1] === b) || (both && edge[0] === b && edge[1] === a));
      p.classList.toggle("cur", on);
      items.push(p);
      if (w !== null && w !== undefined) {
        // the weight beside the edge's middle (on a bent edge, the curve's middle), off the line
        const t = svgEl("text");
        t.setAttribute("class", `vz-ew${on ? " cur" : ""}`);
        const cx = bend ? (sx + ex) / 4 + mx / 2 : (sx + ex) / 2,
          cy = bend ? (sy + ey) / 4 + my / 2 : (sy + ey) / 2;
        t.setAttribute("x", String(cx + (-dy / d) * 9));
        t.setAttribute("y", String(cy + (dx / d) * 9 + 3.5));
        t.textContent = w;
        items.push(t);
      }
    }
    this.svg.querySelectorAll(".vz-link, .vz-ew").forEach((p) => p.remove());
    this.svg.append(...items);
    const keep = new Set();
    for (const id of nodes) {
      let e = this.nodeEls.get(id);
      if (!e) {
        e = el("div", "vz-node");
        e.append(el("span", "vz-nv", id.replace(/^'(.*)'$/, "$1")), el("div", "vz-nl"), el("div", "vz-gn"));
        e.title = id;
        if (animate) e.classList.add("enter");
        this.el.append(e);
        this.nodeEls.set(id, e);
      }
      const [x, y] = pos.get(id);
      e.style.transform = `translate(${x - R - 2}px, ${y - R - 2}px)`;
      const names = labels.get(id) || [];
      e.children[1].textContent = names.join(", ");
      // add data-var to label and node for hover linking
      if (names.length) {
        e.children[1].dataset.var = names.join(" ");
        e.dataset.var = names.join(" ");
      } else {
        delete e.children[1].dataset.var;
        delete e.dataset.var;
      }
      const note = notes.get(id) ?? "";
      if (e.children[2].textContent !== note) {
        if (animate && e.children[2].textContent) flash(e.children[2]);
        e.children[2].textContent = note;
      }
      e.classList.toggle("hot", names.length > 0);
      e.classList.toggle("seen", seen.has(id));
      e.classList.toggle("front", front.has(id));
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
      // add data-var to label and node for hover linking
      if (names.length) {
        n.lastChild.dataset.var = names.join(" ");
        n.dataset.var = names.join(" ");
      } else {
        delete n.lastChild.dataset.var;
        delete n.dataset.var;
      }
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
// An exact key for an argument (fmt shortens long lists), or null when it can't be told exactly (a list cut short by the tracer). Objects
// that aren't containers (nodes, a class's instance) are the same argument only when they are the same object.
function argKey(v, heap, depth = 0) {
  if (!isRef(v)) return JSON.stringify(v);
  const o = heap[v.r];
  if (!o || depth > 8) return null;
  if (!["list", "tuple", "deque", "set", "dict"].includes(o.t)) return `#${v.r}`;
  const parts = o.t === "dict" ? o.kv.flat() : o.v;
  if (o.n !== (o.t === "dict" ? o.kv.length : o.v.length)) return null;
  const keys = parts.map((x) => argKey(x, heap, depth + 1));
  return keys.includes(null) ? null : `${o.t}[${keys.join(",")}]`;
}
/** Every call the run made, as a tree built from the trace: { id, fn, label, full, value, call, ret, last, children }. call / ret / last
 * are step numbers (ret is -1 when the call raised instead of returning). The root (id 0) stands for the input, which made the first calls.
 * A recursive function's call with the same arguments as an earlier call, that made calls again (work a memo would skip, not a base case),
 * is a repeat: the calls with those arguments have `rep` (1 for the first, 2 for the second...) and `twins` (all of them, in order). The
 * root has `calls` (all of them), `repeats` (how many calls are repeats) and `saved` (the calls a memo would skip: those under a repeat). */
export function callTree(steps) {
  const root = {
    id: 0,
    label: "run",
    full: "run",
    value: null,
    call: 0,
    ret: -1,
    last: Infinity,
    children: [],
    calls: 0,
    repeats: 0,
    saved: 0,
  };
  const nodes = new Map();
  const same = new Map(); // arguments key -> the calls made with them
  const recursive = new Set(); // functions that called themselves (directly or not)
  steps.forEach((s, i) => {
    s.stack.forEach((f, d) => {
      let n = nodes.get(f.id);
      if (!n) {
        // the arguments are the frame's parameters at its call (its other locals include a closure's outer variables)
        const loc = new Map(f.loc);
        const params = (s.ev === "call" && d === s.stack.length - 1 ? s.params || [] : []).filter((k) => loc.has(k));
        const args = params.filter((k) => k !== "self").map((k) => fmt(loc.get(k), s.heap));
        const name = fnName(f.fn);
        const call = f.fn === "<module>" ? name : `${name}(${args.join(", ")})`;
        const label = f.fn === "<module>" ? name : `${name}(${args.map((a) => clip(a, 16)).join(", ")})`;
        n = { id: f.id, fn: f.fn, label: clip(label, 30), full: call, value: null, call: i, ret: -1, last: i, children: [] };
        (d ? nodes.get(s.stack[d - 1].id) : root).children.push(n);
        nodes.set(f.id, n);
        if (f.fn !== "<module>") root.calls++;
        if (s.stack.slice(0, d).some((g) => g.fn === f.fn)) recursive.add(f.fn);
        const keys = params.map((k) => argKey(loc.get(k), s.heap));
        if (args.length && !keys.includes(null)) {
          const key = `${f.fn}(${keys.join("|")})`;
          same.set(key, [...(same.get(key) || []), n]);
        }
      }
      n.last = i;
    });
    if (s.ev === "return") {
      const n = nodes.get(s.stack[s.stack.length - 1].id);
      n.ret = i;
      n.value = fmt(s.ret, s.heap);
    }
  });
  const skipped = new Set();
  const under = (n) =>
    n.children.forEach((c) => {
      skipped.add(c);
      under(c);
    });
  for (const twins of same.values())
    if (recursive.has(twins[0].fn) && twins.slice(1).some((n) => n.children.length)) {
      twins.forEach((n, k) => Object.assign(n, { rep: k + 1, twins }));
      root.repeats += twins.length - 1;
      twins.slice(1).forEach(under);
    }
  root.saved = skipped.size;
  return root;
}

// ---------------------------------------------------------------- moving through the run (step over, out, to the next loop pass)
const depthAt = (steps, k) => steps[k].stack.length;
const frameAt = (steps, k) => steps[k].stack[steps[k].stack.length - 1]?.id;
/** Step over: the next step at step i's depth or above (the calls its line makes are skipped). */
export function stepOver(steps, i) {
  for (let k = i + 1; k < steps.length; k++) if (depthAt(steps, k) <= depthAt(steps, i)) return k;
  return steps.length - 1;
}
/** Back over: the step before i at its depth or above (back past the calls the line before made). */
export function backOver(steps, i) {
  for (let k = i - 1; k >= 0; k--) if (depthAt(steps, k) <= depthAt(steps, i)) return k;
  return 0;
}
/** Step out: the return of the call step i is in (or, when it raised, the first step back in its caller). */
export function stepOut(steps, i) {
  const d = depthAt(steps, i),
    id = frameAt(steps, i);
  for (let k = i + 1; k < steps.length; k++) {
    if (steps[k].ev === "return" && frameAt(steps, k) === id) return k;
    if (depthAt(steps, k) < d) return k;
  }
  return steps.length - 1;
}
const LOOPS = new Set(["for", "while", "do", "asyncfor"]);
/** The innermost loop (an outline item) around a line, or null. */
function loopAround(outline, line) {
  let found = null;
  const visit = (items) => {
    for (const it of items) {
      if (line < it.l || line > it.e) continue;
      if (LOOPS.has(it.t)) found = it;
      visit(it.c);
    }
  };
  visit(outline || []);
  return found;
}
// the line a loop tests on, once per pass (a do-while tests at its end)
const headerOf = (loop) => (loop.t === "do" ? loop.e : loop.l);
/** The next pass of the innermost loop around step i's line: the next time the same call is back on the loop's line (the last time is
 * when the loop ends). Past the loop when there's none. */
export function nextPass(steps, i, outline) {
  const loop = loopAround(outline, steps[i].line);
  const d = depthAt(steps, i),
    id = frameAt(steps, i);
  if (!loop) return stepOver(steps, i);
  for (let k = i + 1; k < steps.length; k++) {
    const own = frameAt(steps, k) === id;
    if (own && steps[k].ev === "line" && steps[k].line === headerOf(loop)) return k;
    if (depthAt(steps, k) < d || (own && (steps[k].line < loop.l || steps[k].line > loop.e))) return k;
  }
  return steps.length - 1;
}
/** Which pass of the innermost loop around step i's line the same call is on (1 for the first), or 0 when the line isn't in a loop. */
export function loopPass(steps, i, outline) {
  const loop = loopAround(outline, steps[i].line);
  if (!loop || steps[i].ev !== "line") return 0;
  const id = frameAt(steps, i);
  let pass = 0;
  for (let k = i; k >= 0; k--) {
    if (frameAt(steps, k) !== id) {
      if (depthAt(steps, k) < depthAt(steps, i)) break; // (before the call started)
      continue;
    }
    if (steps[k].ev === "call" || steps[k].line < loop.l || steps[k].line > loop.e) break;
    if (steps[k].ev === "line" && steps[k].line === headerOf(loop)) pass++;
  }
  return pass;
}

/** The items of a list of numbers that are where they'll be once it's sorted: a sorted run at the start, each no bigger than anything after
 * it, and a sorted run at the end, each no smaller than anything before it (what bubble, selection and other sorts build up). */
export function settled(nums) {
  const n = nums.length,
    out = new Set();
  if (n < 2) return out;
  const minAfter = [],
    maxBefore = [];
  for (let k = n - 1, m = Infinity; k >= 0; k--) minAfter[k] = m = Math.min(m, nums[k]);
  for (let k = 0, m = -Infinity; k < n; k++) maxBefore[k] = m = Math.max(m, nums[k]);
  for (let k = 0; k < n && (k === 0 || nums[k - 1] <= nums[k]) && nums[k] <= (minAfter[k + 1] ?? Infinity); k++) out.add(k);
  for (let k = n - 1; k >= 0 && (k === n - 1 || nums[k] <= nums[k + 1]) && nums[k] >= (maxBefore[k - 1] ?? -Infinity); k--) out.add(k);
  return out;
}

// ---------------------------------------------------------------- what one structure says about another
/** The legend for a picture's marks: [[mark, what it means]], for the marks that mark something; `named` names some (in seen). */
function legendOf(marks, named = {}) {
  return MARKS.filter((m) => marks[m]?.size).map((m) => [m, named?.[m] || LEGEND[m] || m]);
}
// the lists the code uses as a queue, a stack or a heap (what's waiting to be visited)
const frontierNames = (info) => new Set([...(info.queues || []), ...(info.stacks || []), ...(info.heaps || [])]);
/** The items of `name` whose index another list keeps (the tracer's `holds`: temps[stack[-1]]): [that list's name, Set(index)], or null.
 * Its items are indexes, or (index, value) pairs. */
function heldBy(info, name, byName, heap, n) {
  for (const y of info.holds?.[name] || []) {
    const yo = objOf(byName.get(y), heap);
    if (!yo || !["list", "deque"].includes(yo.t)) continue;
    const ix = yo.v.map((x) => (Number.isInteger(x) ? x : objOf(x, heap)?.v?.[0]));
    if (!ix.every(Number.isInteger)) continue;
    return [y, new Set(ix.map((x) => norm(x, n)).filter((x) => x >= 0 && x < n))];
  }
  return null;
}
/** The cells ("r,c") a set / queue holds, when its items are (r, c) pairs (or longer: (r, c, steps)) inside an h × w grid; else null. */
function cellsIn(o, heap, h, w) {
  const out = new Set();
  for (const x of o.v) {
    const t = objOf(x, heap);
    if (!t || !["tuple", "list"].includes(t.t) || t.v.length < 2) return null;
    const [r, c] = t.v;
    if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || c < 0 || r >= h || c >= w) return null;
    out.add(`${r},${c}`);
  }
  return o.v.length ? out : null;
}
const namesIn = (e) => {
  if (!e) return [];
  if (e[0] === "n") return [e[1]];
  if (e[0] === "c") return [];
  if (e[0] === "len") return [e[1]]; // len(name)
  if (e[0] === "sub") return [e[1], ...namesIn(e[2])]; // sub(name, idx_expr)
  return [...namesIn(e[1]), ...namesIn(e[2])]; // binary ops
};
/** What a DP table's rows and columns stand for: a string the code reads at an index worked out from the row (column) variable alone
 * (a[i - 1] for row i). { rows, cols } (a letter, or "" for a row that stands for none, like the empty prefix), or null. */
export function gridAxes(info, g, byName, h, w) {
  if (!g) return null;
  const axis = (vars, n) => {
    for (const a of info.acc || []) {
      const str = byName.get(a.on),
        used = a.ix ? namesIn(a.ix) : [];
      if (typeof str !== "string" || used.length !== 1 || !vars.includes(used[0])) continue;
      const labels = Array.from({ length: n }, (_, k) => {
        const x = evaluate(a.ix, new Map([[used[0], k]]));
        return x !== null && x >= 0 && x < str.length ? str[x] : "";
      });
      if (labels.some(Boolean)) return labels;
    }
    return null;
  };
  const rows = axis(g[0], h),
    cols = axis(g[1], w);
  return rows || cols ? { rows, cols } : null;
}
// a number kept per node, shown under it
const NOTE_NAME = /^(dist\w*|distance\w*|cost\w*|in_?deg\w*|degree\w*|depth\w*|levels?|colou?rs?|parents?|prev|rank|low|disc|tin|tout)$/i;
/** What the other variables of a frame say about a graph's nodes (see GraphView): { seen, front: Set(node), notes: Map(node -> text),
 * edge: [from, to] or null, legend }. Adds the neighbour a loop is on (`for nxt in graph[node]`) to `labels`. */
export function graphState(g, o, name, vars, heap, info, byName, labels = new Map()) {
  const ids = new Set(g.nodes);
  const nodeOf = (x) => (primitive(x) && ids.has(keyOf(x, o, heap)) ? keyOf(x, o, heap) : null);
  const seen = new Set(),
    front = new Set(),
    notes = new Map(),
    named = {};
  let edge = null;
  for (const [x, [on, k]] of Object.entries(info.iters || {})) {
    if (on !== name || !byName.has(x) || !byName.has(k)) continue;
    const a = nodeOf(byName.get(k)),
      b = nodeOf(byName.get(x));
    if (a === null || b === null || !g.edges.some(([p, q]) => p === a && q === b)) continue; // (a loop that's over keeps its last value)
    edge = [a, b];
    if (!labels.get(b)?.includes(x)) labels.set(b, [...(labels.get(b) || []), x]);
  }
  const waiting = frontierNames(info);
  const byIndex = g.nodes.every((id) => /^\d+$/.test(id)); // nodes 0..n-1: a list of n can hold one thing per node
  for (const [n2, v2] of vars) {
    const o2 = objOf(v2, heap);
    if (!o2 || n2 === name) continue;
    if (o2.t === "set" && !named.seen && o2.v.length && o2.v.every((x) => nodeOf(x) !== null)) {
      o2.v.forEach((x) => seen.add(nodeOf(x)));
      named.seen = `in ${n2}`;
    } else if (o2.t === "list" && !named.seen && byIndex && o2.v.length >= g.nodes.length && o2.v.every((x) => typeof x === "boolean")) {
      o2.v.forEach((x, k) => x && ids.has(String(k)) && seen.add(String(k)));
      named.seen = n2; // visited = [False] * n
    } else if ((waiting.has(n2) || o2.t === "deque") && !named.front && o2.v) {
      const items = frontItems(o2, heap, nodeOf, (info.heaps || []).includes(n2));
      if (!items) continue;
      items.forEach((k) => front.add(k));
      named.front = `in ${n2}`;
    } else if (!notes.size && NOTE_NAME.test(n2.replace(/^self\./, ""))) {
      if (o2.t === "dict" && o2.kv.length && o2.kv.every(([k, x]) => nodeOf(k) !== null && primitive(x)))
        o2.kv.forEach(([k, x]) => notes.set(nodeOf(k), clip(fmt(x, heap), 6)));
      else if (o2.t === "list" && byIndex && o2.v.length >= g.nodes.length && o2.v.every(primitive))
        o2.v.forEach((x, k) => ids.has(String(k)) && notes.set(String(k), clip(fmt(x, heap), 6)));
      if (notes.size) named.note = `under each node: ${n2}`;
    }
  }
  const legend = [
    ...(named.seen ? [["seen", named.seen]] : []),
    ...(named.front ? [["front", named.front]] : []),
    ...(named.note ? [["note", named.note]] : []),
  ];
  return { seen, front, notes, edge, legend };
}
// The nodes in a queue / stack / heap: its items, or in items that are tuples ((dist, node) in a heap, (node, depth) in a queue) the
// place where every item has a node (the last such place in a heap, where the priority comes first). null when it holds no nodes.
function frontItems(o, heap, nodeOf, isHeap) {
  if (o.v.every((x) => nodeOf(x) !== null)) return o.v.map(nodeOf);
  const ts = o.v.map((x) => objOf(x, heap));
  if (!ts.every((t) => t && (t.t === "tuple" || t.t === "list") && t.v.length)) return null;
  const width = Math.min(...ts.map((t) => t.v.length));
  const cols = [];
  for (let c = 0; c < width; c++) if (ts.every((t) => nodeOf(t.v[c]) !== null)) cols.push(c);
  if (!cols.length) return null;
  const c = isHeap ? cols[cols.length - 1] : cols[0];
  return ts.map((t) => nodeOf(t.v[c]));
}

// ---------------------------------------------------------------- what each line read and wrote (DP's sources, the cell it fills)
const norm = (x, n) => (x < 0 ? x + n : x); // nums[-1]
/** For each step, what the line that ran just before it (in the same call) read and wrote, from the tracer's `acc` table worked out
 * with the values the variables had when the line started: out[i] = { test, list: [{ on, ref, at, text, val, w }] } or null. `at` is
 * the index (3), the cell ("2,3") or the key; `ref` the container's heap id (`s:name` for a string); `val` the item's value then (null
 * when a write makes a new key); `test`: the line was an if / while test (what it compared is shown as such). A line has run once its
 * call is back (the next line, or the return), so a line that makes calls is done when they all are. */
export function lineEffects(steps, pointers) {
  const out = steps.map(() => null);
  const pending = new Map(); // call id -> the step that was about to run a line in it
  steps.forEach((s, i) => {
    const top = s.stack[s.stack.length - 1];
    if (!top) return;
    const k = pending.get(top.id);
    if (k !== undefined) {
      pending.delete(top.id);
      out[i] = accessesAt(steps[k], pointers);
    }
    if (s.ev === "line") pending.set(top.id, i);
  });
  return out;
}
function accessesAt(s, pointers) {
  const top = s.stack[s.stack.length - 1];
  const acc = (pointers?.[top.fn]?.acc || []).filter((a) => a.line === s.line);
  if (!acc.length) return null;
  const vars = variables(top, s.heap);
  const ints = new Map(vars.filter(([, v]) => Number.isInteger(v)));
  const byName = new Map(vars);
  const list = [];
  const seen = new Set();
  for (const a of acc) {
    if (!byName.has(a.on)) continue;
    const v = byName.get(a.on),
      o = objOf(v, s.heap);
    let at, text, val;
    if (a.ix) {
      const x = evaluate(a.ix, ints, top, s.heap);
      if (x === null) continue;
      if (typeof v === "string" || (o && o.v && o.t !== "set")) {
        const items = typeof v === "string" ? [...v] : o.v;
        const k = norm(x, items.length);
        if (k < 0 || k >= items.length) continue;
        at = k;
        text = `${a.on}[${k}]`;
        val = fmt(items[k], s.heap);
      } else if (o && o.t === "dict") {
        at = keyOf(x, o, s.heap);
        text = `${a.on}[${at}]`;
        const kv = o.kv.find(([key]) => keyOf(key, o, s.heap) === at);
        val = kv ? fmt(kv[1], s.heap) : null;
      } else continue;
    } else {
      const r0 = evaluate(a.rc[0], ints, top, s.heap),
        c0 = evaluate(a.rc[1], ints, top, s.heap);
      if (r0 === null || c0 === null || !o || !o.v) continue;
      const r = norm(r0, o.v.length),
        row = objOf(o.v[r], s.heap);
      if (r < 0 || r >= o.v.length || !row || !row.v) continue;
      const c = norm(c0, row.v.length);
      if (c < 0 || c >= row.v.length) continue;
      at = `${r},${c}`;
      text = `${a.on}[${r}][${c}]`;
      val = fmt(row.v[c], s.heap);
    }
    const id = `${text}|${a.w}`;
    if (seen.has(id)) continue;
    seen.add(id);
    list.push({ on: a.on, ref: isRef(v) ? v.r : `s:${a.on}`, at, text, val, w: !!a.w });
  }
  return list.length ? { test: !!s.cond, list } : null;
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
      const cr = el("span", "vz-cr");
      b.append(el("span", "vz-cl", n.label), cr);
      b.style.cssText = `left:${n.x - n.w / 2}px;top:${n.d * CT_ROW + 6}px;width:${n.w}px`;
      b.title = n.value === null ? n.full : `${n.full} → ${n.value}`;
      if (n.rep > 1) {
        // the same arguments as an earlier call: work done again (a memo / cache would skip it)
        b.classList.add("rep");
        b.append(el("span", "vz-rep", `×${n.rep}`));
        b.title += `\nCall ${n.rep} of ${n.twins.length} with these same arguments`;
      }
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
      return { n, b, path, cr };
    });
  }
  update(i, step) {
    const live = new Set(step.stack.map((f) => f.id)),
      cur = step.stack.length ? step.stack[step.stack.length - 1].id : -1;
    const twins = new Set(this.items.find((x) => x.n.id === cur && x.n.rep)?.n.twins || []);
    let curEl = null;
    for (const { n, b, path, cr } of this.items) {
      const shown = !n.id || n.call <= i;
      const done = n.ret >= 0 && n.ret <= i;
      const raised = !!n.id && !done && !live.has(n.id) && n.last < i;
      b.classList.toggle("off", !shown);
      b.classList.toggle("live", live.has(n.id));
      b.classList.toggle("cur", n.id === cur);
      b.classList.toggle("done", done);
      b.classList.toggle("bad", raised);
      b.classList.toggle("twin", shown && twins.has(n) && n.id !== cur);
      cr.textContent = done ? `→ ${clip(n.value, 24)}` : raised ? "raised" : "";
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
    placeholder:
      "A call, like fib(5), or LeetCode test cases pasted from the problem (nums = [2,7,11,15], target = 9) or its Testcase tab. Leave empty to run a script, or for a suggested call.",
    onkeydown: editKeys,
  });
  const runBtn = h("button.primary.vz-run", { textContent: "Run", title: "Run (Ctrl+Enter)", onclick: () => run() });
  // shown when the code was edited since the run that's shown (its lines no longer match)
  const editedTag = h("span.vz-edited", { textContent: "edited · Ctrl+Enter runs it", hidden: true });
  // what the marks on the code mean, while they're the run's
  const codeKey = h(
    "span.vz-codekey",
    { hidden: true },
    h("i.ran", { textContent: "just ran" }),
    h("i.cur", { textContent: "runs next" }),
    h("i.hits", { textContent: "×3: times it ran" }),
  );
  const note = h("p.vz-note");
  const caseBar = h("div.vz-cases", { role: "group", ariaLabel: "Test case", hidden: true });
  // The code is always editable: the editor lies over the source column of the traced lines (codeBox), which show under it what the run
  // does (the line about to run, the one that ran, how many times each ran). Both scroll together in codeWrap; the gutter (line numbers)
  // takes clicks: the next time that line runs.
  const codeBox = h("div.vz-code");
  const codeWrap = h("div.vz-codewrap", {}, codeBox, editor);
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
  // the pictures: the data (frames and their structures), the call tree, the code's statement tree. The call tree shows the data under it.
  const calls = new CallTreeView((n) => go(n));
  const codeTree = new CodeTreeView((line) => jumpToLine(line));
  const callSum = h("p.vz-csum");
  const panes = { data: stage, calls: h("div.vz-pane", {}, callSum, calls.el), outline: h("div.vz-pane", {}, codeTree.el) };
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
    h(
      "span.vz-jumps",
      {},
      btn("↷", "Step over: skip the calls this line makes (Shift+→; Shift+← steps back over)", () => jump(stepOver)),
      btn("⤴", "Step out: to the return of this call (Shift+↑)", () => jump(stepOut)),
      btn("⟳", "Next loop pass (Shift+↓)", () => jump(nextPass)),
    ),
    slider,
    counter,
    speedBtn,
  );
  const right = h(
    "section.vz-right",
    { ariaLabel: "What the program does" },
    caption,
    h("div.vz-tabs", { role: "group", ariaLabel: "Picture" }, tabBtns),
    panes.calls,
    panes.outline,
    stage,
    outBox,
  );
  host.append(
    h(
      "div.vz-body",
      {},
      h(
        "section.vz-left",
        { ariaLabel: "Code and input" },
        h("div.vz-head", {}, langPick, codeKey, editedTag),
        codeWrap,
        h("div.vz-head", {}, h("b", { textContent: "Input" })),
        h("div.vz-inrow", {}, input, runBtn),
        caseBar,
        note,
        status,
      ),
      right,
    ),
    controls,
  );

  const steps = () => (result ? result.steps : []);
  const currentStep = () => steps()[i];
  // a bigger move: step over, back over, step out, next loop pass
  const jump = (to) => steps().length && go(to(steps(), i, result.outline));
  function onKey(e) {
    // typing goes to the text boxes; a focused slider or button already handles its own keys
    if (e.target.matches("textarea, input, select") || (e.key === " " && e.target.matches("button")) || e.ctrlKey || e.metaKey || e.altKey)
      return;
    if (e.key === "ArrowRight" && e.shiftKey) jump(stepOver);
    else if (e.key === "ArrowLeft" && e.shiftKey) jump(backOver);
    else if (e.key === "ArrowUp" && e.shiftKey) jump(stepOut);
    else if (e.key === "ArrowDown" && e.shiftKey) jump(nextPass);
    else if (e.key === "ArrowRight") go(i + 1);
    else if (e.key === "ArrowLeft") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(steps().length - 1);
    else if (e.key === " ") toggle();
    else return;
    e.preventDefault();
  }
  function show(k) {
    tab = k;
    for (const [name, pane] of Object.entries(panes)) pane.hidden = name !== k && !(name === "data" && k === "calls");
    right.classList.toggle("split", k === "calls");
    tabBtns.forEach((b, n) => (b.ariaPressed = String(Object.keys(TABS)[n] === k)));
    if (steps().length) draw(false);
  }
  // The run shown is of other code once the code is edited: it goes, until the next Run.
  function clearRun() {
    stop();
    result = picked = null;
    effects = [];
    frameEls.clear();
    legendHistory.clear();
    for (const box of [stage, caption, outBox, calls.el, codeTree.el, caseBar]) box.replaceChildren();
    caption.append(h("span.vz-hint", { textContent: "The code changed: press Run (Ctrl+Enter) to trace it." }));
    callSum.textContent = note.textContent = "";
    caseBar.hidden = true;
    slider.max = slider.value = "0";
    counter.textContent = "";
  }
  // The lines under the editor, for the code in it. Their marks are the run's only while the code is the code that ran.
  let rowsFor = null;
  function syncRows() {
    const text = editor.value;
    if (rowsFor !== text) {
      codeBox.replaceChildren(
        ...text
          .split("\n")
          .map((line, n) =>
            h(
              "div.vz-line",
              { onclick: () => jumpToLine(n + 1) },
              h("span.vz-ln", { textContent: String(n + 1), title: "Go to the next time this line runs" }),
              h("span.vz-hits"),
              h("span.vz-src", { textContent: line || " " }),
            ),
          ),
      );
      rowsFor = text;
    }
    fitEditor();
    const fresh = text === tracedCode && steps().length > 0;
    editedTag.hidden = tracedCode === null || text === tracedCode;
    codeKey.hidden = !fresh;
    codeWrap.classList.toggle("stale", !fresh);
    return fresh;
  }
  // the editor as big as its text (or the box): it doesn't scroll itself, the box scrolls it with the lines under it
  function fitEditor() {
    const gutter = codeBox.querySelector(".vz-src")?.offsetLeft;
    if (gutter) codeWrap.style.setProperty("--vz-gutter", `${gutter}px`);
    editor.style.height = editor.style.width = "0";
    editor.style.height = `${Math.max(editor.scrollHeight, codeWrap.clientHeight)}px`;
    editor.style.width = `${Math.max(editor.scrollWidth, codeWrap.clientWidth - (gutter || 0))}px`;
  }
  function jumpToLine(line) {
    const all = steps();
    const at = (k) => all[k].ev === "line" && all[k].line === line;
    let k = all.findIndex((_, n) => n > i && at(n));
    if (k < 0) k = all.findIndex((_, n) => at(n)); // (wraps around to the first time)
    if (k >= 0) go(k);
  }
  function load(ex) {
    caseAt = 0;
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
  const framePref = new Map(); // frame id -> open or not, once its header was clicked
  const legendHistory = new Map(); // "frame:name" -> Set(marks ever shown)
  let lastTop = null; // the current call when last drawn
  let callOf = new Map(); // frame id -> its call in the call tree
  let sorts = new Set(); // lists whose items a test compares with each other (sorting code)
  let effects = []; // step -> what the line that ran before it read and wrote (lineEffects)
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
    const fresh = syncRows(); // (code edited since the run: its lines don't match, so they're not marked)
    [...codeBox.children].forEach((line, n) => {
      line.classList.toggle("cur", fresh && n + 1 === s.line);
      line.classList.toggle("ran", fresh && n + 1 === ran && ran !== s.line);
      line.classList.toggle("bad", fresh && n + 1 === s.line && s.ev === "exception");
      const hits = fresh && counts.has(n + 1) ? `×${counts.get(n + 1)}` : "";
      if (line.children[1].textContent !== hits) line.children[1].textContent = hits;
    });
    const curLine = fresh && codeBox.children[s.line - 1];
    if (curLine && document.activeElement !== editor) {
      const top = curLine.offsetTop, // (.vz-code is at the top of the box, so this is measured from the box's top)
        bottom = top + curLine.offsetHeight;
      if (top < codeWrap.scrollTop || bottom > codeWrap.scrollTop + codeWrap.clientHeight)
        codeWrap.scrollTop = top - codeWrap.clientHeight / 2;
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
        ? [h("div.vz-result", {}, h("span", { textContent: "Result " }), h("b", { textContent: resultText(result.result) }), ...verdict())]
        : []),
      ...(last && result.error ? [h("div.vz-error", { textContent: result.error })] : []),
      ...(last && result.truncated
        ? [h("div.vz-error", { textContent: "Stopped after 1,500 steps. Try a smaller input to see the whole run." })]
        : []),
    );
  }

  // The test on the line that just ran in step n's call (an if / elif / while, or a JavaScript for): the step that was about to run it
  // (k), what it came out as (cond) and the test (c, from the tracer's table). null when that line tested nothing.
  function testBefore(n) {
    const all = steps(),
      id = frameAt(all, n);
    for (let k = n - 1; k >= 0; k--)
      if (frameAt(all, k) === id) {
        const c = all[k].ev === "line" && all[k].cond;
        return c && typeof c.v === "boolean" && result.conds?.[c.k] ? { k, cond: c, c: result.conds[c.k] } : null;
      }
    return null;
  }
  // a test as code with its values put in ("nums[mid] < target → 3 < 5"), then once it ran, true / false and what that makes the code do
  function testNodes(t, ran, values = true) {
    const vals = values && condValues(t.c, t.cond, steps()[t.k].heap);
    const out = [h("code.vz-cond", { textContent: t.c.t.replace(/\s+/g, " ") })];
    if (vals) out.push(ran ? " → " : ", that is ", h("code.vz-cond", { textContent: vals }));
    if (ran)
      out.push(
        " → ",
        h(`b.vz-tf.${t.cond.v ? "yes" : "no"}`, { textContent: t.cond.v ? SYN.yes : SYN.no }),
        `, ${outcome(t.c.kind, t.cond.v)}`,
      );
    return out;
  }
  // The items the line that ran before step n read, with their values then ("dp[4] = 2, coins[1] = 2"): not the items it also wrote (their
  // old value is in the caption already), nor a test's (shown as the test). null when there are none.
  const sourcesOf = (n) => readsText(effects[n]);
  // (readsText(accessesAt(step)) is what the line about to run at that step will read)
  function readsText(e) {
    if (!e || e.test) return null;
    const wrote = new Set(e.list.filter((x) => x.w).map((x) => x.text));
    const from = e.list.filter((x) => !x.w && !wrote.has(x.text) && x.val !== null);
    return from.length
      ? from
          .slice(0, 3)
          .map((x) => `${x.text} = ${clip(x.val, 20)}`)
          .join(", ")
      : null;
  }
  // a call made before with the same arguments (recursion without a memo): what it returned then
  function repeatNote(n) {
    const node = callOf.get(frameAt(steps(), n));
    if (!node || !(node.rep > 1)) return [];
    const first = node.twins[0];
    return first.ret >= 0 && first.ret < n
      ? [`called before with these arguments: it returned ${first.value} then (a memo / cache could reuse that)`]
      : ["called before with these arguments, and that call hasn't returned yet"];
  }

  function captionFor(s, prev) {
    const all = steps();
    const top = s.stack[s.stack.length - 1];
    const parts = [];
    const script = top.fn === "<module>";
    const args = top.loc.filter(([k]) => k !== "self" && (s.params || []).includes(k)); // (a closure's outer variables aren't arguments)
    const test = testBefore(i);
    let testFirst = true;
    if (s.ev === "call") {
      parts.push(script ? "The program starts" : `${top.fn}(${args.map(([k, v]) => `${k}=${fmt(v, s.heap)}`).join(", ")})`);
      parts.push(...repeatNote(i));
    } else if (s.ev === "return") {
      parts.push(script ? "The program ends" : `${top.fn} returns ${fmt(s.ret, s.heap)}`);
      if (sourcesOf(i)) parts.push(`from ${sourcesOf(i)}`);
    } else if (s.ev === "exception") parts.push(s.exc);
    else if (prev) {
      const ptop = prev.stack[prev.stack.length - 1];
      if (prev.ev === "return" && ptop.id !== top.id) {
        parts.push(`Back in ${fnName(top.fn)}, ${ptop.fn} returned ${fmt(prev.ret, prev.heap)}`);
        testFirst = false; // (the call was part of the test)
      } else if (prev.ev === "call" && ptop.id === top.id) parts.push(script ? "Start of the program" : `Start of ${top.fn}`);
      else if (ptop && ptop.id === top.id) {
        const queues = new Set(result.pointers?.[top.fn]?.queues || []);
        const changes = diff(variables(ptop, prev.heap), variables(top, s.heap), prev.heap, s.heap, queues);
        // where the program went after an if / loop line (a test that was traced says more). Not after the body of a one-line
        // `if (c <= a) dp[a] = ...`: its step is on the test's line too, and where it goes next says nothing about the test.
        let k = i - 2;
        while (k >= 0 && frameAt(all, k) !== top.id) k--;
        const oneLineBody = k >= 0 && all[k].ev === "line" && all[k].line === prev.line;
        const br = test || oneLineBody ? "" : branch(code, prev.line, s.line);
        const from = sourcesOf(i); // what the new values were worked out from: dp[5]: inf → 3 · from dp[4] = 2
        parts.push(...changes.slice(0, 3));
        if (from) parts.push(changes.length ? `from ${from}` : `read ${from}`);
        if (br) parts.push(br);
        if (!parts.length && !test) parts.push("No variable changed");
      }
    } else parts.push("Start");
    const what = [];
    const add = (...xs) => what.push(...(what.length ? [" · "] : []), ...xs);
    if (test && testFirst) add(...testNodes(test, true));
    parts.forEach((p) => add(p));
    if (test && !testFirst) add(...testNodes(test, true));
    // what the line about to run will test and look up, worked out from the values now
    const next = [];
    const more = (...xs) => next.push(...(next.length ? [" · "] : []), ...xs);
    let shown = false;
    if (s.ev === "line" && s.cond && result.conds?.[s.cond.k]) {
      const calls = (all[i + 1]?.stack.length ?? 0) > s.stack.length; // (the test calls a function: its values aren't known yet)
      const nodes = testNodes({ k: i, cond: s.cond, c: result.conds[s.cond.k] }, false, !calls);
      shown = nodes.length > 1;
      more("checks ", ...nodes);
    }
    // what it will read, at the indexes worked out now (dp[3][1] = 1); then lookups that aren't reads at an index (is 6 in seen?)
    const ahead = s.ev === "line" ? readsText(accessesAt(s, result.pointers)) : null;
    if (ahead) more(`reads ${ahead}`);
    if (s.ev === "line") lookups(s, top).forEach((l) => (!shown || !l.label) && !(ahead && l.label) && more(l.text));
    // which pass of the loop around the line this is (not on the loop's own line: there, a pass starts or the loop ends)
    const loop = s.ev === "line" ? loopAround(result.outline, s.line) : null;
    const pass = loop && s.line !== headerOf(loop) ? loopPass(all, i, result.outline) : 0;
    const ranLine = prev && prev.ev === "line" && prev.stack.length ? prev.line : 0;
    return [
      h(
        "span.vz-step",
        {},
        h("span", {
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
        pass > 0 && h("span.vz-pass", { textContent: `loop pass ${pass}` }),
      ),
      h(
        "div.vz-say",
        {},
        h("div.vz-what", {}, what),
        next.length > 0 && h("div.vz-next", {}, h("span.vz-nl", { textContent: "next " }), next),
      ),
    ];
  }

  // The lookups the line about to run will do, worked out from the current values: "is 9 - 7 = 2 in seen? yes".
  function lookups(s, frame) {
    const info = (result.pointers || {})[frame.fn];
    if (!info || !info.probes) return [];
    const vars = variables(frame, s.heap);
    const ints = new Map(vars.filter(([, v]) => Number.isInteger(v)).map(([k, v]) => [k, v]));
    const byName = new Map(vars);
    const out = [];
    for (const p of info.probes) {
      if (p.line !== s.line || !byName.has(p.on)) continue;
      const val = evaluate(p.e, ints, frame, s.heap);
      if (val === null) continue;
      const o = objOf(byName.get(p.on), s.heap);
      const key = keyOf(val, o, s.heap);
      const shown = p.text.replace(/\s+/g, " ");
      const math = shown === key ? key : `${shown} = ${key}`;
      if (p.kind === "in" && o) {
        const keys = o.t === "dict" ? o.kv.map(([k]) => keyOf(k, o, s.heap)) : (o.v || []).map((x) => fmt(x, s.heap));
        const found = keys.includes(key);
        out.push({ on: p.on, key, idx: val, miss: !found, text: `is ${math} in ${p.on}? ${found ? "yes" : "no"}` });
      } else out.push({ on: p.on, key, idx: val, label: shown, text: `reads ${p.on}[${math}]` });
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
    const topFrame = s.stack[s.stack.length - 1];
    // the callers' structures the current call also has (a list sorted in place, a grid searched) are drawn once, in the current call
    const shared = new Set(variables(topFrame, s.heap).flatMap(([, v]) => (isRef(v) ? [v.r] : [])));
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
        const id = f.id;
        fe.head.onclick = () => {
          if (fe.isTop) return;
          framePref.set(id, !fe.open);
          draw(false);
        };
        // delegated hover listeners for variable linking
        fe.el.addEventListener("mouseover", (e) => {
          const target = e.target.closest("[data-var]");
          if (!target) return;
          const vars = target.dataset.var.split(" ");
          vars.forEach((v) => {
            fe.el.querySelectorAll(`[data-var]`).forEach((el) => {
              if (el.dataset.var.split(" ").includes(v)) el.classList.add("link");
            });
          });
        });
        fe.el.addEventListener("mouseout", (e) => {
          const target = e.target.closest("[data-var]");
          if (!target) return;
          fe.el.querySelectorAll(".link").forEach((el) => el.classList.remove("link"));
        });
        // keyboard focus support for chips
        fe.el.addEventListener("focusin", (e) => {
          const target = e.target.closest("[data-var]");
          if (!target) return;
          const vars = target.dataset.var.split(" ");
          vars.forEach((v) => {
            fe.el.querySelectorAll(`[data-var]`).forEach((el) => {
              if (el.dataset.var.split(" ").includes(v)) el.classList.add("link");
            });
          });
        });
        fe.el.addEventListener("focusout", (e) => {
          const target = e.target.closest("[data-var]");
          if (!target) return;
          fe.el.querySelectorAll(".link").forEach((el) => el.classList.remove("link"));
        });
        fe.el.append(fe.head, fe.scalars, fe.structs);
        if (animate) fe.el.classList.add("enter");
        frameEls.set(f.id, fe);
      }
      if (stage.children[depth] !== fe.el) stage.insertBefore(fe.el, stage.children[depth] || null);
      // the current call and its two callers are open; a click on a caller's header opens or closes it
      fe.isTop = isTop;
      fe.open = isTop || (framePref.has(f.id) ? framePref.get(f.id) : depth >= s.stack.length - 3);
      fe.el.classList.toggle("top", isTop);
      fe.el.classList.toggle("ret", isTop && s.ev === "return");
      fe.el.classList.toggle("paused", !isTop && fe.open);
      fe.el.classList.toggle("collapsed", !fe.open);
      fe.head.title = isTop ? "" : `Click to ${fe.open ? "hide" : "show"} this call's data`;
      frameHead(fe, f, s, depth, isTop);
      // nodes the outer frames point at (recursion on a tree): drawn too, so the top frame shows the whole tree and the path down it
      const outerNodes = s.stack.slice(0, depth).flatMap((o) => o.loc.filter(([, x]) => isNode(objOf(x, s.heap))).map(([, x]) => x.r));
      drawFrame(
        fe,
        f,
        s.heap,
        prevFrames.get(f.id),
        prev ? prev.heap : {},
        animate && prevFrames.has(f.id),
        isTop,
        outerNodes,
        isTop ? null : shared,
        s.stack,
      );
    });
    // a new current call comes into view
    const topEl = frameEls.get(topFrame.id)?.el;
    if (topEl && topFrame.id !== lastTop) reveal(topEl);
    lastTop = topFrame.id;
  }
  // Scrolls the pictures' own box (not the page: on a narrow screen the page scrolls, and the caption and code would go) to show `e`.
  function reveal(e) {
    const box = [stage, right].find((b) => getComputedStyle(b).overflowY !== "visible" && b.scrollHeight > b.clientHeight);
    if (!box) return;
    const r = e.getBoundingClientRect(),
      b = box.getBoundingClientRect(),
      top = b.top + (box === right ? caption.offsetHeight : 0); // (the caption stays at the top of the column)
    if (r.bottom > b.bottom) box.scrollTop += Math.min(r.bottom - b.bottom, r.top - top);
    else if (r.top < top) box.scrollTop -= top - r.top;
  }

  // A frame's header: the call (with its arguments), line badge, and return status if returning.
  // Frames are indented by depth and connected with a continuous rail to show the call chain.
  function frameHead(fe, f, s, depth, isTop) {
    const label = (g) => (g.fn === "<module>" ? "global frame" : callOf.get(g.id)?.label || `${g.fn}()`);
    const maxIndent = 4; // cap indentation for deep recursion
    const indentSteps = Math.min(depth, maxIndent);
    const indentPx = indentSteps * 16;

    // indent the whole card, not just the header
    fe.el.style.setProperty("--indent", `${indentPx}px`);
    // add connector class for frames with a caller (all except the first)
    fe.el.classList.toggle("has-connector", depth > 0);

    const children = [];

    // caret for non-top frames
    if (!isTop) {
      children.push(h("span.vz-caret", { textContent: fe.open ? "▾" : "▸" }));
    }

    // call label
    const callLabel = h("b", { textContent: label(f) });
    if (!isTop) {
      // put the full paused-at code in tooltip
      const codeLine = (code[f.line - 1] || "").trim();
      callLabel.title = `paused at line ${f.line}: ${codeLine}`;
    }
    children.push(callLabel);

    // return status for returning frames
    if (isTop && s.ev === "return") {
      children.push(h("span.vz-fstat", { textContent: `→ returns ${fmt(s.ret, s.heap)}` }));
    }

    // line badge for non-top frames (shows where the caller is paused)
    if (!isTop) {
      const lineBadge = h("span.vz-line-badge", { textContent: `line ${f.line}` });
      lineBadge.onmouseenter = () => {
        const codeLine = codeBox.children[f.line - 1];
        if (codeLine) codeLine.classList.add("paused-at");
      };
      lineBadge.onmouseleave = () => {
        const codeLine = codeBox.children[f.line - 1];
        if (codeLine) codeLine.classList.remove("paused-at");
      };
      children.push(lineBadge);
    }

    fe.head.replaceChildren(...children);
  }

  // What the test about to run (or that just ran) in the current call compares: list items (list name -> indexes), grid cells
  // (name -> "r,c") and variables. Only the operands the run worked out (an and / or can stop early).
  function compared(ints, frame, heap) {
    const s = currentStep();
    const t = s.ev === "line" && s.cond && result.conds?.[s.cond.k] ? { cond: s.cond, c: result.conds[s.cond.k] } : testBefore(i);
    const out = { cells: new Map(), grid: new Map(), vars: new Set() };
    if (!t) return out;
    const add = (m, k, x) => m.set(k, (m.get(k) || new Set()).add(x));
    for (const [k] of t.cond.o) {
      const op = t.c.ops[k];
      if (!op || !op.on) continue;
      if (op.ix) {
        const x = evaluate(op.ix, ints, frame, heap);
        if (x !== null) add(out.cells, op.on, x);
      } else if (op.rc) {
        const r = evaluate(op.rc[0], ints, frame, heap),
          c = evaluate(op.rc[1], ints, frame, heap);
        if (r !== null && c !== null) add(out.grid, op.on, `${r},${c}`);
      } else out.vars.add(op.on);
    }
    return out;
  }

  // `shared`: for a caller, the structures the current call draws (here they're a chip)
  // The items (index) / cells ("r,c") of the container `ref` the line that ran read (rd) and wrote (wr). A cell read and written
  // (dp[i] = min(dp[i], ...)) counts as written; a test's reads are shown as what it compared.
  function touched(ref) {
    const e = effects[i],
      out = {};
    for (const x of e?.list || []) if (x.ref === ref && (x.w || !e.test) && x.at !== null) (out[x.w ? "wr" : "rd"] ||= new Set()).add(x.at);
    if (out.rd && out.wr) for (const k of out.wr) out.rd.delete(k);
    return out;
  }
  // The items / cells of `ref` written by any line so far: how far a DP table has been filled.
  function filledSoFar(ref) {
    const out = new Set();
    for (let k = 0; k <= i; k++) for (const x of effects[k]?.list || []) if (x.w && x.ref === ref && x.at !== null) out.add(x.at);
    return out;
  }
  // `stack`: the frames on the call stack (a recursion over a grid marks the cells its callers are at)
  function drawFrame(fe, frame, heap, prevFrame, prevHeap, animate, isTop, outerNodes = [], shared = null, stack = []) {
    const vars = variables(frame, heap);
    const ptrInfo = (result.pointers || {})[frame.fn] || { idx: {}, keys: {}, grid: {} };
    const looks = isTop && currentStep().ev === "line" ? lookups(currentStep(), frame) : [];
    const ints = new Map(vars.filter(([, v]) => Number.isInteger(v)).map(([k, v]) => [k, v]));
    const valuesByName = new Map(vars.map(([k, v]) => [k, v]));
    const before = new Map(prevFrame ? variables(prevFrame, prevHeap) : []);
    const cmp = isTop ? compared(ints, frame, heap) : null;
    const asChip = new Set();
    // track which variables are drawn as pointers/labels (for hover linking and static cue on chips)
    const drawnAsPointer = new Set();
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
      const len = typeof v === "string" ? v.length : (objOf(v, heap)?.v?.length ?? 0);
      /** @type {{ name: string, idx: number, probe?: boolean }[]} */
      const ptrs = windowEnds(ptrInfo.idx[name] || [], ints)
        .filter((p) => ints.has(p))
        .map((p) => ({ name: p, idx: ints.get(p) }))
        .filter((p) => p.idx >= 0 && p.idx <= len);
      for (const l of looks) {
        if (l.on === name && l.label && Number.isInteger(l.idx) && l.idx >= 0 && l.idx < len)
          ptrs.push({ name: l.label, idx: l.idx, probe: true });
      }
      let kind = kindOf(v, heap, ptrs, name);
      if (kind === "scalar") continue;
      if (shared && ((isRef(v) && shared.has(v.r)) || kind === "nodes")) {
        asChip.add(name); // (a caller's nodes are drawn in the current call's picture)
        continue;
      }
      // how the code uses the list picks a richer picture (static, from the code: see analyse() in viz/tracer.py)
      const o0 = objOf(v, heap);
      if (o0 && (o0.t === "list" || o0.t === "deque") && ["array", "grid", "rows"].includes(kind)) {
        if ((ptrInfo.heaps || []).includes(name)) kind = "heap";
        else if ((ptrInfo.queues || []).includes(name))
          kind = "queue"; // (a deque used at both ends is a queue, not a stack)
        else if ((ptrInfo.stacks || []).includes(name)) kind = "stack";
        else if (o0.t === "deque") kind = "queue";
        else if (kind === "grid" && isIntervals(o0, heap, name, vars)) kind = "intervals";
        else if (kind === "grid" && isRef(v) && !isRefGridInStack(v.r, stack, result.pointers, name)) {
          kind = "rows"; // not indexed as a grid anywhere, so it's a collection
        }
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
      const changedRef = prevFrame && (prevFrame.loc.find(([k]) => k === name) || [])[1];
      const reassigned = animate && changedRef !== undefined && isRef(changedRef) && isRef(v) && changedRef.r !== v.r;
      if (reassigned) flash(item.wrap, "chg-box");
      if (kind === "array" || kind === "chars") {
        const items = typeof v === "string" ? [...v] : o.v.map((x) => cellText(x, heap));
        const nums = typeof v !== "string" && o.v.length > 1 && o.v.every((x) => typeof x === "number") ? o.v : null;
        const key = `${frame.fn}:${name}`;
        if (nums && !barsPref.has(key)) barsPref.set(key, (ptrInfo.swaps || []).includes(name)); // sorting code starts as bars
        // the items the code compares, the two it just swapped, and (sorting) the ones already where they'll end up
        const marks = {};
        if (cmp?.cells.has(name)) marks.cmp = new Set([...cmp.cells.get(name)].map((x) => (x < 0 ? x + items.length : x)));
        const was = objOf(before.get(name), prevHeap);
        const sw =
          animate && was?.v && isRef(v) && before.get(name).r === v.r
            ? swapOf(
                was.v.map((x) => cellText(x, prevHeap)),
                items,
              )
            : null;
        if (isTop && sw) marks.swp = new Set(sw);
        const sorting = (ptrInfo.swaps || []).includes(name);
        if (isTop && nums && sorts.has(name) && sorting) marks.done = settled(nums);
        // what the line that ran read and wrote, what's been written so far (a DP array filling up), and the items whose index is kept in
        // another list (a monotonic stack of indexes)
        const ref = isRef(v) ? v.r : `s:${name}`;
        if (isTop) Object.assign(marks, touched(ref));
        const fill = sorting ? null : filledSoFar(ref);
        if (fill?.size) marks.fill = fill;
        const held = heldBy(ptrInfo, name, valuesByName, heap, items.length);
        if (held) marks.held = held[1];
        // in a caller frame: which cells were passed as a slice to the callee (worked out afresh each step: once the call returns, no mark)
        item.sliceParam = null;
        if (!isTop && stack.length > 0) {
          const calleeIdx = stack.findIndex((f) => f.id === frame.id) + 1;
          if (calleeIdx > 0 && calleeIdx < stack.length) {
            const callee = stack[calleeIdx];
            const pausedLine = code[frame.line - 1]?.trim() || "";
            const calleeNode = callOf.get(callee.id);
            if (calleeNode) {
              // extract the call: find function_name(...) or obj.method(...)
              const inner = callArgs(pausedLine, calleeNode.fn);
              if (inner !== null) {
                const args = splitArgs(inner);
                // get callee's parameters: first locals at the call step are parameters (in order)
                const calleeVars = variables(callee, heap);
                const params = calleeVars.filter(([k]) => k !== "self" && k !== "this").slice(0, args.length);
                // match each argument with its parameter
                for (let i = 0; i < Math.min(args.length, params.length); i++) {
                  const arg = args[i];
                  const [paramName, paramVal] = params[i];
                  const slice = parseSlice(arg, SYN.js);
                  if (slice && slice.name === name) {
                    // evaluate bounds
                    const lo = evalBound(slice.lo, ints, items.length, name);
                    const hi = evalBound(slice.hi, ints, items.length, name);
                    if (lo !== null && hi !== null && lo >= 0 && hi <= items.length && lo < hi) {
                      // cross-check: callee's parameter values should match caller's slice
                      const calleeItems =
                        typeof paramVal === "string" ? [...paramVal] : objOf(paramVal, heap)?.v?.map((x) => cellText(x, heap));
                      if (calleeItems && calleeItems.length === hi - lo && items.slice(lo, hi).every((x, j) => x === calleeItems[j])) {
                        marks.slice = new Set([...Array(hi - lo)].map((_, j) => lo + j));
                        item.sliceParam = paramName;
                        break;
                      }
                    }
                  }
                }
              }
            }
          }
        }
        item.view.update(items, ptrs, animate && !reassigned, nums, !!nums && barsPref.get(key), [], marks);
        item.toggle = nums ? key : null;
        const named = {};
        if (held) named.held = `in ${held[0]}`;
        if (item.sliceParam) named.slice = `→ ${item.sliceParam}`;
        item.legend = legendOf(marks, named);
        // track variables drawn as pointers (skip probes)
        ptrs.filter((p) => !p.probe).forEach((p) => drawnAsPointer.add(p.name));
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
        let curVars = null;
        if (g) {
          const r = g[0].find((p) => ints.has(p) && ints.get(p) >= 0 && ints.get(p) < rows.length);
          const c = g[1].find((p) => ints.has(p) && ints.get(p) >= 0 && ints.get(p) < (rows[0] || []).length);
          if (r !== undefined && c !== undefined) {
            cur = [ints.get(r), ints.get(c)];
            curVars = [r, c];
          }
        }
        const marks = {};
        if (cmp?.grid.has(name)) marks.cmp = cmp.grid.get(name);
        if (isTop) Object.assign(marks, touched(v.r));
        const fill = filledSoFar(v.r);
        if (fill.size) marks.fill = fill;
        // a recursion over the grid (flood fill, word search): the cells its callers are at, the way down to this call
        if (isTop && g) {
          const path = new Set();
          for (const f of stack.slice(0, -1)) {
            if (f.fn !== frame.fn) continue;
            const loc = new Map(f.loc);
            const r = g[0].map((p) => loc.get(p)).find(Number.isInteger),
              c = g[1].map((p) => loc.get(p)).find(Number.isInteger);
            if (r !== undefined && c !== undefined && r >= 0 && r < rows.length && c >= 0 && c < (rows[0] || []).length)
              path.add(`${r},${c}`);
          }
          if (path.size) marks.path = path;
        }
        // a visited set of (r, c), and a queue / stack of them (a BFS over a grid)
        const named = {};
        for (const [n2, v2] of vars) {
          const o2 = objOf(v2, heap);
          if (!o2 || n2 === name || !o2.v) continue;
          const which = o2.t === "set" ? "seen" : o2.t === "deque" || frontierNames(ptrInfo).has(n2) ? "front" : null;
          const cells = which && !marks[which] ? cellsIn(o2, heap, rows.length, (rows[0] || []).length) : null;
          if (!cells) continue;
          marks[which] = cells;
          named[which] = `in ${n2}`;
        }
        item.view.update(rows, cur, animate, marks, gridAxes(ptrInfo, g, valuesByName, rows.length, (rows[0] || []).length), curVars);
        item.legend = legendOf(marks, named);
        // track variables drawn as grid coordinates
        if (curVars) curVars.forEach((v) => drawnAsPointer.add(v));
      } else if (kind === "dict") {
        const keyVarNames = ptrInfo.keys[name] || [];
        const keyVars = keyVarNames.filter((k) => valuesByName.has(k)).map((k) => keyOf(valuesByName.get(k), o, heap));
        keyVars.push(...looks.filter((l) => l.on === name).map((l) => l.key));
        // build hotVars for hover linking (map key to variable name)
        const hotVars = keyVarNames
          .filter((k) => valuesByName.has(k))
          .map((k) => ({ key: keyOf(valuesByName.get(k), o, heap), varName: k }));
        item.view.update(
          o.kv.map(([k, x]) => [keyOf(k, o, heap), fmt(x, heap)]),
          new Set(keyVars),
          animate,
          looks.filter((l) => l.on === name && l.miss).map((l) => l.key),
          hotVars,
        );
        // track variables drawn as dict keys
        keyVarNames.forEach((k) => drawnAsPointer.add(k));
      } else if (kind === "graph") {
        const g = adjacency(o, heap, name);
        const labels = new Map();
        for (const p of ptrs) labels.set(String(p.idx), [...(labels.get(String(p.idx)) || []), p.name]);
        for (const k of ptrInfo.keys[name] || [])
          if (valuesByName.has(k)) {
            const key = keyOf(valuesByName.get(k), o, heap);
            if (!labels.get(key)?.includes(k)) labels.set(key, [...(labels.get(key) || []), k]);
          }
        const state = graphState(g, o, name, vars, heap, ptrInfo, valuesByName, labels);
        item.view.update(g, labels, animate, state);
        item.legend = state.legend;
        // track variables drawn as graph labels
        labels.forEach((names) => names.forEach((n) => drawnAsPointer.add(n)));
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
          looks.filter((l) => l.on === name && l.miss).map((l) => l.key),
        );
      else if (kind === "nodes") {
        const roots = [...outerNodes, ...(o.t === "list" ? o.v.filter(isRef).map((x) => x.r) : [v.r])]; // outer frames first: the whole tree
        for (const [, x] of vars) {
          const xo = objOf(x, heap);
          if (xo && isNode(xo)) roots.push(x.r);
          if (xo && xo.t === "dict") xo.kv.forEach(([, y]) => isRef(y) && isNode(heap[y.r]) && roots.push(y.r));
        }
        item.view.update(roots, heap, nodeLabels, animate, new Set(outerNodes));
        // track variables drawn as node labels
        nodeLabels.forEach((names) => names.forEach((n) => drawnAsPointer.add(n)));
      } else if (kind === "obj") {
        item.wrap.lastChild.replaceChildren(...o.a.map(([k, x]) => h("span.vz-chip", { textContent: `${k} = ${fmt(x, heap)}` })));
      }
      const names = [name, ...item.alias];
      // simplified descriptor: "queue · 5", "list · 8", "dict · 3", keeping class names like "MinStack"
      let descriptor = "";
      if (typeof v === "string") {
        descriptor = `${SYN.js ? "string" : "str"} · ${v.length}`;
      } else if (o) {
        const typeName = o.cls || SYN.names[o.t] || o.t;
        const count = o.n !== undefined ? ` · ${o.n}` : "";
        descriptor = `${typeName}${count}`;
      }
      const legend = ["array", "chars", "grid", "graph"].includes(kind) ? item.legend || [] : [];
      // track all marks ever shown for this structure to keep legend stable
      const historyKey = `${frame.id}:${name}`;
      const allMarks = legendHistory.get(historyKey) || new Set();
      for (const [m] of legend) if (m !== "slice") allMarks.add(m); // (a slice is the caller's while its call runs, not a mark to keep)
      legendHistory.set(historyKey, allMarks);
      const currentMarks = new Set(legend.map(([m]) => m));
      const stableLegend = [...new Set([...allMarks, ...currentMarks])]
        .filter((m) => MARKS.includes(m))
        .map((m) => {
          const text = legend.find(([mark]) => mark === m)?.[1] || LEGEND[m] || m;
          return [m, text, currentMarks.has(m)];
        });
      // an empty container is a word on its name line, not a box
      const isEmpty =
        !!o && ["array", "chars", "queue", "stack", "heap", "set", "dict"].includes(kind) && (o.kv ?? o.v ?? [0]).length === 0;
      // a structure is active when it's touched by the current line (read, written, compared, looked up, or changed)
      let hasActivity = false;
      if (isTop) {
        const ref = isRef(v) ? v.r : `s:${name}`;
        const t = touched(ref);
        const isLookedUp = looks.some((l) => l.on === name);
        const isCompared = cmp?.vars.has(name) || cmp?.cells.has(name) || cmp?.grid.has(name);
        const prevValue = before.get(name);
        const changed =
          animate &&
          prevValue !== undefined &&
          (isRef(v) && isRef(prevValue) ? v.r !== prevValue.r : fmt(v, heap) !== fmt(prevValue, prevHeap));
        hasActivity = !!(t.rd || t.wr || isLookedUp || isCompared || changed);
      }
      item.wrap.classList.toggle("active", hasActivity);
      // size class for responsive layout: big structures span full width, small ones can sit side by side
      const sizeCls =
        ["graph", "grid", "nodes", "heap", "intervals"].includes(kind) || (kind === "array" && o && o.v && o.v.length > 12)
          ? "vz-big"
          : "vz-small";
      item.wrap.classList.toggle("vz-big", sizeCls === "vz-big");
      item.wrap.classList.toggle("vz-small", sizeCls === "vz-small");
      item.label.replaceChildren(
        ...[
          h("b", { textContent: names.join(" = ") }),
          h("span", { textContent: descriptor }),
          isEmpty && h("span.vz-empty", { textContent: "empty" }),
          ...stableLegend.map(([m, text, active]) => {
            const badge = h(`i.vz-lg.${m}`, { textContent: text });
            badge.classList.toggle("dimmed", !active);
            return badge;
          }),
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
      // hide the body when empty
      const scroll = item.wrap.querySelector(".vz-scroll, .vz-objbody");
      if (scroll) scroll.style.display = isEmpty ? "none" : "";
    }
    // when the current call has no node variables (e.g. root is None) but outer frames do, still draw the tree
    if (isTop && outerNodes.length > 0 && ![...fe.views.values()].some((x) => x.kind === "nodes")) {
      const key = "#outer-nodes";
      seenNames.add(key);
      // find the outermost caller's variable name for these nodes
      let outerName = "";
      for (const f of stack.slice(0, -1)) {
        for (const [n, v] of f.loc) {
          const o = objOf(v, heap);
          if (o && isNode(o)) {
            outerName = n;
            break;
          }
        }
        if (outerName) break;
      }
      let item = fe.views.get(key);
      if (!item) {
        const view = new NodesView();
        const label = h("div.vz-sname");
        const wrap = h("div.vz-struct", {}, label, h("div.vz-scroll", {}, view.el));
        item = { kind: "nodes", view, wrap, label, alias: new Set() };
        fe.views.set(key, item);
        if (animate) wrap.classList.add("enter");
      }
      if (fe.structs.children[order] !== item.wrap) fe.structs.insertBefore(item.wrap, fe.structs.children[order] || null);
      order++;
      item.view.update(outerNodes, heap, nodeLabels, animate, new Set(outerNodes));
      const o = heap[outerNodes[0]];
      const typeText = o ? `${o.cls || "TreeNode"} · the callers' tree` : "";
      item.label.replaceChildren(h("b", { textContent: outerName }), h("span", { textContent: typeText }));
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
    // scalar chips (numbers, strings, None, booleans), nodes as their label, and a caller's structures drawn in the current call
    const chipSeen = new Set();
    let ci = 0;
    for (const [name, v] of vars) {
      if (seenNames.has(name)) continue;
      if (!asChip.has(name) && isRef(v) && objOf(v, heap) && !isNode(objOf(v, heap)) && kindOf(v, heap) !== "scalar") continue; // shown as an alias of a picture
      chipSeen.add(name);
      let c = fe.chips.get(name);
      const isPointer = drawnAsPointer.has(name);
      if (!c) {
        c = h("span.vz-var", { tabIndex: 0 }, h("b", { textContent: name }), h("span"));
        if (animate) c.classList.add("enter");
        fe.chips.set(name, c);
      }
      if (fe.scalars.children[ci] !== c) fe.scalars.insertBefore(c, fe.scalars.children[ci] || null);
      ci++;
      const text = asChip.has(name) ? clip(fmt(v, heap), 28) : fmt(v, heap);
      const changed = before.has(name) && fmt(before.get(name), prevHeap) !== text;
      c.classList.toggle("cmp", !!cmp?.vars.has(name));
      c.classList.toggle("pointer", isPointer); // add class for static cue
      c.dataset.var = name; // add data-var for hover linking
      // written at this step: a variable that's new in this call, or whose value changed (from the values, not from whether the chip
      // was just made: a caller's node becomes a chip when it calls, and that's no change)
      c.classList.toggle("wr", !!prevFrame && (!before.has(name) || changed));
      if (c.lastChild.textContent !== text) {
        c.lastChild.textContent = text;
        if (animate && changed) flash(c);
      }
    }
    for (const [name, c] of fe.chips)
      if (!chipSeen.has(name)) {
        c.remove();
        fe.chips.delete(name);
      }
  }

  // the result; a linked list or tree as LeetCode writes it (ListNode [5,4,3,2,1]), not just its first node
  function resultText({ v, heap }) {
    const o = objOf(v, heap);
    const j = o && isNode(o) ? toJSON(v, heap) : undefined;
    return j === undefined ? fmt(v, heap) : `${o.cls} ${JSON.stringify(j)}`;
  }
  // LeetCode's expected answer for the case that ran, and whether the result is it (✓, ✗)
  function verdict() {
    if (!picked?.expected) return [];
    if (picked.design) return [h("span.vz-exp", { textContent: ` · expected, call by call: ${picked.expected}` })];
    const got = toJSON(result.result.v, result.result.heap);
    const how = got === undefined ? null : compare(got, picked.expected);
    const mark = { same: "✓", order: "✓ same items, in another order", different: "✗" }[how];
    return [
      h("span.vz-exp", { textContent: " · expected " }),
      h("b", { textContent: picked.expected }),
      mark && h(`span.vz-verdict.${how}`, { textContent: ` ${mark}` }),
    ];
  }
  // the test cases in the input, as tabs (Case 1, Case 2 ...) to pick the one that runs
  function showCases(list) {
    caseBar.replaceChildren(
      ...list.map((c, k) =>
        h("button.vz-case", {
          textContent: c.label,
          title: c.call,
          ariaPressed: String(k === caseAt),
          onclick: () => {
            caseAt = k;
            run();
          },
        }),
      ),
    );
    caseBar.hidden = list.length < 2;
  }

  let runs = 0;
  let caseAt = 0; // the test case that runs, of those in the input
  let picked = null; // the test case the shown run is of ({ label, call, expected, design, fn }), or null
  let casesFn = null; // the function (or design class) the input's test cases last ran on
  let casesChecked = true; // false after other code is pasted: the test cases stay if they're for the same function
  async function run() {
    stop();
    const my = ++runs;
    const src = editor.value,
      lang = langPick.value;
    // an input that was filled in for other code gets suggested again for this code
    const driver = input.value === suggested && (src !== tracedCode || lang !== tracedLang) ? "" : input.value;
    runBtn.disabled = true;
    syncRows();
    note.textContent = "";
    status.className = "vz-status";
    status.textContent = (box && box.warm) || lang === "javascript" ? "Running…" : "Starting Python…";
    try {
      // LeetCode test cases (pasted from the problem) become calls of the code's function, its values built into the nodes its
      // parameters are (ListNode, TreeNode) from what the tracer reads in the code
      let parsed = driver.trim() ? parseCases(driver) : null;
      let built = null,
        chosen = null,
        dropped = "";
      if (parsed) {
        const sig = await ask({ mode: "signature", lang, code: src, driver: "", text: "" });
        if (my !== runs) return;
        if (sig.error) throw new Error(sig.error);
        built = testCalls(parsed, sig, lang);
        // other code was pasted: its test cases stay only if they're for the same function (the solution, fixed, pasted again)
        if (!casesChecked && casesFn && (built.error || built.runs[0].fn !== casesFn)) {
          dropped = `The test cases were for ${casesFn.replace(/^Solution\(\)\./, "")}, so they were cleared.`;
          input.value = "";
          parsed = built = null;
        } else if (built.error) throw new Error(built.error);
        else {
          caseAt = Math.min(caseAt, built.runs.length - 1);
          chosen = built.runs[caseAt];
          casesFn = chosen.fn;
        }
      }
      casesChecked = true;
      showCases(built ? built.runs : []);
      const given = chosen ? chosen.driver : dropped ? "" : driver;
      const r = await ask({ mode: "trace", lang, code: src, driver: given, text: "" });
      if (my !== runs) return; // a newer run started meanwhile
      result = r;
      picked = chosen;
      setLanguage(r.lang || "python");
      tracedCode = src;
      tracedLang = lang;
      status.textContent = "";
      if ((!driver.trim() || dropped) && r.driver) input.value = suggested = r.driver;
      input.rows = Math.min(8, Math.max(2, input.value.split("\n").length));
      const who = r.guessed.includes("operations")
        ? "These calls were"
        : r.guessed.length
          ? `The input for ${r.guessed.join(", ")} was`
          : "This call was";
      note.textContent = r.script
        ? "No input, so the code ran as a script."
        : given.trim()
          ? ""
          : `${who} picked automatically. Edit it to try your own, then press Run.`;
      if (chosen) {
        const n = chosen.call.split("\n").length;
        note.replaceChildren(
          `${chosen.label ? `${chosen.label}: ` : ""}ran `,
          chosen.design ? `the test case's ${n} calls` : h("code", { textContent: clip(chosen.call, 140) }),
          ...built.notes.map((x) => ` ${x}`),
        );
      }
      if (dropped) note.textContent = `${dropped} ${note.textContent}`;
      code = src.split("\n");
      syncRows();
      if (document.activeElement === editor) editor.blur(); // (Ctrl+Enter in the code: the keys step through the run again)
      frameEls.forEach((fe) => fe.el.remove());
      frameEls.clear();
      barsPref.clear();
      framePref.clear();
      legendHistory.clear();
      lastTop = null;
      const tree = callTree(r.steps);
      callOf = new Map();
      const walk = (n) =>
        n.children.forEach((c) => {
          callOf.set(c.id, c);
          walk(c);
        });
      walk(tree);
      sorts = new Set(
        (r.conds || []).flatMap((c) => {
          const on = c.ops.filter((o) => o.ix).map((o) => o.on);
          return on.filter((x, k) => on.indexOf(x) !== k);
        }),
      );
      effects = lineEffects(r.steps, r.pointers);
      calls.build(tree);
      callSum.textContent =
        tree.calls < 2
          ? ""
          : `${tree.calls} calls${tree.repeats ? ` · ${tree.repeats} redo an earlier call (dashed): a memo / cache would save the ${tree.saved} calls they make` : ""}`;
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

  // Pasting. Code pasted over all of the code (or into an empty editor) loses the indentation it brings along and switches the language;
  // test cases pasted over all of the input run. ⌘V / Ctrl+V anywhere else in the panel does the right one of these and runs.
  const whole = (box) => !box.value.trim() || (box.selectionStart === 0 && box.selectionEnd === box.value.length);
  const clipboard = (e) => e.clipboardData?.getData("text/plain") || "";
  function newCode(text) {
    langPick.value = detectLanguage(text);
    if (parseCases(input.value))
      casesChecked = false; // (kept if they're for the same function: see run())
    else {
      input.value = ""; // a call written for other code
      suggested = null;
    }
    picker.value = "";
    caseAt = 0;
  }
  function newCases(box, text) {
    box.focus();
    document.execCommand("insertText", false, text.trim()); // (keeps undo)
    caseAt = 0;
  }
  editor.addEventListener("paste", (e) => {
    const text = clipboard(e);
    if (!text.trim() || !whole(editor)) return;
    e.preventDefault();
    if (parseCases(text)) {
      // test cases, not code: they go to the input
      input.select();
      newCases(input, text);
      return run();
    }
    document.execCommand("insertText", false, clean(text));
    newCode(text);
  });
  input.addEventListener("paste", (e) => {
    const text = clipboard(e);
    if (!whole(input) || !parseCases(text)) return;
    e.preventDefault();
    newCases(input, text);
    run();
  });
  input.addEventListener("input", () => (caseAt = 0));
  document.addEventListener("paste", (e) => {
    if (!host.isConnected || (e.target instanceof Element && e.target.closest("textarea, input, select, [contenteditable]"))) return;
    const text = clipboard(e);
    if (!text.trim()) return;
    e.preventDefault();
    if (parseCases(text)) {
      input.value = text.trim();
      caseAt = 0;
    } else {
      editor.value = clean(text);
      newCode(text);
    }
    run();
  });

  document.addEventListener("keydown", onKey);
  host.style.setProperty("--vz-dur", "320ms");
  const groups = new Map();
  examples.forEach((ex, n) => {
    if (!groups.has(ex.group)) groups.set(ex.group, h("optgroup", { label: ex.group }));
    groups.get(ex.group).append(h("option", { value: String(n), textContent: ex.title }));
  });
  picker.append(h("option", { value: "", textContent: "Your code", hidden: true }), ...groups.values());
  picker.onchange = () => load(examples[+picker.value]);
  editor.addEventListener("input", () => {
    picker.value = ""; // edited: no longer the example
    if (result && editor.value !== tracedCode) clearRun(); // (the run was of other code)
    syncRows();
  });
  new ResizeObserver(() => fitEditor()).observe(codeWrap);
  show("data");
  return {
    take(src, driver = "", lang = src == null ? "python" : detectLanguage(src)) {
      if (src == null) return load(examples[0]);
      if (!driver && parseCases(src)) {
        // test cases selected on a problem's page: run on the code that's here
        input.value = src.trim();
        caseAt = 0;
        return run();
      }
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
