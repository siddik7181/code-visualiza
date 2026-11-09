// The data view's story: a trace turned into frames, one per line that ran (the steps the player stops at), each with one plain sentence
// made only from what the trace recorded (values, tests, reads and writes), never from what the code is for; the chapters the timeline is
// cut into (the passes of the outer loop); and for an error, the lookup that failed and the line that set it up. Pure functions: no DOM.
import { condValues, evaluate, fmt, isRef, lineEffects, objOf, swapOf, variables } from "./visualizer.js";

/** A sentence is a list of parts: plain text, {code} (a bit of the program), {val} (a value), {err} (an error's name). */
/** @typedef {(string | {code?: string, val?: string, err?: string})[]} Sentence */

const shown = (name) => name !== "self" && name !== "this";
const MAX = 40;
const clip = (t) => (t.length > MAX ? `${t.slice(0, MAX - 1)}…` : t);
const val = (v, heap) => ({ val: clip(fmt(v, heap)) });

/** The text of a lookup expression from the tracer (["+", ["n", "j"], ["c", 1]] is "j + 1"). */
export function exprText(e) {
  if (!e) return "?";
  if (e[0] === "n") return e[1];
  if (e[0] === "c") return JSON.stringify(e[1]);
  if (e[0] === "neg") return `-${exprText(e[1])}`;
  if (e[0] === "len") return `len(${e[1]})`;
  if (e[0] === "sub") return `${e[1]}[${exprText(e[2])}]`;
  return `${exprText(e[1])} ${e[0]} ${exprText(e[2])}`;
}
const namesIn = (e) =>
  !e ? [] : e[0] === "n" ? [e[1]] : e[0] === "c" ? [] : e.slice(1).flatMap((x) => (Array.isArray(x) ? namesIn(x) : []));

const intsOf = (frame, heap) => new Map(variables(frame, heap).filter(([, v]) => Number.isInteger(v)));
const top = (s) => s.stack[s.stack.length - 1];

/** The def (in the tracer's outline) a call to a function at `line` runs. */
function defAt(outline, line) {
  for (const n of outline || []) {
    if (n.t === "def" && n.l === line) return n;
    const d = defAt(n.c, line);
    if (d) return d;
  }
  return null;
}
/** The loop statement (for / while) starting at `line`, anywhere in the outline. */
function loopAt(outline, line) {
  for (const n of outline || []) {
    if ((n.t === "for" || n.t === "while") && n.l === line) return n;
    const d = loopAt(n.c, line);
    if (d) return d;
  }
  return null;
}

/** The structure a call's picture is about: the one its code indexes, writes and walks the most (from the tracer's reading of the code). */
export function heroOf(frame, heap, info) {
  const score = new Map();
  const add = (n, x) => score.set(n, (score.get(n) || 0) + x);
  for (const a of info?.acc || []) add(a.on, a.w ? 3 : 2);
  for (const [n, ps] of Object.entries(info?.idx || {})) add(n, ps.length);
  for (const n of Object.keys(info?.grid || {})) add(n, 4);
  for (const n of info?.swaps || []) add(n, 4);
  for (const n of info?.inplace || []) add(n, 1);
  const vars = variables(frame, heap).filter(([n, v]) => shown(n) && (typeof v === "string" ? v.length > 1 : objOf(v, heap)?.v));
  if (!vars.length) return null;
  const best = [...vars].sort((a, b) => (score.get(b[0]) || 0) - (score.get(a[0]) || 0))[0];
  return (score.get(best[0]) || 0) > 0 ? best[0] : vars.find(([, v]) => typeof v !== "string")?.[0] || vars[0][0];
}

// ---------------------------------------------------------------- what changed in a call between two steps
/** The changes to a call's variables: [{ name, kind, ... }], kind new / set (a number or text) / item (a list's item or a grid's cell) /
 * swap / push / pop / shift / key (a dict's key) / add / remove (a set's) / whole (a structure replaced or reshaped). */
