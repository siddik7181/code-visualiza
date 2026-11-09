// Runs JavaScript code and records every step (line, call, return), the way tracer.py does for Python, in the same format, so the panel
// draws both the same way. Nothing is guessed: each step is the real state of the program.
//
// Extension pages may not eval, so the code runs in Sval, a JavaScript interpreter written in JavaScript (vendor/sval). Before it runs,
// the code is rewritten to report its steps: __S(line, vars) before each statement and inside each if/while/for test, __E / __R / __L
// around each function body (call, return, leave) and __X when an exception leaves one. `vars` is a function returning the variables in
// scope at that point, each read in its own try (a `let` read before its line throws). Insertions never add a line break, so line
// numbers stay the code's own.
//
// Also, like tracer.py: which variables index which lists (analyse), the statement tree (outline), and a call for code that only defines
// functions (suggest). Not traced (they run, but show no steps): generator and async functions, and one-line arrow callbacks passed to a
// call (sort comparators, map/filter), like builtins.
import Sval from "./vendor/sval/sval.mjs";

const MAX_STEPS = 1500; // a trace longer than this stops early (also stops endless loops)
const MAX_ITEMS = 64; // items shown per array/map/set
const MAX_OBJECTS = 150; // objects shown per step
const STR_MAX = 80;
const LINKS = ["next", "prev", "random", "left", "right", "neighbors", "children", "parent"];

// ---------------------------------------------------------------- helpers the code may use without defining them (as in tracer.py)
class ListNode {
  constructor(val = 0, next = null) {
    this.val = val;
    this.next = next;
  }
}
class TreeNode {
  constructor(val = 0, left = null, right = null) {
    this.val = val;
    this.left = left;
    this.right = right;
  }
}
class Node {
  constructor(val = 0, neighbors = []) {
    this.val = val;
    this.neighbors = neighbors;
  }
}
/** linked([1, 2, 3]) -> 1 -> 2 -> 3 */
const linked = (values) => values.reduceRight((next, v) => new ListNode(v, next), null);
/** tree([3, 9, 20, null, null, 15, 7]): a binary tree from level order (null = no child) */
function tree(values) {
  if (!values.length || values[0] == null) return null;
  const root = new TreeNode(values[0]);
  const queue = [root];
  let i = 1;
  while (queue.length && i < values.length) {
    const node = queue.shift();
    for (const side of ["left", "right"]) {
      if (i < values.length && values[i] != null) queue.push((node[side] = new TreeNode(values[i])));
      i++;
    }
  }
  return root;
}
/** graph({1: [2, 4], 2: [1, 3], ...}) -> the Node of the first key, with .neighbors linked */
function graph(adj) {
  const nodes = new Map();
  const node = (k) => (nodes.has(String(k)) ? nodes.get(String(k)) : nodes.set(String(k), new Node(Number(k))).get(String(k)));
  for (const [k, vs] of Object.entries(adj)) node(k).neighbors = vs.map(node);
  return nodes.size ? nodes.values().next().value : null;
}
const HELPERS = { ListNode, TreeNode, Node, linked, tree, graph };