export function changes(before, after, heapA, heapB) {
  const out = [];
  const A = new Map(before);
  for (const [name, v] of after) {
    if (!shown(name)) continue;
    if (!A.has(name)) {
      out.push({ name, kind: "new", to: v });
      continue;
    }
    const p = A.get(name);
    if (isRef(p) && isRef(v) && p.r === v.r) out.push(...inside(name, heapA[p.r], heapB[v.r], heapA, heapB));
    else if (fmt(p, heapA) !== fmt(v, heapB)) out.push({ name, kind: isRef(v) ? "whole" : "set", from: p, to: v });
  }
  return out;
}
function inside(name, a, b, ha, hb) {
  if (!a || !b) return [];
  const F = (x, h) => fmt(x, h);
  if (a.v && b.v && (a.t === "list" || a.t === "deque" || a.t === "tuple") && a.t === b.t) {
    const A = a.v.map((x) => F(x, ha)),
      B = b.v.map((x) => F(x, hb));
    if (B.length === A.length + 1 && A.every((x, i) => x === B[i])) return [{ name, kind: "push", to: b.v.at(-1) }];
    if (B.length === A.length - 1 && B.every((x, i) => x === A[i])) return [{ name, kind: "pop", to: a.v.at(-1) }];
    if (B.length === A.length - 1 && B.every((x, i) => x === A[i + 1])) return [{ name, kind: "shift", to: a.v[0] }];
    if (A.length !== B.length) return [{ name, kind: "whole", to: { r: -1 } }];
    const sw = swapOf(A, B);
    if (sw) return [{ name, kind: "swap", at: sw, vals: [b.v[sw[0]], b.v[sw[1]]] }];
    const out = [];
    a.v.forEach((x, i) => {
      const y = b.v[i];
      if (isRef(x) && isRef(y) && x.r === y.r && ha[x.r]?.v && hb[y.r]?.v) {
        // a row of a grid changed in place
        ha[x.r].v.forEach((c, j) => {
          if (F(c, ha) !== F(hb[y.r].v[j], hb))
            out.push({ name, kind: "item", at: `${i},${j}`, text: `${name}[${i}][${j}]`, from: c, to: hb[y.r].v[j] });
        });
      } else if (A[i] !== B[i]) out.push({ name, kind: "item", at: i, text: `${name}[${i}]`, from: x, to: y });
    });
    return out.length > 3 ? [{ name, kind: "whole", to: { r: -1 }, n: out.length }] : out;
  }
  if (a.t === "dict" && b.t === "dict") {
    const A = new Map(a.kv.map(([k, x]) => [F(k, ha), x]));
    const out = [];
    for (const [k, x] of b.kv) {
      const key = F(k, hb);
      if (!A.has(key)) out.push({ name, kind: "key", key, to: x, fresh: true });
      else if (F(A.get(key), ha) !== F(x, hb)) out.push({ name, kind: "key", key, from: A.get(key), to: x });
    }
    const keys = new Set(b.kv.map(([k]) => F(k, hb)));
    for (const k of A.keys()) if (!keys.has(k)) out.push({ name, kind: "delkey", key: k });
    return out;
  }
  if (a.t === "set" && b.t === "set") {
    const A = new Set(a.v.map((x) => F(x, ha))),
      B = new Set(b.v.map((x) => F(x, hb)));
    return [
      ...b.v.filter((x) => !A.has(F(x, hb))).map((x) => ({ name, kind: "add", to: x })),
      ...a.v.filter((x) => !B.has(F(x, ha))).map((x) => ({ name, kind: "remove", to: x })),
    ];
  }
  if (a.t === "obj" && b.t === "obj") {
    const old = new Map(a.a);
    return b.a
      .filter(([k, x]) => !old.has(k) || F(old.get(k), ha) !== F(x, hb))
      .map(([k, x]) => ({ name: `${name}.${k}`, kind: "set", from: old.get(k), to: x }));
  }
  return [];
}

// ---------------------------------------------------------------- sentences
function testSentence(c, cond, heap, nextLine, block) {
  const shownT = condValues(c, cond, heap) || c.t;
  const yes = cond.v;
  /** @type {Sentence} */
  const out = [{ code: shownT }, yes ? " is true" : " is false"];
  if (c.kind === "while" || c.kind === "for") out.push(yes ? ", so the loop body runs" : ", so the loop ends");
  else if (yes && nextLine) out.push(`, so line ${nextLine} runs`);
  else if (!yes && block)
    out.push(block.e > block.l + 1 ? `, so lines ${block.l + 1}–${block.e} are skipped` : `, so line ${block.e} is skipped`);
  return out;
}
/** The if / elif statement at `line` (its block runs from the next line to `e`). */
function testAt(outline, line) {
  for (const n of outline || []) {
    if ((n.t === "if" || n.t === "elif") && n.l === line) return n;
    const d = testAt(n.c, line);
    if (d) return d;
  }
  return null;
}

/** The sentence for one change, with where its value came from when the line read it (copied from nums[3]). */
function changeSentence(ch, heapB, reads) {
  const from = (to) => {
    const same = reads.filter((r) => r.val !== null && r.val === fmt(to, heapB));
    if (reads.length === 1 && same.length === 1) return [", copied from ", { code: reads[0].text }];
    if (reads.length && reads.length <= 3)
      return [", from ", ...reads.flatMap((r, k) => [k ? " and " : "", { code: r.text }, ` (${r.val})`])];
    return [];
  };
  switch (ch.kind) {
    case "new":
      return [{ code: ch.name }, " is ", val(ch.to, heapB), ...from(ch.to)];
    case "set":
      return [{ code: ch.name }, " goes from ", val(ch.from, heapB), " to ", val(ch.to, heapB), ...from(ch.to)];
    case "item":
      return [{ code: ch.text }, " changes from ", val(ch.from, heapB), " to ", val(ch.to, heapB), ...from(ch.to)];
    case "swap":
      return [
        { code: `${ch.name}[${ch.at[0]}]` },
        ` (${fmt(ch.vals[1], heapB)}) and `,
        { code: `${ch.name}[${ch.at[1]}]` },
        ` (${fmt(ch.vals[0], heapB)}) swap places`,
      ];
    case "push":
      return [val(ch.to, heapB), " is added to the end of ", { code: ch.name }];
    case "pop":
      return [val(ch.to, heapB), " is taken off the end of ", { code: ch.name }];
    case "shift":
      return [val(ch.to, heapB), " is taken off the front of ", { code: ch.name }];
    case "key":
      return ch.fresh
        ? [{ code: `${ch.name}[${ch.key}]` }, " is added, set to ", val(ch.to, heapB)]
        : [{ code: `${ch.name}[${ch.key}]` }, " changes from ", val(ch.from, heapB), " to ", val(ch.to, heapB)];
    case "delkey":
      return [{ code: `${ch.name}[${ch.key}]` }, " is removed"];
    case "add":
      return [val(ch.to, heapB), " is added to ", { code: ch.name }];
    case "remove":
      return [val(ch.to, heapB), " is removed from ", { code: ch.name }];
    default:
      return ch.n
        ? [{ code: ch.name }, ` has ${ch.n} items changed`]
        : [{ code: ch.name }, " is now ", val(ch.to.r === -1 ? undefined : ch.to, heapB)];
  }
}
const joinSentences = (list) => list.flatMap((s, k) => (k ? [". ", ...s] : s));

// ---------------------------------------------------------------- the story
/**
 * @param {any} result a trace from the worker
 * @param {string[]} code the program's lines
 * @returns {{ frames: any[], chapters: any[], entry: any, effects: any[], error: string | null }}
 */