// ---------------------------------------------------------------- the syntax tree
const isNode = (x) => !!x && typeof x === "object" && typeof x.type === "string";
const FUNCTIONS = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
const parse = (code) => new Sval({ ecmaVer: "latest", sandBox: true }).parse(code);
/** The child nodes, in source order. */
function kids(n) {
  const out = [];
  for (const k in n) {
    const v = n[k];
    if (Array.isArray(v)) out.push(...v.filter(isNode));
    else if (isNode(v) && k !== "type") out.push(v);
  }
  return out.sort((a, b) => a.start - b.start);
}
/** Calls visit(node, parent) on every node; visit returns false to skip a node's children. */
function walk(n, visit, parent = null) {
  if (visit(n, parent) === false) return;
  for (const c of kids(n)) walk(c, visit, n);
}
/** pos -> line number (1-based) */
function lineIndex(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") starts.push(i + 1);
  return (pos) => {
    let lo = 0,
      hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}
/** The names a binding pattern declares: a, [a, b], {a, b: c}, ...rest, a = 1 */
function bound(p) {
  if (!p) return [];
  if (p.type === "Identifier") return [p.name];
  if (p.type === "ArrayPattern") return p.elements.flatMap(bound);
  if (p.type === "ObjectPattern") return p.properties.flatMap((q) => bound(q.type === "RestElement" ? q.argument : q.value));
  if (p.type === "AssignmentPattern") return bound(p.left);
  if (p.type === "RestElement") return bound(p.argument);
  return [];
}
/** let / const / class / function names declared directly in a statement list (a block's own names) */
function declaredIn(stmts) {
  const out = new Set();
  for (const s of stmts) {
    if (s.type === "VariableDeclaration" && s.kind !== "var") s.declarations.forEach((d) => bound(d.id).forEach((x) => out.add(x)));
    if ((s.type === "ClassDeclaration" || s.type === "FunctionDeclaration") && s.id) out.add(s.id.name);
  }
  return out;
}
/** `var` names in a function (or the program), outside nested functions: they belong to the whole function */
function varsOf(body) {
  const out = new Set();
  walk(body, (n) => {
    if (n !== body && FUNCTIONS.has(n.type)) return false;
    if (n.type === "VariableDeclaration" && n.kind === "var") n.declarations.forEach((d) => bound(d.id).forEach((x) => out.add(x)));
  });
  return out;
}
/** Names a function reads or writes (to find a closure's outer variables) */
function referenced(fn) {
  const out = new Set();
  walk(fn, (n, p) => {
    if (n.type !== "Identifier" || !p) return;
    if (p.type === "MemberExpression" && p.property === n && !p.computed) return;
    if ((p.type === "Property" || p.type === "MethodDefinition" || p.type === "PropertyDefinition") && p.key === n && !p.computed) return;
    out.add(n.name);
  });
  return out;
}
const usesThis = (body) => {
  let found = false;
  walk(body, (n) => {
    if (n.type === "ThisExpression") found = true;
    return !(n !== body && (n.type === "FunctionDeclaration" || n.type === "FunctionExpression"));
  });
  return found;
};
/** A function's name: its own, or the name it's assigned to (const f = () => ..., X.prototype.push = function ..., a method's key) */
function nameOf(fn, parent) {
  if (fn.id) return fn.id.name;
  if (parent?.type === "VariableDeclarator" && parent.id.type === "Identifier") return parent.id.name;
  if (parent?.type === "AssignmentExpression") {
    const l = parent.left;
    if (l.type === "Identifier") return l.name;
    if (l.type === "MemberExpression" && !l.computed) return l.property.name;
  }
  if (["Property", "MethodDefinition", "PropertyDefinition"].includes(parent?.type) && !parent.computed && parent.key.name)
    return parent.key.name;
  return "(anonymous)";
}
const isFunctionValue = (n) => !!n && (FUNCTIONS.has(n.type) || n.type === "ClassExpression");
/** A top-level statement that only defines things (function, class, const f = () => ..., X.prototype.m = function ...): not a step */
const definition = (s) =>
  s.type === "FunctionDeclaration" ||
  s.type === "ClassDeclaration" ||
  s.type === "ImportDeclaration" ||
  (s.type === "VariableDeclaration" && s.declarations.every((d) => isFunctionValue(d.init))) ||
  (s.type === "ExpressionStatement" &&
    (s.directive || (s.expression.type === "AssignmentExpression" && isFunctionValue(s.expression.right))));
/** A one-line arrow passed to a call (a comparator, a map/filter callback): run like a builtin, not traced */
const oneLineCallback = (fn, parent) =>
  fn.type === "ArrowFunctionExpression" &&
  fn.expression &&
  ["CallExpression", "NewExpression"].includes(parent?.type) &&
  parent.arguments.includes(fn);

// ---------------------------------------------------------------- rewriting the code to report its steps
function instrument(src, ast, script, conds = []) {
  const lineOf = lineIndex(src);
  const edits = []; // [pos, 0 = closing | 1 = opening, order at the same place, text]
  const open = (pos, depth, text) => edits.push([pos, 1, depth, text]);
  const close = (pos, depth, text) => edits.push([pos, 0, -depth, text]);
  // the variables in scope, as the function the runtime reads them with: () => [["a", () => a], ...]
  const vars = (ctx) => {
    const all = new Set([...ctx.fn.own, ...ctx.blocks.flatMap((b) => [...b]), ...ctx.fn.free]);
    const parts = [...all].filter((n) => !n.startsWith("__")).map((n) => `[${JSON.stringify(n)}, () => ${n}]`);
    if (ctx.fn.usesThis) parts.push('["this", () => this]');
    return `() => [${parts.join(", ")}]`;
  };
  const step = (ctx, pos) => `__S(${lineOf(pos)}, ${vars(ctx)});`;
  const withBlock = (ctx, names) => ({ ...ctx, blocks: [...ctx.blocks, names] });
  const allNames = (ctx) => new Set([...ctx.fn.own, ...ctx.blocks.flatMap((b) => [...b]), ...ctx.fn.free]);
  const traced = (ctx) => !!ctx.fn;
  const STEPPED = new Set([
    "ExpressionStatement",
    "VariableDeclaration",
    "ReturnStatement",
    "ThrowStatement",
    "BreakStatement",
    "ContinueStatement",
  ]);

  function list(stmts, ctx, depth) {
    for (const s of stmts) statement(s, ctx, depth);
  }
  function statement(s, ctx, depth) {
    if (traced(ctx) && STEPPED.has(s.type) && !(ctx.top && definition(s))) open(s.start, depth, step(ctx, s.start));
    node(s, null, ctx, depth);
  }
  // a loop's or an if's body: a single statement becomes a block, so it gets its own step (`if (x) return y` shows the return)
  function body(b, ctx, depth, headerStep = "") {
    if (b.type === "BlockStatement") {
      if (headerStep) open(b.start + 1, depth + 1, headerStep);
      return node(b, null, ctx, depth);
    }
    if (traced(ctx)) open(b.start, depth, `{ ${headerStep}`);
    statement(b, ctx, depth + 1);
    if (traced(ctx)) close(b.end, depth, " }");
  }
  // if / while / do-while / for / switch: a step before each test, inside it: (__S(...), test). An if's / a loop's test also reports what
  // it compared (__O for each operand, __T for the outcome), for the table `conds` (the format tracer.py writes).
  function test(t, ctx, depth, line, kind = "") {
    if (traced(ctx) && kind && t.type !== "SequenceExpression") {
      const ops = operands(t);
      const cid = conds.length;
      conds.push({
        line,
        kind,
        t: src.slice(t.start, t.end),
        ops: ops.map((o) => ({ a: o.start - t.start, b: o.end - t.start, ...operandInfo(o) })),
      });
      open(t.start, depth, `(__S(${line}, ${vars(ctx)}, ${cid}), __T(${cid}, `);
      close(t.end, depth, "))");
      ops.forEach((o, i) => {
        open(o.start, depth + 0.5, `__O(${cid}, ${i}, `);
        close(o.end, depth + 0.5, ")");
      });
    } else if (traced(ctx)) {
      open(t.start, depth, `(__S(${line}, ${vars(ctx)}), `);
      close(t.end, depth, ")");
    }
    node(t, null, ctx, depth + 1);
  }

  function fn(f, parent, ctx, depth) {
    const name = nameOf(f, parent);
    const params = f.params.flatMap(bound);
    const blockNames = f.body.type === "BlockStatement" ? declaredIn(f.body.body) : new Set();
    const own = new Set([...params, ...varsOf(f.body)]);
    // a closure's outer variables it uses are shown with its own (as Python shows them); the global ones are in the global frame
    const outer = ctx.fn && !ctx.fn.module ? allNames(ctx) : new Set();
    const free = [...referenced(f)].filter((x) => outer.has(x) && !own.has(x) && !blockNames.has(x));
    const isTraced = !f.generator && !f.async && !oneLineCallback(f, parent);
    const fctx = {
      fn: isTraced ? { own, free, usesThis: f.type !== "ArrowFunctionExpression" && usesThis(f.body), module: false } : null,
      blocks: [blockNames],
      top: false,
    };
    const enter = `const __F = __E(${JSON.stringify(name)}, ${lineOf(f.start)}, ${JSON.stringify(params)}, ${isTraced ? vars(fctx) : "null"}); try {`;
    const leave = "} catch (__e) { __X(__F, __e); throw __e; } finally { __L(__F); }";
    for (const p of f.params) node(p, f, ctx, depth + 1); // (default values)
    if (f.body.type === "BlockStatement") {
      if (isTraced) open(f.body.start + 1, depth + 1, enter);
      list(f.body.body, fctx, depth + 2);
      if (isTraced) close(f.body.end - 1, depth + 1, `__R(__F, ${lineOf(f.body.end - 1)}, undefined); ${leave}`);
    } else {
      // an expression body (x => x * 2): it becomes a block returning it. It starts right after "=>" (before a "(" around it).
      let at = f.body.start;
      while (at > f.start && src.slice(at - 2, at) !== "=>") at--;
      if (isTraced) open(at, depth + 1, ` { ${enter} return __R(__F, ${lineOf(f.body.start)}, (`);
      node(f.body, f, fctx, depth + 2);
      if (isTraced) close(f.end, depth + 1, `)); ${leave} }`);
    }
  }

  function node(n, parent, ctx, depth) {
    if (FUNCTIONS.has(n.type)) return fn(n, parent, ctx, depth);
    const t = traced(ctx);
    switch (n.type) {
      case "BlockStatement":
        return list(n.body, withBlock(ctx, declaredIn(n.body)), depth + 1);
      case "IfStatement":
        test(n.test, ctx, depth + 1, lineOf(n.start), parent?.type === "IfStatement" && parent.alternate === n ? "elif" : "if");
        body(n.consequent, ctx, depth + 1);
        if (n.alternate) n.alternate.type === "IfStatement" ? node(n.alternate, n, ctx, depth + 1) : body(n.alternate, ctx, depth + 1);
        return;
      case "WhileStatement":
        test(n.test, ctx, depth + 1, lineOf(n.start), "while");
        return body(n.body, ctx, depth + 1);
      case "DoWhileStatement":
        body(n.body, ctx, depth + 1);
        return test(n.test, ctx, depth + 1, lineOf(n.test.start), "while");
      case "ForStatement": {
        const head = n.init?.type === "VariableDeclaration" && n.init.kind !== "var" ? withBlock(ctx, declaredIn([n.init])) : ctx;
        if (n.init) node(n.init, n, head, depth + 1);
        if (n.test) test(n.test, head, depth + 1, lineOf(n.start), "for");
        else if (t) {
          const semi = src.indexOf(";", n.init ? n.init.end : src.indexOf("(", n.start) + 1);
          open(semi + 1, depth + 1, ` __S(${lineOf(n.start)}, ${vars(head)}), true`);
        }
        if (n.update) node(n.update, n, head, depth + 1);
        return body(n.body, head, depth + 1);
      }
      case "ForOfStatement": {
        // a step before each item is taken, and once more when there are none left (as Python's for line): __I wraps the iterable
        if (t) open(n.right.start, depth + 1, `__I(${lineOf(n.start)}, ${vars(ctx)}, `);
        node(n.right, n, ctx, depth + 2);
        if (t) close(n.right.end, depth + 1, ")");
        const inner = n.left.type === "VariableDeclaration" ? withBlock(ctx, declaredIn([n.left])) : ctx;
        return body(n.body, inner, depth + 1);
      }
      case "ForInStatement": {
        node(n.right, n, ctx, depth + 1);
        const inner = n.left.type === "VariableDeclaration" ? withBlock(ctx, declaredIn([n.left])) : ctx;
        return body(n.body, inner, depth + 1, t ? step(inner, n.start) : "");
      }
      case "SwitchStatement": {
        test(n.discriminant, ctx, depth + 1, lineOf(n.start));
        const inner = withBlock(ctx, declaredIn(n.cases.flatMap((c) => c.consequent)));
        for (const c of n.cases) {
          if (c.test) node(c.test, c, inner, depth + 1);
          list(c.consequent, inner, depth + 2);
        }
        return;
      }
      case "TryStatement":
        node(n.block, n, ctx, depth + 1);
        if (n.handler) node(n.handler.body, n.handler, withBlock(ctx, new Set(bound(n.handler.param))), depth + 1);
        if (n.finalizer) node(n.finalizer, n, ctx, depth + 1);
        return;
      case "LabeledStatement":
        return statement(n.body, ctx, depth + 1);
      case "ReturnStatement":
        if (t && !ctx.fn.module) {
          if (n.argument) {
            open(n.argument.start, depth + 1, `__R(__F, ${lineOf(n.start)}, (`);
            node(n.argument, n, ctx, depth + 2);
            close(n.argument.end, depth + 1, "))");
          } else open(n.start + "return".length, depth + 1, ` __R(__F, ${lineOf(n.start)}, undefined)`);
          return;
        }
        break;
    }
    for (const c of kids(n)) node(c, n, ctx, depth + 1);
  }

  // the program: in a script, its top level is the global frame (as Python's <module>), and its steps are traced too
  const top = {
    own: new Set([...varsOf(ast), ...ast.body.filter((s) => s.type === "FunctionDeclaration").map((s) => s.id.name)]),
    free: [],
    usesThis: false,
    module: true,
  };
  const pctx = { fn: script ? top : null, blocks: [declaredIn(ast.body)], top: true };
  if (script) open(0, 0, `__E("<module>", 1, [], ${vars(pctx)});`);
  list(ast.body, pctx, 1);
  let out = "",
    last = 0;
  edits.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  for (const [pos, , , text] of edits) {
    out += src.slice(last, pos) + text;
    last = pos;
  }
  out += src.slice(last);
  return script ? `${out}\n;__R(-1, ${lineOf(src.length)}, undefined);` : out;
}

// ---------------------------------------------------------------- encoding the program state (the format tracer.py writes)
class Encoder {
  constructor() {
    this.ids = new Map(); // object -> small stable number
  }
  value(v, heap, depth = 0) {
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "number") return Number.isFinite(v) && Math.abs(v) < 2 ** 53 ? v : { x: String(v) };
    if (typeof v === "string") return v.length <= STR_MAX ? v : `${v.slice(0, STR_MAX)}…`;
    if (v === undefined) return { x: "undefined" };
    if (typeof v === "bigint") return { x: `${v}n` };
    if (typeof v === "symbol") return { x: String(v) };
    if (typeof v === "function") return { x: `${v.name || "function"}()` };
    if (!this.ids.has(v)) this.ids.set(v, this.ids.size + 1);
    const r = this.ids.get(v);
    if (!(r in heap) && Object.keys(heap).length < MAX_OBJECTS && depth < 12) {
      heap[r] = null; // reserve first: handles cycles
      heap[r] = this.obj(v, heap, depth + 1);
    }
    return { r };
  }
  obj(v, heap, depth) {
    const enc = (x) => this.value(x, heap, depth);
    if (Array.isArray(v) || ArrayBuffer.isView(v)) {
      const items = Array.from(/** @type {ArrayLike<unknown>} */ (v));
      return { t: "list", v: items.slice(0, MAX_ITEMS).map(enc), n: items.length };
    }
    if (v instanceof Set) return { t: "set", v: [...v].slice(0, MAX_ITEMS).map(enc), n: v.size };
    if (v instanceof Map) return { t: "dict", cls: "Map", kv: [...v].slice(0, MAX_ITEMS).map(([k, x]) => [enc(k), enc(x)]), n: v.size };
    if (v instanceof Error || v instanceof Date || v instanceof RegExp || v instanceof Promise)
      return { t: "other", cls: v.constructor.name, repr: String(v).slice(0, STR_MAX) };
    const proto = Object.getPrototypeOf(v);
    const plain = proto === Object.prototype || proto === null;
    const keys = Object.keys(v).filter((k) => typeof v[k] !== "function");
    // a plain object is a map (seen[x] = i) unless it links to others ({val, next}: a node)
    if (plain && !keys.some((k) => LINKS.includes(k)))
      return { t: "dict", cls: "", kv: keys.slice(0, MAX_ITEMS).map((k) => [k, enc(v[k])]), n: keys.length };
    return { t: "obj", cls: plain ? "Object" : proto.constructor?.name || "Object", a: keys.map((k) => [k, enc(v[k])]) };
  }
}

// console.log's text, as Node prints it (strings bare at the top, quoted inside)
function show(v, depth = 0, seen = new Set()) {
  if (typeof v === "string") return depth ? `'${v}'` : v;
  if (typeof v === "bigint") return `${v}n`;
  if (v === null || (typeof v !== "object" && typeof v !== "function")) return String(v);
  if (typeof v === "function") return `[Function: ${v.name || "anonymous"}]`;
  if (seen.has(v)) return "[Circular]";
  if (depth > 3) return Array.isArray(v) ? "[Array]" : "[Object]";
  seen.add(v);
  const inner = (x) => show(x, depth + 1, seen);
  let text;
  if (Array.isArray(v)) text = `[${v.map(inner).join(", ")}]`;
  else if (v instanceof Map) text = `Map(${v.size}) {${[...v].map(([k, x]) => `${inner(k)} => ${inner(x)}`).join(", ")}}`;
  else if (v instanceof Set) text = `Set(${v.size}) {${[...v].map(inner).join(", ")}}`;
  else if (v instanceof Error) text = `${v.name}: ${v.message}`;
  else {
    const name = Object.getPrototypeOf(v)?.constructor?.name;
    text = `${name && name !== "Object" ? `${name} ` : ""}{${Object.keys(v)
      .map((k) => `${k}: ${inner(v[k])}`)
      .join(", ")}}`;
  }
  seen.delete(v);
  return text;
}

class StopRun extends Error {} // the step limit

const syntaxError = (e) => {
  const m = /\((\d+):\d+\)$/.exec(e.message);
  return `SyntaxError (line ${m ? m[1] : "?"}): ${e.message.replace(/\s*\(\d+:\d+\)$/, "")}`;
};

// ---------------------------------------------------------------- tracing
/** Runs `code`, then `driver` (the calls to make), and records each step inside the code's own functions. With `script`, the code's top
 * level is recorded too (it runs by itself), except the statements that only define things. */