export function buildStory(result, code) {
  const steps = result.steps || [];
  const effects = lineEffects(steps, result.pointers);
  const conds = result.conds || [];
  const frames = [];
  const lastLine = new Map(); // call id -> the step index where it last ran a line
  const lineText = (n) => (code[n - 1] || "").trim();
  const entry = steps[0] ? top(steps[0]) : null;
  const errorAt = result.error ? firstOfLastError(steps) : -1;

  steps.forEach((s, i) => {
    const t = top(s);
    if (!t) return;
    const p = steps[i - 1];
    if (s.ev === "call") {
      frames.push({ i, line: s.line, kind: "call", fn: t.fn, sentence: callSentence(s, i === 0) });
    } else if (s.ev === "exception") {
      if (i === errorAt) frames.push(errorFrame(s, i));
      else if (!result.error || i < errorAt)
        frames.push({ i, line: s.line, kind: "caught", sentence: [{ err: s.exc }, " is raised here"] });
    } else if (s.ev === "line" || s.ev === "return") {
      // the line that ran: in this call, the last one it started (after a call it made returns, that's the calling line)
      const k = lastLine.get(t.id);
      if (k !== undefined && (s.ev === "return" || p.ev !== "call")) {
        const f = lineFrame(steps[k], s, i, k);
        if (s.ev === "return") {
          const isReturn = /^return\b/.test(lineText(steps[k].line));
          const r = t.fn === "<module>" ? ["The program ends"] : [{ code: t.fn }, " returns ", val(s.ret, s.heap)];
          if (isReturn) f.sentence = r;
          else f.sentence = f.sentence.length ? [...f.sentence, ". Then ", ...r] : r;
          f.kind = "return";
        }
        if (i > errorAt && errorAt >= 0) return;
        frames.push(f);
      }
    }
    if (s.ev === "line") lastLine.set(t.id, i);
  });

  function callSentence(s, first) {
    const t = top(s);
    const params = (s.params || []).filter(shown);
    const args = params.map((n) => `${n} = ${clip(fmt(t.loc.find(([k]) => k === n)?.[1], s.heap))}`).join(", ");
    const caller = s.stack[s.stack.length - 2];
    if (t.fn === "<module>") return ["The program starts"];
    if (first || !caller) return [{ code: `${t.fn}(${args})` }, " starts"];
    return [`Line ${caller.line} calls `, { code: `${t.fn}(${args})` }];
  }

  function lineFrame(p, s, i, k) {
    const t = top(p);
    const after = s.stack.find((f) => f.id === t.id) || top(s);
    const text = lineText(p.line);
    const f = { i, line: p.line, kind: "line", fn: t.fn, sentence: /** @type {Sentence} */ ([]), from: k, effects: effects[i] };
    const sameCall = top(s).id === t.id;
    if (p.cond && conds[p.cond.k]) {
      f.kind = "test";
      const c = conds[p.cond.k];
      const block = testAt(result.outline, p.line);
      f.sentence = testSentence(c, p.cond, p.heap, sameCall && s.ev === "line" ? s.line : null, block && block.e > block.l ? block : null);
      if (c.kind === "while" || c.kind === "for") {
        if (p.cond.v)
          f.loopPass = variables(t, p.heap)
            .filter(([n, v]) => shown(n) && !isRef(v) && new RegExp(`\\b${n}\\b`).test(c.t))
            .map(([n, v]) => `${n} = ${clip(fmt(v, p.heap))}`)
            .join(", ");
        else f.loopEnds = true;
      }
      return f;
    }
    const chs = changes(variables(t, p.heap), variables(after, s.heap), p.heap, s.heap);
    const e = effects[i];
    const reads = (e?.list || []).filter((x) => !x.w);
    const writes = (e?.list || []).filter((x) => x.w);
    const forM = text.match(/^for\s+(.+?)\s+in\s+(.+):\s*$/) || text.match(/^for\s*\(\s*(?:const|let|var)\s+(\w+)\s+of\s+(.+)\)\s*\{?\s*$/);
    if (forM) {
      const loop = loopAt(result.outline, p.line);
      const vars = chs.filter((c) => c.kind === "new" || c.kind === "set");
      if (!vars.length && loop && sameCall && (s.line < loop.l || s.line > loop.e)) {
        f.sentence = [{ code: forM[2] }, " has nothing left, so the loop ends"];
        f.loopEnds = true;
        return f;
      }
      if (vars.length) {
        const prevLine = lastBefore(k, t.id);
        const first = !loop || prevLine === null || prevLine < loop.l || prevLine > loop.e;
        const v = vars.map((c) => [{ code: c.name }, " = ", val(c.to, s.heap)]);
        f.sentence = [...joinSentences(v), first ? `, the first value from ` : `, the next value from `, { code: forM[2] }];
        f.loopPass = vars.map((c) => `${c.name} = ${clip(fmt(c.to, s.heap))}`).join(", ");
        return f;
      }
    }
    const said = chs.map((c) => {
      const mine = c.kind === "item" ? reads.filter((r) => r.text !== c.text) : reads;
      return changeSentence(c, s.heap, mine);
    });
    // a write that changed nothing (it put back the value that was there)
    for (const w of writes) {
      if (chs.some((c) => c.kind === "item" && (c.text === w.text || c.at === w.at))) continue;
      if (chs.some((c) => c.kind === "swap" && c.name === w.on)) continue;
      if (chs.some((c) => c.kind === "key" && c.name === w.on && (c.key === String(w.at) || `${w.on}[${c.key}]` === w.text))) continue;
      const src = reads.filter((r) => r.text !== w.text || r.on !== w.on);
      const self = reads.some((r) => r.text === w.text);
      const now = w.val;
      said.push(
        self && !src.length
          ? [{ code: w.text }, " is copied onto itself, so nothing changes"]
          : [{ code: w.text }, ` is set to `, { val: now ?? "?" }, ", which it already was"],
      );
    }
    if (said.length)
      f.sentence = said.length > 3 ? [...joinSentences(said.slice(0, 3)), `. And ${said.length - 3} more changes`] : joinSentences(said);
    else if (/^break\b/.test(text)) f.sentence = [{ code: "break" }, " leaves the loop"];
    else if (/^continue\b/.test(text)) f.sentence = [{ code: "continue" }, " goes back to the top of the loop"];
    else if ((s.out || "").length > (p.out || "").length)
      f.sentence = ["Prints ", { val: clip((s.out || "").slice((p.out || "").length).trim()) }];
    else f.sentence = [`Line ${p.line} runs; nothing changes`];
    return f;
  }

  function lastBefore(k, id) {
    for (let j = k - 1; j >= 0; j--) {
      const t = top(steps[j]);
      if (t?.id === id && steps[j].ev === "line") return steps[j].line;
      if (steps[j].ev === "call" && t?.id === id) return null;
    }
    return null;
  }

  // the error: what it was, the lookup that failed and the line that set it up
  function errorFrame(s, i) {
    const t = top(s);
    const [name, ...rest] = (s.exc || "Error").split(": ");
    const f = {
      i,
      line: s.line,
      kind: "error",
      fn: t.fn,
      sentence: [{ err: name }, rest.length ? `: ${rest.join(": ")}` : ""],
      detail: null,
      cause: null,
      bad: null,
    };
    const info = result.pointers?.[t.fn];
    const ints = intsOf(t, s.heap);
    const byName = new Map(variables(t, s.heap));
    for (const a of (info?.acc || []).filter((x) => x.line === s.line && x.ix)) {
      const v = byName.get(a.on);
      const o = objOf(v, s.heap);
      const n = typeof v === "string" ? v.length : o?.v ? o.v.length : null;
      const x = evaluate(a.ix, ints, t, s.heap);
      if (x === null) continue;
      if (n !== null && o?.t !== "dict" && (x >= n || x < -n)) {
        const ix = exprText(a.ix);
        f.bad = { on: a.on, at: x, text: ix };
        f.detail = [
          { code: `${a.on}[${ix}]` },
          ix === String(x) ? "" : " is ",
          ix === String(x) ? "" : { code: `${a.on}[${x}]` },
          ", but ",
          { code: a.on },
          n ? ` only goes up to index ${n - 1}` : " is empty",
        ];
        f.cause = causeOf(namesIn(a.ix), t.id, i);
        break;
      }
      if (o?.t === "dict" && name === "KeyError") {
        const key = String(x);
        f.bad = { on: a.on, key, text: exprText(a.ix) };
        f.detail = [{ code: `${a.on}[${exprText(a.ix)}]` }, " looks up key ", { val: key }, `, which ${a.on} doesn't have`];
        f.cause = causeOf(namesIn(a.ix), t.id, i);
        break;
      }
    }
    return f;
  }
  // the latest line (in this call) that set one of `names`, before step `i`
  function causeOf(names, id, i) {
    for (let k = frames.length - 1; k >= 0; k--) {
      const f = frames[k];
      if (f.i >= i || !steps[f.i] || top(steps[f.i])?.id !== id || f.kind === "test") continue;
      const p = steps[f.from ?? f.i - 1];
      if (!p) continue;
      const before = new Map(variables(p.stack.find((x) => x.id === id) || top(p), p.heap));
      const now = variables(steps[f.i].stack.find((x) => x.id === id) || top(steps[f.i]), steps[f.i].heap);
      const set = now.find(([n, v]) => names.includes(n) && fmt(v, steps[f.i].heap) !== fmt(before.get(n), p.heap));
      if (set) return { line: f.line, name: set[0], value: fmt(set[1], steps[f.i].heap), frame: k };
    }
    return null;
  }

  if (errorAt >= 0 && !frames.some((f) => f.kind === "error")) {
    const s = steps[errorAt];
    frames.push(errorFrame(s, errorAt));
  }
  const err = frames.find((f) => f.kind === "error");
  if (err?.cause)
    err.detail2 = [{ code: err.cause.name }, ` became ${err.cause.value} on line ${err.cause.line}: `, { code: lineText(err.cause.line) }];
  if (result.error && !err) frames.push({ i: steps.length - 1, line: null, kind: "error", sentence: [{ err: result.error }] });
  if (result.truncated)
    frames.push({ i: steps.length - 1, line: null, kind: "end", sentence: ["The run was cut short here (it took too many steps)"] });

  return { frames, chapters: chaptersOf(frames, steps, result, entry), entry, effects, error: result.error || null };
}

// where the error being reported started: the first exception event of the trailing run of exception / return events
function firstOfLastError(steps) {
  let k = steps.length - 1;
  while (k > 0 && (steps[k - 1].ev === "exception" || steps[k - 1].ev === "return") && steps[k].ev !== "line") k--;
  while (k < steps.length && steps[k].ev !== "exception") k++;
  return k < steps.length ? k : -1;
}

/** Chapters: each pass of the entry call's outermost loops (a while's test coming out true, a for taking its next value); with no loop,
 * each call the entry call makes. [{ at (first frame), label, hint }] */
export function chaptersOf(frames, steps, result, entry) {
  if (!frames.length) return [];
  const body = entry?.fn === "<module>" ? result.outline : entry ? defAt(result.outline, top(steps[0]).line)?.c : null;
  const loops = (body || []).filter((n) => n.t === "for" || n.t === "while");
  const starts = [];
  let pass = 0;
  frames.forEach((f, k) => {
    const s = steps[f.i];
    const t = s && top(s);
    if (!t || t.id !== entry?.id) return;
    const loop = loops.find((l) => l.l === f.line);
    if (!loop) return;
    if (f.loopPass === undefined) return;
    pass++;
    const hint = f.loopPass;
    starts.push({ at: k, label: `Pass ${pass}`, hint });
  });
  // the calls the run makes one after another (a design problem's operations) when there's no loop, else the calls the first one makes;
  // a recursive call's own calls come first (merge sort: the left half, the right half, then its loop merges them)
  const depth = steps[0].stack.length;
  const recursive = !!entry && steps.some((s) => s.stack.filter((g) => g.fn === entry.fn).length > 1);
  if (!starts.length || recursive) {
    const at = (d) => frames.flatMap((f, k) => (f.kind === "call" && steps[f.i].stack.length === d ? [k] : []));
    const level = !recursive && at(depth).length > 1 ? at(depth) : at(depth + 1);
    const calls = level.filter((k) => !recursive || top(steps[frames[k].i]).fn === entry.fn);
    if (calls.length > (recursive ? 0 : 1)) {
      const passes = starts.splice(0);
      calls.forEach((k) => {
        const s = steps[frames[k].i],
          t = top(s);
        const args = (s.params || []).filter(shown).map((n) => clip(fmt(t.loc.find(([x]) => x === n)?.[1], s.heap)));
        starts.push({ at: k, label: `Call ${starts.length + 1}`, hint: `${t.fn}(${args.join(", ")})` });
      });
      starts.push(...passes.filter((p) => p.at > starts.at(-1).at).map((p, j) => ({ ...p, label: `Pass ${j + 1}` })));
    }
  }
  const out = [];
  if (!starts.length || starts[0].at > 0) out.push({ at: 0, label: "Start", hint: "" });
  out.push(...starts);
  const err = frames.findIndex((f) => f.kind === "error");
  // after the loops: the rest of the call (what it returns)
  const lastStart = out.at(-1).at;
  const loopEnd = frames.findIndex(
    (f, k) => k > lastStart && f.loopEnds && loops.some((l) => l.l === f.line) && top(steps[f.i])?.id === entry?.id,
  );
  if (loopEnd > lastStart && loopEnd < frames.length - 1 && (err < 0 || loopEnd < err))
    out.push({ at: loopEnd + 1, label: "End", hint: "" });
  if (err >= 0) {
    if (out.at(-1).at === err) out.at(-1).error = true;
    else out.push({ at: err, label: "Error", hint: "", error: true });
  }
  return out.map((c, j) => ({ ...c, end: j + 1 < out.length ? out[j + 1].at : frames.length }));
}