export function trace(code, driver = "", script = false) {
  const steps = [];
  const result = { steps, error: null, truncated: false, result: null, out: "", conds: [] };
  let ast, input;
  try {
    ast = parse(code);
  } catch (e) {
    result.error = `The code doesn't run: ${syntaxError(e)}`;
    return result;
  }
  try {
    input = parse(driver);
  } catch (e) {
    result.error = `The input isn't valid JavaScript: ${syntaxError(e)}`;
    return result;
  }
  // the input's last line is an expression: its value is the result
  let run = driver;
  const last = input.body.at(-1);
  if (last?.type === "ExpressionStatement")
    run = `${driver.slice(0, last.expression.start)}__RESULT((${driver.slice(last.expression.start, last.expression.end)}))${driver.slice(last.expression.end)}`;
  const source = `__GLOBAL(globalThis);${instrument(code, ast, script, result.conds)}\n;\n${run}`;

  const enc = new Encoder();
  const stack = []; // { fn, id, line, vars } for each call being run
  let ids = 0,
    out = "",
    shownOut = 0,
    sandboxGlobal = null,
    value,
    hasValue = false;
  const locals = (f, heap) => {
    const loc = [];
    for (const [name, read] of f.vars ? f.vars() : []) {
      let v;
      try {
        v = read();
      } catch {
        continue; // not set yet (a let before its line)
      }
      if (typeof v === "function" || (name === "this" && (v == null || v === sandboxGlobal))) continue;
      loc.push([name, enc.value(v, heap)]);
    }
    return loc;
  };
  const snap = (ev, line, extra = (_heap) => ({})) => {
    if (steps.length >= MAX_STEPS) {
      result.truncated = true;
      throw new StopRun();
    }
    const heap = {};
    const frames = stack.map((f) => ({ fn: f.fn, id: f.id, line: f.line, loc: locals(f, heap) }));
    /** @type {Record<string, unknown>} */
    const s = { ev, line, stack: frames, heap, ...extra(heap) };
    if (out.length !== shownOut) {
      s.out = out.slice(-2000);
      shownOut = out.length;
    }
    steps.push(s);
  };
  const frame = (id) => (id === -1 ? stack.at(-1) : stack.find((f) => f.id === id));
  const S = (line, vars, cid) => {
    const f = stack.at(-1);
    f.line = line;
    f.vars = vars;
    snap("line", line);
    if (cid !== undefined) {
      f.pending = /** @type {{cond: {k: number, o: unknown[][], v: boolean | null}, heap: object}} */ (steps.at(-1));
      f.pending.cond = { k: cid, o: [], v: null };
    }
  };
  // the if / loop test being worked out in the running function, when it is test `cid`
  const pendingTest = (cid) => {
    const f = stack.at(-1);
    return f?.pending?.cond.k === cid ? f : null;
  };
  const runtime = {
    __GLOBAL: (g) => (sandboxGlobal = g),
    __E(fn, line, params, vars) {
      stack.push({ fn, id: ++ids, line, vars });
      snap("call", line, () => ({ params }));
      return ids;
    },
    __S: S,
    __O(cid, i, v) {
      const f = pendingTest(cid);
      if (f) f.pending.cond.o.push([i, enc.value(v, f.pending.heap)]);
      return v;
    },
    __T(cid, v) {
      const f = pendingTest(cid);
      if (f) {
        f.pending.cond.v = !!v;
        f.pending = null;
      }
      return v;
    },
    __R(id, line, v) {
      const f = frame(id);
      if (f) {
        f.line = line;
        snap("return", line, (heap) => ({ ret: enc.value(v, heap) }));
      }
      return v;
    },
    __X(id, e) {
      const f = frame(id);
      if (f && !(e instanceof StopRun))
        snap("exception", f.line, () => ({ exc: `${e?.name || "Error"}: ${e?.message ?? String(e)}`.slice(0, 200) }));
    },
    __L(id) {
      while (stack.length) if (stack.pop().id === id) break;
    },
    *__I(line, vars, items) {
      for (const v of items) {
        S(line, vars);
        yield v;
      }
      S(line, vars);
    },
    __RESULT(v) {
      value = v;
      hasValue = true;
    },
    console: Object.fromEntries(
      ["log", "info", "warn", "error", "debug"].map((k) => [k, (...a) => (out += `${a.map((x) => show(x)).join(" ")}\n`)]),
    ),
  };
  // the helpers, unless the code defines its own (a ListNode class of its own)
  const own = new Set([...declaredIn(ast.body), ...varsOf(ast)]);
  const vm = new Sval({ ecmaVer: "latest", sandBox: true });
  vm.import({ ...Object.fromEntries(Object.entries(HELPERS).filter(([k]) => !own.has(k))), ...runtime });
  try {
    vm.run(source);
  } catch (e) {
    if (!(e instanceof StopRun)) {
      result.error = `${e?.name || "Error"}: ${e?.message ?? String(e)}`.slice(0, 300);
      if (stack.length)
        try {
          runtime.__X(-1, e); // (an error in a script's top level: no function caught it on the way out)
        } catch {}
    }
  }
  if (hasValue) {
    const heap = {};
    result.result = { v: enc.value(value, heap), heap };
  }
  result.out = out.slice(-4000);
  return result;
}

// ---------------------------------------------------------------- which variables index which lists (static, from the code)
const OPS = { "+": "+", "-": "-", "*": "*", "%": "%" };
const target = (n) =>
  n.type === "Identifier"
    ? n.name
    : n.type === "MemberExpression" && !n.computed && n.object.type === "ThisExpression"
      ? `this.${n.property.name}`
      : null;
/** A small arithmetic expression the panel can work out itself: ["+", ["n", "target"], ["c", 1]] (or null). Math.floor(a / b) is a // b. */
function expr(n) {
  if (n.type === "Identifier") return ["n", n.name];
  if (n.type === "Literal" && Number.isInteger(n.value)) return ["c", n.value];
  if (n.type === "UnaryExpression" && n.operator === "-") {
    // Simplify -constant to a negative constant
    if (n.argument.type === "Literal" && Number.isInteger(n.argument.value)) {
      return ["c", -n.argument.value];
    }
    const a = expr(n.argument);
    return a && ["neg", a];
  }
  if (n.type === "BinaryExpression" && OPS[n.operator]) {
    const a = expr(n.left),
      b = expr(n.right);
    return a && b && [OPS[n.operator], a, b];
  }
  if (
    n.type === "CallExpression" &&
    n.callee.type === "MemberExpression" &&
    /^Math\.(floor|trunc)$/.test(`${n.callee.object.name}.${n.callee.property.name}`)
  ) {
    const d = n.arguments[0];
    if (d?.type === "BinaryExpression" && d.operator === "/") {
      const a = expr(d.left),
        b = expr(d.right);
      return a && b && ["//", a, b];
    }
  }
  // name.length: the length of a list
  if (n.type === "MemberExpression" && !n.computed && n.object.type === "Identifier" && n.property.name === "length") {
    return ["len", n.object.name];
  }
  // name.at(-1): list element at index -1 (or other constant)
  if (
    n.type === "CallExpression" &&
    n.callee.type === "MemberExpression" &&
    !n.callee.computed &&
    n.callee.object.type === "Identifier" &&
    n.callee.property.name === "at" &&
    n.arguments.length === 1
  ) {
    const idx = expr(n.arguments[0]);
    return idx && ["sub", n.callee.object.name, idx];
  }
  // Subscript of a list variable: temps[stack[stack.length - 1]]
  if (n.type === "MemberExpression" && n.computed && n.object.type === "Identifier") {
    const idx = expr(n.property);
    return idx && ["sub", n.object.name, idx];
  }
  return null;
}

// ---------------------------------------------------------------- the values an if / a loop compares
const constant = (n) =>
  n.type === "Literal" ||
  (n.type === "UnaryExpression" && n.argument.type === "Literal") ||
  (n.type === "Identifier" && n.name === "undefined");
const COMPARE = new Set(["<", "<=", ">", ">=", "==", "!=", "===", "!==", "in"]);
/** The parts of a test whose values explain it: each side of a comparison, each part of an && / || (constants say themselves) */
function operands(n) {
  if (n.type === "SequenceExpression") return []; // (a, b): not one value to pass on
  if (n.type === "LogicalExpression") return [...operands(n.left), ...operands(n.right)];
  if (n.type === "UnaryExpression" && n.operator === "!") return operands(n.argument);
  if (n.type === "BinaryExpression" && COMPARE.has(n.operator)) return [n.left, n.right].filter((x) => !constant(x));
  if (n.type === "BinaryExpression" && n.operator === "instanceof") return constant(n.left) ? [] : [n.left];
  return constant(n) ? [] : [n];
}
/** What an operand reads, so the panel can mark it: a variable ({on}), an array's item ({on, ix}) or a grid's cell ({on, rc}) */
function operandInfo(n) {
  if (target(n)) return { on: target(n) };
  if (n.type === "MemberExpression" && n.computed) {
    const inner = n.object;
    if (inner.type === "MemberExpression" && inner.computed && target(inner.object) && expr(inner.property) && expr(n.property))
      return { on: target(inner.object), rc: [expr(inner.property), expr(n.property)] };
    if (target(inner) && expr(n.property)) return { on: target(inner), ix: expr(n.property) };
  }
  return {};
}

const midpoint = (n) => {
  let found = false;
  walk(n, (x) => {
    if (x.type === "BinaryExpression" && (x.operator === ">>" || x.operator === ">>>")) found = true;
    if (
      x.type === "CallExpression" &&
      x.callee.type === "MemberExpression" &&
      x.callee.object.name === "Math" &&
      /floor|trunc/.test(x.callee.property.name)
    )
      found = true;
  });
  return found;
};

const isStatement = (n) => /Statement$|^VariableDeclaration$/.test(n.type) && n.type !== "BlockStatement";
/** What each line reads and writes, and how variables point into each other (the format tracer.py's links() writes): "acc": each item
 * (nums[i - 1]) or cell (dp[i][j]) a line reads or writes (w); "iters": `for (const v of graph[key])`; "holds": a list whose items are
 * places in another (temps[stack[stack.length - 1]], or j = stack.pop() then ans[j]). */
function links(fn, idx, lineOf) {
  const acc = [],
    iters = {},
    holds = {},
    popped = {};
  const hold = (on, by) => on !== by && (holds[on] ||= new Set()).add(by);
  const stmts = [];
  walk(fn.type === "Program" ? { type: "X", body: fn.body } : fn.body, (n) => {
    if (FUNCTIONS.has(n.type) || n.type === "ClassDeclaration" || n.type === "ClassExpression") return false;
    if (isStatement(n)) stmts.push(n);
  });
  // an item of a list: stack.pop(), q.shift(), stack[stack.length - 1], stack.at(-1)
  const itemOf = (v) => {
    if (!v) return null;
    if (v.type === "CallExpression" && v.callee.type === "MemberExpression" && ["pop", "shift", "at"].includes(v.callee.property.name))
      return target(v.callee.object);
    if (v.type === "MemberExpression" && v.computed && v.property.type !== "Identifier") return target(v.object);
    return null;
  };
  for (const s of stmts) {
    const line = lineOf(s.start);
    const rows = new Set();
    // `maybe`: inside what may not run (the branches of a ? b : c, the right of && / || / ??): how lists point into each other counts,
    // what was read doesn't
    const visit = (maybe) =>
      function see(n, p) {
        if (isStatement(n) || FUNCTIONS.has(n.type)) return false;
        if (!maybe && (n.type === "ConditionalExpression" || n.type === "LogicalExpression")) {
          walk(n.type === "ConditionalExpression" ? n.test : n.left, see, n);
          for (const x of n.type === "ConditionalExpression" ? [n.consequent, n.alternate] : [n.right]) walk(x, visit(true), n);
          return false;
        }
        if (n.type !== "MemberExpression" || !n.computed || rows.has(n)) return;
        const w = (p?.type === "AssignmentExpression" && p.left === n) || (p?.type === "UpdateExpression" && p.argument === n);
        const o = n.object;
        if (target(o) && itemOf(n.property)) hold(target(o), itemOf(n.property));
        if (o.type === "MemberExpression" && o.computed && target(o.object) && expr(o.property) && expr(n.property)) {
          rows.add(o);
          if (!maybe) acc.push({ line, on: target(o.object), rc: [expr(o.property), expr(n.property)], w: !!w });
        } else if (target(o) && expr(n.property) && !maybe) acc.push({ line, on: target(o), ix: expr(n.property), w: !!w });
      };
    for (const c of kids(s)) walk(c, visit(false), s);
    if (s.type === "ForOfStatement" && s.right.type === "MemberExpression" && s.right.computed && target(s.right.object)) {
      const left = s.left.type === "VariableDeclaration" ? s.left.declarations[0].id : s.left;
      const first = left.type === "ArrayPattern" ? left.elements[0] : left;
      if (first?.type === "Identifier" && s.right.property.type === "Identifier")
        iters[first.name] = [target(s.right.object), s.right.property.name];
    }
    // j = stack.pop(): j is an item of that list
    const pairs =
      s.type === "VariableDeclaration"
        ? s.declarations.map((d) => [d.id, d.init])
        : s.type === "ExpressionStatement" && s.expression.type === "AssignmentExpression" && s.expression.operator === "="
          ? [[s.expression.left, s.expression.right]]
          : [];
    for (const [id, init] of pairs) if (id.type === "Identifier" && itemOf(init)) popped[id.name] = itemOf(init);
  }
  for (const [on, names] of Object.entries(idx)) for (const x of names) if (popped[x]) hold(on, popped[x]);
  return { acc, iters, holds: Object.fromEntries(Object.entries(holds).map(([k, v]) => [k, [...v].sort()])) };
}

function analyse(ast, src) {
  const lineOf = lineIndex(src);
  const out = {};
  const scopes = [["<module>", { type: "Program", body: ast.body.filter((s) => !definition(s)), start: 0, end: 0 }]];
  walk(ast, (n, p) => {
    if (FUNCTIONS.has(n.type)) scopes.push([nameOf(n, p), n]);
  });
  const usage = {};
  for (const [scope, fn] of scopes) {
    const idx = {},
      keys = {},
      grid = {},
      probes = [],
      calls = {},
      derived = {};
    const bits = new Set(),
      inplace = new Set(),
      swaps = new Set();
    const add = (m, k, v) => (m[k] ||= new Set()).add(v);
    walk(fn, (n) => {
      if (n.type === "MemberExpression" && n.computed) {
        if (n.object.type === "MemberExpression" && n.object.computed && target(n.object.object)) {
          const g = (grid[target(n.object.object)] ||= [new Set(), new Set()]);
          if (n.object.property.type === "Identifier") g[0].add(n.object.property.name);
          if (n.property.type === "Identifier") g[1].add(n.property.name);
        } else if (target(n.object) && n.property.type === "Identifier") {
          add(idx, target(n.object), n.property.name);
          add(keys, target(n.object), n.property.name);
        } else if (target(n.object) && n.property.type !== "Literal") {
          if (expr(n.property)) {
            probes.push({
              on: target(n.object),
              line: lineOf(n.start),
              e: expr(n.property),
              text: src.slice(n.property.start, n.property.end),
              kind: "get",
            });
          }
          // nums[(lo + hi) >> 1]: lo and hi are index variables (complex expression)
          walk(n.property, (x) => {
            if (x.type === "Identifier") add(idx, target(n.object), x.name);
          });
        }
      }
      if (n.type === "CallExpression" && n.callee.type === "MemberExpression" && !n.callee.computed && target(n.callee.object)) {
        const on = target(n.callee.object),
          m = n.callee.property.name,
          a = n.arguments[0];
        add(calls, on, m);
        if (["get", "has", "set", "delete"].includes(m) && a) {
          if (a.type === "Identifier") add(keys, on, a.name);
          else if (m !== "set" && expr(a))
            probes.push({ on, line: lineOf(n.start), e: expr(a), text: src.slice(a.start, a.end), kind: m === "has" ? "in" : "get" });
        }
        if (m === "at" && a && expr(a)) {
          probes.push({ on, line: lineOf(n.start), e: expr(a), text: src.slice(a.start, a.end), kind: "get" });
        }
        if (["slice", "subarray", "substring"].includes(m))
          n.arguments.filter((x) => x.type === "Identifier").forEach((x) => add(idx, on, x.name));
        // arr.forEach((x, i) => ...): i walks over arr
        const cb = n.arguments.find((x) => FUNCTIONS.has(x.type));
        if (cb && ["forEach", "map", "filter", "some", "every", "findIndex", "reduce"].includes(m)) {
          const i = cb.params[m === "reduce" ? 2 : 1];
          if (i?.type === "Identifier") add(idx, on, i.name);
        }
      }
      if (n.type === "BinaryExpression" && n.operator === "in" && target(n.right) && expr(n.left))
        probes.push({ on: target(n.right), line: lineOf(n.start), e: expr(n.left), text: src.slice(n.left.start, n.left.end), kind: "in" });
      // for (let i = 0; i < nums.length; i++) / for (let i = nums.length - 1; ...): i walks over nums
      if (n.type === "ForStatement") {
        const vars = n.init?.type === "VariableDeclaration" ? n.init.declarations.flatMap((d) => bound(d.id)) : [];
        const lengths = [];
        walk({ type: "X", a: n.init, b: n.test }, (x) => {
          if (x.type === "MemberExpression" && !x.computed && x.property.name === "length" && target(x.object))
            lengths.push(target(x.object));
        });
        for (const v of vars) for (const l of lengths) add(idx, l, v);
      }
      // for (const [i, x] of nums.entries())
      if (
        n.type === "ForOfStatement" &&
        n.right.type === "CallExpression" &&
        n.right.callee.property?.name === "entries" &&
        target(n.right.callee.object)
      ) {
        const first = n.left.type === "VariableDeclaration" ? n.left.declarations[0].id : n.left;
        if (first.type === "ArrayPattern" && first.elements[0]?.type === "Identifier")
          add(idx, target(n.right.callee.object), first.elements[0].name);
      }
      if (n.type === "BinaryExpression" && ["&", "|", "^", "<<", ">>", ">>>"].includes(n.operator)) {
        if (n.left.type === "Identifier") bits.add(n.left.name);
        if (!["<<", ">>", ">>>"].includes(n.operator) && n.right.type === "Identifier") bits.add(n.right.name); // (a shift's right is a count)
      }
      if (
        n.type === "AssignmentExpression" &&
        ["&=", "|=", "^=", "<<=", ">>=", ">>>="].includes(n.operator) &&
        n.left.type === "Identifier"
      )
        bits.add(n.left.name);
      if (n.type === "UnaryExpression" && n.operator === "~" && n.argument.type === "Identifier") bits.add(n.argument.name);
      // [a[i], a[j]] = [a[j], a[i]]: elements swapped in place
      if (n.type === "AssignmentExpression" && n.left.type === "ArrayPattern") {
        const subs = n.left.elements.filter((e) => e?.type === "MemberExpression" && e.computed).map((e) => target(e.object));
        subs.filter((v, i) => v && subs.indexOf(v) !== i).forEach((v) => swaps.add(v));
      }
      if ((n.type === "AssignmentExpression" || n.type === "UpdateExpression") && (n.left || n.argument).type === "MemberExpression") {
        const m = n.left || n.argument;
        if (m.computed && m.object.type !== "MemberExpression" && target(m.object)) inplace.add(target(m.object));
      }
      // a midpoint, mid = Math.floor((lo + hi) / 2) or (lo + hi) >> 1: its ends are pointers too
      // but not pivot = nums[(lo + hi) >> 1] (subscript expressions are excluded)
      const assigned =
        n.type === "VariableDeclarator"
          ? [n.id, n.init]
          : n.type === "AssignmentExpression" && n.operator === "="
            ? [n.left, n.right]
            : null;
      // (read from the code itself: expr() can't write Math.floor(...), so it can't say)
      let readsItem = false;
      if (assigned?.[1])
        walk(assigned[1], (x) => {
          if (x.type === "MemberExpression" && !(x.object.type === "Identifier" && x.object.name === "Math")) readsItem = true;
        });
      if (assigned && assigned[0].type === "Identifier" && assigned[1] && !readsItem && midpoint(assigned[1])) {
        walk(assigned[1], (x, xp) => {
          if (x.type === "Identifier" && x.name !== "Math" && !(xp?.type === "MemberExpression" && xp.property === x))
            add(derived, assigned[0].name, x.name);
        });
      }
      // n = array.length: n is the length of array, so it's an index/pointer (used as upper bound)
      if (
        assigned &&
        assigned[0].type === "Identifier" &&
        assigned[1]?.type === "MemberExpression" &&
        !assigned[1].computed &&
        assigned[1].property.name === "length" &&
        target(assigned[1].object)
      ) {
        add(idx, target(assigned[1].object), assigned[0].name);
      }
      if (n !== fn && scope === "<module>" && FUNCTIONS.has(n.type)) return false; // (the top level's own statements only)
    });
    for (const v of Object.values(idx)) for (const x of [...v]) (derived[x] || []).forEach((y) => v.add(y));
    const sorted = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, [...v].sort()]));
    out[scope] = {
      idx: sorted(idx),
      keys: sorted(keys),
      grid: Object.fromEntries(Object.entries(grid).map(([k, [r, c]]) => [k, [[...r].sort(), [...c].sort()]])),
      probes,
      bits: [...bits].sort(),
      heaps: [],
      ...links(fn, idx, lineOf),
    };
    usage[scope] = { calls, inplace, swaps };
  }
  // a class's attributes are used across its methods (push appends to this.stack, pop pops it): their usage is pooled
  const pooled = {};
  for (const { calls } of Object.values(usage))
    for (const [v, m] of Object.entries(calls)) if (v.startsWith("this.")) m.forEach((x) => (pooled[v] ||= new Set()).add(x));
  for (const [scope, { calls, inplace, swaps }] of Object.entries(usage)) {
    const all = { ...calls, ...pooled };
    const queue = (m) => m.has("shift") || m.has("unshift");
    Object.assign(out[scope], {
      stacks: Object.keys(all)
        .filter((v) => all[v].has("push") && all[v].has("pop") && !queue(all[v]))
        .sort(),
      queues: Object.keys(all)
        .filter((v) => queue(all[v]))
        .sort(),
      inplace: [...inplace].sort(),
      swaps: [...swaps].sort(),
    });
  }
  return out;
}

// ---------------------------------------------------------------- the code as a tree of statements
function outline(ast, src) {
  const lineOf = lineIndex(src);
  const keyword = (word, from, to) => {
    const i = src.slice(from, to).lastIndexOf(word);
    return lineOf(i < 0 ? to : from + i);
  };
  const item = (t, n, e, c) => ({ t, l: lineOf(n.start), e: lineOf(e), c });
  const block = (b) => (b.type === "BlockStatement" ? b.body.flatMap(node) : node(b));
  const fnBody = (f) => (f.body.type === "BlockStatement" ? f.body.body.flatMap(node) : []);
  function node(s) {
    switch (s.type) {
      case "FunctionDeclaration":
        return [item("function", s, s.end, fnBody(s))];
      case "ClassDeclaration":
        return [
          item(
            "class",
            s,
            s.end,
            s.body.body.filter((m) => m.type === "MethodDefinition").map((m) => item("method", m, m.end, fnBody(m.value))),
          ),
        ];
      case "VariableDeclaration": {
        const f = s.declarations.length === 1 && FUNCTIONS.has(s.declarations[0].init?.type) ? s.declarations[0].init : null;
        return [item(s.kind, s, s.end, f ? fnBody(f) : [])];
      }
      case "ExpressionStatement": {
        const f = s.expression.type === "AssignmentExpression" && FUNCTIONS.has(s.expression.right.type) ? s.expression.right : null;
        return [item("expr", s, s.end, f ? fnBody(f) : [])];
      }
      case "IfStatement": {
        const out = [item("if", s, s.consequent.end, block(s.consequent))];
        const alt = s.alternate;
        if (alt?.type === "IfStatement") {
          const [first, ...rest] = node(alt);
          out.push({ ...first, t: "else if", l: keyword("else", s.consequent.end, alt.start) }, ...rest);
        } else if (alt) out.push({ t: "else", l: keyword("else", s.consequent.end, alt.start), e: lineOf(alt.end), c: block(alt) });
        return out;
      }
      case "ForStatement":
      case "ForOfStatement":
      case "ForInStatement":
        return [item("for", s, s.end, block(s.body))];
      case "WhileStatement":
        return [item("while", s, s.end, block(s.body))];
      case "DoWhileStatement":
        return [item("do", s, s.end, block(s.body))];
      case "SwitchStatement":
        return [
          item(
            "switch",
            s,
            s.end,
            s.cases.map((c) => item(c.test ? "case" : "default", c, c.end, c.consequent.flatMap(node))),
          ),
        ];
      case "TryStatement": {
        const out = [item("try", s, s.block.end, block(s.block))];
        if (s.handler) out.push(item("catch", s.handler, s.handler.end, block(s.handler.body)));
        if (s.finalizer)
          out.push({
            t: "finally",
            l: keyword("finally", (s.handler || s.block).end, s.finalizer.start),
            e: lineOf(s.finalizer.end),
            c: block(s.finalizer),
          });
        return out;
      }
      case "LabeledStatement":
        return node(s.body);
      case "BlockStatement":
        return s.body.flatMap(node);
      case "EmptyStatement":
        return [];
      default:
        return [item(s.type.replace(/Statement$|Declaration$/, "").toLowerCase(), s, s.end, [])];
    }
  }
  return ast.body.flatMap(node);
}

// ---------------------------------------------------------------- a starting call (for code that only defines functions)
/** @type {[RegExp, string][]} */
const DEFAULTS = [
  [
    /^(nums|arr|array|a|b|values|vals|heights|height|prices|weights|piles|stones|cost|costs|ratings|temperatures|data|xs|seq)$/,
    "[5, 2, 8, 1, 9, 3]",
  ],
  [/^(coins)$/, "[1, 2, 5]"],
  [/^(strs|words|wordList|dictionary|tokens)$/, '["eat", "tea", "tan", "ate", "nat", "bat"]'],
  [/^(s|t|text|word|string|str|str1|str2|pat|pattern|p|txt|w)$/, '"abcabcbb"'],
  [/^(grid|board|matrix|mat|maze|image)$/, "[[1, 1, 0, 0], [1, 0, 0, 1], [0, 0, 1, 1]]"],
  [/^(edges|connections|roads|flights|times|prerequisites|pairs)$/, "[[0, 1], [0, 2], [1, 3], [2, 3], [3, 4]]"],
  [/^(adj|graph|g|neighbors)$/, "{0: [1, 2], 1: [0, 3], 2: [0, 3], 3: [1, 2]}"],
  [/^(intervals|points|queries|positions|updates|ranges|meetings|events|ops)$/, "[[1, 3], [2, 6], [8, 10], [15, 18]]"],
  [/^(root|tree)$/, "tree([4, 2, 6, 1, 3, 5, 7])"],
  [/^(head|l1|l2|list1|list2|headA|headB|lst)$/, "linked([1, 2, 3, 4, 5])"],
  [/^(mod|MOD|M)$/, "1000000007"],
  [/^(amount)$/, "11"],
  [/^(target)$/, "9"],
  [/^(k|K)$/, "2"],
  [/^(n|N|m|size|length|num|x|y|c|h|limit|capacity|cap)$/, "5"],
  [/^(key|val|value|v|start|src|source|dst|end|goal|lo|hi|left|right)$/, "1"],
];
const KIND_DEFAULT = {
  linked: "linked([1, 2, 3, 4, 5])",
  tree: "tree([4, 2, 6, 1, 3, 5, 7])",
  graph: "graph({1: [2, 4], 2: [1, 3], 3: [2, 4], 4: [1, 3]})",
  grid: "[[1, 1, 0, 0], [1, 0, 0, 1], [0, 0, 1, 1]]",
  pairs: "[[1, 3], [2, 6], [8, 10], [15, 18]]",
  str: '"abcabcbb"',
  list: "[5, 2, 8, 1, 9, 3]",
  int: "5",
};
const STR_METHODS = new Set([
  "split",
  "charAt",
  "charCodeAt",
  "toLowerCase",
  "toUpperCase",
  "trim",
  "startsWith",
  "endsWith",
  "substring",
  "padStart",
  "repeat",
]);
/** What a parameter must be, from how the function uses it: 'linked', 'tree', 'grid', ... or null */
function kindOf(fn, name) {
  const attrs = new Set(),
    seen = new Set();
  walk(fn, (n) => {
    if (n.type === "MemberExpression" && n.object.type === "Identifier" && n.object.name === name) {
      if (!n.computed) attrs.add(n.property.name);
      else seen.add("index");
    }
    if (
      n.type === "MemberExpression" &&
      n.computed &&
      n.object.type === "MemberExpression" &&
      n.object.computed &&
      n.object.object.name === name
    )
      seen.add("grid");
    if (n.type === "ForOfStatement" && n.right.type === "Identifier" && n.right.name === name) {
      const l = n.left.type === "VariableDeclaration" ? n.left.declarations[0].id : n.left;
      seen.add(l.type === "ArrayPattern" ? "pairs" : "iter");
    }
    if (
      (n.type === "BinaryExpression" || n.type === "AssignmentExpression") &&
      [n.left, n.right].some((x) => x.type === "Identifier" && x.name === name)
    ) {
      const other = n.left.type === "Identifier" && n.left.name === name ? n.right : n.left;
      if (other.type === "Literal" && typeof other.value === "number") seen.add("int");
    }
  });
  if (attrs.has("neighbors")) return "graph";
  if (attrs.has("left") || attrs.has("right") || attrs.has("val")) return attrs.has("next") ? "linked" : "tree";
  if (attrs.has("next")) return "linked";
  if ([...attrs].some((a) => STR_METHODS.has(a))) return "str";
  if (seen.has("grid")) return "grid";
  if (seen.has("pairs")) return "pairs";
  if (seen.has("int") && !seen.has("index") && !attrs.has("length")) return "int";
  if (seen.has("index") || seen.has("iter") || ["length", "push", "pop", "sort", "map", "forEach"].some((a) => attrs.has(a))) return "list";
  return null;
}
function defaultFor(name, kind) {
  const byName = DEFAULTS.find(([re]) => re.test(name))?.[1] || "3";
  if (!kind) return byName;
  const fits = {
    list: byName.startsWith("[") && !byName.startsWith("[["),
    str: byName.startsWith('"'),
    grid: byName.startsWith("[["),
    pairs: byName.startsWith("[["),
    int: /^\d+$/.test(byName),
    tree: byName.startsWith("tree"),
    linked: byName.startsWith("linked"),
    graph: byName.startsWith("graph") || byName.startsWith("{"),
  };
  return fits[kind] || (byName.startsWith("[[") && kind === "list") ? byName : KIND_DEFAULT[kind];
}

/** What the code defines to be called: its functions (`plain`, the one an input calls last: the last one nothing calls), and the classes a
 * design problem's calls are made on: [name, constructor, [[method, function]]] (a class, or LeetCode's X.prototype.m = function). */
function definitions(ast) {
  const fns = [];
  for (const s of ast.body) {
    if (s.type === "FunctionDeclaration") fns.push([s.id.name, s]);
    if (s.type === "VariableDeclaration")
      for (const d of s.declarations) if (FUNCTIONS.has(d.init?.type) && d.id.type === "Identifier") fns.push([d.id.name, d.init]);
  }
  const called = new Set();
  walk(ast, (n) => {
    if ((n.type === "CallExpression" || n.type === "NewExpression") && n.callee.type === "Identifier") called.add(n.callee.name);
  });
  // LeetCode style for design problems: var MinStack = function() {...}; MinStack.prototype.push = function(x) {...}
  const protoMethods = {};
  for (const s of ast.body) {
    const e = s.type === "ExpressionStatement" ? s.expression : null;
    const l = e?.type === "AssignmentExpression" ? e.left : null;
    if (
      l?.type === "MemberExpression" &&
      l.object.type === "MemberExpression" &&
      l.object.property.name === "prototype" &&
      FUNCTIONS.has(e.right.type)
    )
      (protoMethods[l.object.object.name] ||= []).push([l.property.name, e.right]);
  }
  const plain = fns.filter(([n]) => !protoMethods[n]);
  const entry = plain.filter(([n]) => !called.has(n)).at(-1) || plain.at(-1);
  if (entry) {
    plain.splice(plain.indexOf(entry), 1);
    plain.push(entry);
  }
  const classes = ast.body.filter((s) => s.type === "ClassDeclaration" && !HELPERS[s.id.name]).map((c) => [c.id.name, c]);
  const designs = [
    ...classes.map(([n, c]) => [
      n,
      c.body.body.find((m) => m.kind === "constructor")?.value,
      c.body.body
        .filter((m) => m.type === "MethodDefinition" && m.kind === "method" && !m.static && !m.key.name?.startsWith("_"))
        .map((m) => [m.key.name, m.value]),
    ]),
    ...Object.entries(protoMethods).map(([n, ms]) => [n, fns.find(([x]) => x === n)?.[1], ms]),
  ];
  return { plain, designs };
}
// a function's parameters an input gives (defaults and rest are left to the function)
const paramNames = (f) => (f ? f.params.filter((p) => p.type === "Identifier").map((p) => p.name) : []);

/** A first call for code that only defines functions, or a class and calls on it: { driver, guessed: [the inputs that were picked] } */
export function suggest(code) {
  let ast;
  try {
    ast = parse(code);
  } catch {
    return { driver: "", guessed: [] };
  }
  const { plain, designs } = definitions(ast);
  if (plain.length) {
    const [name, f] = plain.at(-1);
    const params = paramNames(f);
    return { driver: `${name}(${params.map((p) => defaultFor(p, kindOf(f, p))).join(", ")})`, guessed: params };
  }
  if (!designs.length) return { driver: "", guessed: [] };
  const [cls, ctor, methods] = designs.at(-1);
  const args = (f) => (f ? f.params.filter((p) => p.type === "Identifier").map((p) => defaultFor(p.name, kindOf(f, p.name))) : []);
  const lines = [`const obj = new ${cls}(${args(ctor).join(", ")});`];
  const ADDS = /^(insert|push|put|add|set|append|enqueue|offer|update|record|hit|post|addWord|addNum|write|book|follow|visit|store|inc)/i;
  for (const [m, f] of [...methods.filter(([m]) => ADDS.test(m)), ...methods.filter(([m]) => !ADDS.test(m))]) {
    for (let rep = 0; rep < (ADDS.test(m) ? 3 : 2); rep++) {
      const vals = f.params.map((p, i) => {
        const k = p.type === "Identifier" ? kindOf(f, p.name) : null;
        if (!k || k === "int") return String(i ? (rep + 1) * (i + 1) : rep + 1);
        return k === "str" ? JSON.stringify(["apple", "app", "apply"][rep % 3]) : KIND_DEFAULT[k];
      });
      lines.push(`obj.${m}(${vals.join(", ")});`);
    }
  }
  return { driver: lines.slice(0, 12).join("\n"), guessed: ["operations"] };
}

/** What LeetCode builds for a parameter from a list (the format tracer.py's node_kind() gives): "linked", "tree", "graph", with [] for
 * a list of them, or null. From the JSDoc above the function (@param {ListNode} head), else how the function uses it. */
function nodeKind(src, f, name) {
  // the /** ... */ right before the function (or before `var name =`, `X.prototype.m =`)
  const before = src.slice(0, f.start).replace(/[\w$.\s=]*$/, "");
  const doc = before.endsWith("*/") ? before.slice(before.lastIndexOf("/**")) : "";
  const hint = new RegExp(`@param\\s*\\{([^}]*)\\}\\s*\\[?${name}\\b`).exec(doc)?.[1].trim() || "";
  const many = /\[\]\s*$|^Array</.test(hint);
  const usage = kindOf(f, name);
  const base = /\bListNode\b/.test(hint)
    ? "linked"
    : /\bTreeNode\b/.test(hint)
      ? "tree"
      : !hint || /\b_?Node\b/.test(hint)
        ? ["linked", "tree", "graph"].includes(usage)
          ? usage
          : null
        : null;
  return base && base + (many ? "[]" : "");
}

/** What a LeetCode test case is turned into a call with (the format tracer.py's signature() gives): { entries: [{ call, params: [{ name,
 * kind }] }] (the function an input calls first), classes: { name: { init: [params], methods: { name: [params] } } } }. */
export function signature(code) {
  let ast;
  try {
    ast = parse(code);
  } catch (e) {
    return { entries: [], classes: {}, error: `The code doesn't run: ${syntaxError(e)}` };
  }
  const { plain, designs } = definitions(ast);
  const params = (f) => paramNames(f).map((name) => ({ name, kind: nodeKind(code, f, name) }));
  return {
    entries: [...plain].reverse().map(([call, f]) => ({ call, params: params(f) })),
    classes: Object.fromEntries(
      designs.map(([cls, ctor, methods]) => [
        cls,
        { init: params(ctor), methods: Object.fromEntries(methods.map(([m, f]) => [m, params(f)])) },
      ]),
    ),
  };
}

/** True when the code runs something by itself (no functions at all, or its top level calls its own), so its top level is traced. */
export function isScript(code) {
  let ast;
  try {
    ast = parse(code);
  } catch {
    return true; // trace() reports the error
  }
  const defs = ast.body.filter(definition);
  const own = new Set(defs.flatMap((s) => (s.id ? [s.id.name] : s.declarations ? s.declarations.flatMap((d) => bound(d.id)) : [])));
  let calls = false;
  for (const s of ast.body.filter((x) => !definition(x)))
    walk(s, (n) => {
      if ((n.type === "CallExpression" || n.type === "NewExpression") && n.callee.type === "Identifier" && own.has(n.callee.name))
        calls = true;
    });
  return !defs.length || calls;
}

/** The whole run, as the panel gets it (the same fields as tracer.py's run()). An empty input runs a script, or a suggested call. */
export function run(code, driver = "", mode = "trace") {
  if (mode === "suggest") return suggest(code);
  if (mode === "signature") return signature(code);
  let script = false,
    guessed = [];
  if (!driver.trim()) {
    script = isScript(code);
    if (!script) ({ driver, guessed } = suggest(code));
  }
  const r = trace(code, driver, script);
  let pointers = {},
    tree = [];
  try {
    const ast = parse(code);
    pointers = analyse(ast, code);
    tree = outline(ast, code);
  } catch {}
  return { ...r, pointers, outline: tree, driver, guessed, script, lang: "javascript" };
}
