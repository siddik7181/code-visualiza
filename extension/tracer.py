# Runs any Python code (a script, functions plus a call, a class plus calls) and records every step (line, call, return), the way a
# debugger would, so the visualizer can replay it. Nothing is guessed or generated: each step is the real state of the program. Runs inside
# Pyodide in a Web Worker (worker.js).
# Also suggests a starting call for code that only defines functions (`suggest`), finds which variables index which lists (`analyse`), so
# the visualizer can draw them as pointers, and turns the code into a tree of statements (`outline`) for the code-tree view.
import ast, io, json, math, random, re, sys, types

MAX_STEPS = 1500   # a trace longer than this stops early (also stops infinite loops)
MAX_ITEMS = 64     # items shown per list/dict/set
MAX_OBJECTS = 150  # objects shown per step
STR_MAX = 80


class ListNode:
    def __init__(self, val=0, next=None):
        self.val, self.next = val, next


class TreeNode:
    def __init__(self, val=0, left=None, right=None):
        self.val, self.left, self.right = val, left, right


def linked(values):
    """linked([1, 2, 3]) -> 1 -> 2 -> 3"""
    head = None
    for v in reversed(list(values)):
        head = ListNode(v, head)
    return head


def tree(values):
    """tree([3, 9, 20, None, None, 15, 7]) builds a binary tree from level order (None = no child)"""
    values = list(values)
    if not values or values[0] is None:
        return None
    root = TreeNode(values[0])
    queue, i = [root], 1
    while queue and i < len(values):
        node = queue.pop(0)
        for side in ("left", "right"):
            if i < len(values) and values[i] is not None:
                child = TreeNode(values[i])
                setattr(node, side, child)
                queue.append(child)
            i += 1
    return root


class Node:
    """A general node for solutions that use one without defining it (linked lists, random pointers, graphs, n-ary trees)."""

    def __init__(self, val=0, next=None, random=None, neighbors=None, left=None, right=None, children=None):
        self.val, self.next, self.random = val, next, random
        self.left, self.right = left, right
        self.neighbors = neighbors if neighbors is not None else []
        self.children = children if children is not None else []


def graph(adj):
    """graph({1: [2, 4], 2: [1, 3], ...}) -> the Node for the first key, with .neighbors linked"""
    nodes = {k: Node(k) for k in adj}
    for k, vs in adj.items():
        nodes[k].neighbors = [nodes.setdefault(v, Node(v)) for v in vs]
    return nodes[next(iter(adj))] if adj else None


HELPERS = {"ListNode": ListNode, "TreeNode": TreeNode, "Node": Node, "linked": linked, "tree": tree, "graph": graph}


def standard_names():
    """Modules and names solutions often use without importing them (snippets are written as if inside a LeetCode file)."""
    import bisect, collections, functools, heapq, itertools, operator, string, typing

    ns = {"heapq": heapq, "collections": collections, "bisect": bisect, "math": math, "functools": functools, "itertools": itertools,
          "random": random, "sys": sys, "operator": operator, "string": string, "re": re}
    for name in ("deque", "defaultdict", "Counter", "OrderedDict", "namedtuple"):
        ns[name] = getattr(collections, name)
    for name in ("heappush", "heappop", "heapify", "heappushpop", "heapreplace", "nlargest", "nsmallest"):
        ns[name] = getattr(heapq, name)
    for name in ("bisect_left", "bisect_right", "insort", "bisect"):
        ns[name] = getattr(bisect, name)
    for name in ("lru_cache", "cache", "reduce", "cmp_to_key"):
        if hasattr(functools, name):
            ns[name] = getattr(functools, name)
    for name in ("List", "Optional", "Dict", "Tuple", "Set"):
        ns[name] = getattr(typing, name)
    ns["inf"] = math.inf
    ns["input"] = no_input
    return ns


def no_input(prompt=""):
    raise RuntimeError("input() can't ask you to type here: put the value in the code instead")


class TooManySteps(BaseException):  # not an Exception, so the code's own `except Exception:` can't swallow the step limit
    pass


CO_NEWLOCALS = 0x2  # set on function code; a class body runs without it and isn't traced (its lines only define methods)


def definition_lines(mod):
    """Lines of the top-level statements that only define things (def, class, import, a docstring): not steps worth showing in a script."""
    lines = set()
    for n in mod.body:
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Import, ast.ImportFrom)) or (
                isinstance(n, ast.Expr) and isinstance(n.value, ast.Constant) and isinstance(n.value.value, str)):
            lines.add(n.lineno)
            lines.update(d.lineno for d in getattr(n, "decorator_list", []))
    return lines


def is_script(code):
    """True when the code runs something by itself (no functions at all, or its top level calls its own functions or classes), so its top
    level is traced; False when it only defines things for an input to call."""
    try:
        mod = ast.parse(code)
    except SyntaxError:
        return True  # trace() reports the error
    defs = [n for n in mod.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))]
    own = {n.name for n in defs}
    rest = [n for n in mod.body if n not in defs]
    return not defs or any(isinstance(c, ast.Call) and isinstance(c.func, ast.Name) and c.func.id in own for n in rest for c in ast.walk(n))


def target_of(node):  # nums or self.nums
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id == "self":
        return "self." + node.attr
    return None


OPS = {ast.Add: "+", ast.Sub: "-", ast.Mult: "*", ast.FloorDiv: "//", ast.Mod: "%"}


def expr(node):
    """A small arithmetic expression the visualizer can work out itself: ["+", ["n", "target"], ["c", 1]] (or None)."""
    if isinstance(node, ast.Name):
        return ["n", node.id]
    if isinstance(node, ast.Constant) and isinstance(node.value, int) and not isinstance(node.value, bool):
        return ["c", node.value]
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
        # Simplify -constant to a negative constant
        if isinstance(node.operand, ast.Constant) and isinstance(node.operand.value, int):
            return ["c", -node.operand.value]
        inner = expr(node.operand)
        return ["neg", inner] if inner else None
    if isinstance(node, ast.BinOp) and type(node.op) in OPS:
        a, b = expr(node.left), expr(node.right)
        return [OPS[type(node.op)], a, b] if a and b else None
    # len(name): the length of a list
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "len" and len(node.args) == 1:
        if isinstance(node.args[0], ast.Name):
            return ["len", node.args[0].id]
    # Subscript of a list variable with a constant or negative index: temps[stack[-1]] -> ["sub", "stack", ["c", -1]]
    if isinstance(node, ast.Subscript) and not isinstance(node.slice, ast.Slice):
        if isinstance(node.value, ast.Name):
            idx = expr(node.slice)
            return ["sub", node.value.id, idx] if idx else None
    return None


def is_arithmetic(e):
    """Whether an expression is made of numbers and names only: no item of a list (nums[(lo + hi) // 2] is a value, not a place) and no
    length. Any operator counts, so a midpoint written with >> or a floor still does."""
    if not isinstance(e, list) or not e:
        return True
    if e[0] in ("sub", "len"):
        return False
    return e[0] in ("n", "c") or all(is_arithmetic(x) for x in e[1:] if isinstance(x, list))


# ---------------------------------------------------------------- the values an if / while compares
def constant(n):
    return isinstance(n, ast.Constant) or (isinstance(n, ast.UnaryOp) and isinstance(n.operand, ast.Constant))


def operands(test):
    """The parts of a condition whose values explain it: each side of a comparison, each part of an and / or (constants say themselves)."""
    if isinstance(test, ast.BoolOp):
        return [o for v in test.values for o in operands(v)]
    if isinstance(test, ast.UnaryOp) and isinstance(test.op, ast.Not):
        return operands(test.operand)
    if isinstance(test, ast.Compare):
        return [x for x in [test.left, *test.comparators] if not constant(x)]
    return [] if constant(test) else [test]


def operand_info(n):
    """What an operand reads, so the visualizer can mark it: a variable ({"on"}), a list's item ({"on", "ix"}) or a grid's cell ({"on", "rc"})."""
    if target_of(n):
        return {"on": target_of(n)}
    if isinstance(n, ast.Subscript) and not isinstance(n.slice, ast.Slice):
        inner = n.value
        if isinstance(inner, ast.Subscript) and target_of(inner.value) and expr(inner.slice) and expr(n.slice):
            return {"on": target_of(inner.value), "rc": [expr(inner.slice), expr(n.slice)]}
        if target_of(inner) and expr(n.slice):
            return {"on": target_of(inner), "ix": expr(n.slice)}
    return {}


def conditions(code, mod):
    """Rewrites each one-line if / elif / while test of `mod` so the run reports what it compared: each operand goes through
    __vz_op__(id, i, value), the whole test through __vz_test__(id, value). Returns the table the visualizer reads:
    [{"line", "kind", "t": the test's text, "ops": [{"a", "b": where in t, ...operand_info}]}]."""
    src = code.split("\n")
    table = []

    def chars(line, col):  # ast's columns count UTF-8 bytes
        return len(src[line - 1].encode()[:col].decode(errors="ignore"))

    def call(name, args, at):
        return ast.copy_location(ast.Call(func=ast.Name(name, ast.Load()), args=args, keywords=[]), at)

    elifs = {id(s.orelse[0]) for s in ast.walk(mod) if isinstance(s, ast.If) and len(s.orelse) == 1 and isinstance(s.orelse[0], ast.If)}
    for s in ast.walk(mod):
        if not isinstance(s, (ast.If, ast.While)) or not (s.lineno == s.test.lineno == s.test.end_lineno):
            continue
        test, line, cid = s.test, s.lineno, len(table)
        c0 = chars(line, test.col_offset)
        kind = "while" if isinstance(s, ast.While) else "elif" if id(s) in elifs and re.match(r"\s*elif\b", src[line - 1]) else "if"
        ops = operands(test)
        table.append({"line": line, "kind": kind, "t": src[line - 1][c0:chars(line, test.end_col_offset)],
                      "ops": [{"a": chars(line, o.col_offset) - c0, "b": chars(line, o.end_col_offset) - c0, **operand_info(o)} for o in ops]})
        wrapped = {id(o): i for i, o in enumerate(ops)}

        class Wrap(ast.NodeTransformer):
            def visit(self, node):
                if id(node) in wrapped:
                    return call("__vz_op__", [ast.Constant(cid), ast.Constant(wrapped[id(node)]), node], node)
                return self.generic_visit(node)

        s.test = call("__vz_test__", [ast.Constant(cid), Wrap().visit(test)], test)
    ast.fix_missing_locations(mod)
    return table


# ---------------------------------------------------------------- encoding the program state
class Encoder:
    def __init__(self):
        self.ids = {}   # id(obj) -> small stable number
        self.keep = []  # keeps encoded objects alive, so Python can't reuse their id for a new object mid-trace

    def ref(self, o):
        k = id(o)
        if k not in self.ids:
            self.ids[k] = len(self.ids) + 1
            self.keep.append(o)
        return self.ids[k]

    def value(self, v, heap, depth=0):
        if v is None or isinstance(v, bool) or isinstance(v, int):
            return v if not isinstance(v, int) or abs(v) < 2**53 else {"x": str(v)}
        if isinstance(v, float):
            return v if math.isfinite(v) else {"x": repr(v)}
        if isinstance(v, str):
            return v if len(v) <= STR_MAX else v[:STR_MAX] + "…"
        if callable(v) or isinstance(v, type(sys)):
            return {"x": getattr(v, "__name__", type(v).__name__) + "()" if callable(v) else "module"}
        r = self.ref(v)
        if r not in heap and len(heap) < MAX_OBJECTS and depth < 12:
            heap[r] = None  # reserve first: handles cycles
            heap[r] = self.obj(v, heap, depth + 1)
        return {"r": r}

    def obj(self, v, heap, depth):
        cls = type(v).__name__
        enc = lambda x: self.value(x, heap, depth)
        if isinstance(v, (list, tuple)) or cls == "deque":
            items = list(v)
            return {"t": "deque" if cls == "deque" else ("tuple" if isinstance(v, tuple) else "list"), "v": [enc(x) for x in items[:MAX_ITEMS]], "n": len(items)}
        if isinstance(v, (set, frozenset)):
            items = list(v)
            try:
                items.sort()
            except TypeError:
                pass
            return {"t": "set", "v": [enc(x) for x in items[:MAX_ITEMS]], "n": len(items)}
        if isinstance(v, dict):
            items = list(v.items())
            return {"t": "dict", "cls": cls if cls != "dict" else "", "kv": [[enc(k), enc(x)] for k, x in items[:MAX_ITEMS]], "n": len(items)}
        if hasattr(v, "__dict__") and not isinstance(v, type):
            attrs = [[k, enc(x)] for k, x in vars(v).items() if not k.startswith("__") and not callable(x)]
            return {"t": "obj", "cls": cls, "a": attrs}
        if hasattr(v, "__slots__"):
            attrs = [[k, enc(getattr(v, k))] for k in v.__slots__ if hasattr(v, k)]
            return {"t": "obj", "cls": cls, "a": attrs}
        return {"t": "other", "cls": cls, "repr": repr(v)[:STR_MAX]}


# ---------------------------------------------------------------- tracing
def trace(code, driver, script=False, seed=0):
    """Runs `code`, then `driver` (the calls to make), and records each step inside the code's own functions. With `script`, the code's
    top level is recorded too (it runs by itself), except the lines that only define things."""
    random.seed(seed)  # the same input always gives the same trace
    std = standard_names()
    ns = {**std, **HELPERS, "__name__": "__main__"}
    out = io.StringIO()
    steps, enc, frames = [], Encoder(), {}
    result = {"steps": steps, "error": None, "truncated": False, "result": None}

    def fid(frame):
        k = id(frame)
        if k not in frames:
            frames[k] = len(frames) + 1
            enc.keep.append(frame)
        return frames[k]

    def snapshot(frame, event, arg):
        if len(steps) >= MAX_STEPS:
            result["truncated"] = True
            raise TooManySteps()
        stack, f = [], frame
        while f is not None:
            if f.f_code.co_filename == "<solution>":
                stack.append(f)
            f = f.f_back
        stack.reverse()
        heap, out_frames = {}, []
        for f in stack:
            loc = []
            for name, v in f.f_locals.items():
                if name.startswith("__") or isinstance(v, type) or type(v).__name__ == "module":
                    continue
                if (name in std and std[name] is v) or (name in HELPERS and HELPERS[name] is v):
                    continue  # a name the tracer provides (heapq, deque, tree() ...), not a variable of the code (which may be called graph)
                if callable(v) and not isinstance(v, (list, dict, set, tuple)) and (
                        hasattr(v, "__code__") or hasattr(v, "__wrapped__") or isinstance(v, types.BuiltinFunctionType)):
                    continue  # functions (nested helpers, @cache'd ones, imported builtins)
                loc.append([name, enc.value(v, heap)])
            out_frames.append({"fn": f.f_code.co_name, "id": fid(f), "line": f.f_lineno, "loc": loc})
        step = {"ev": event, "line": frame.f_lineno, "stack": out_frames, "heap": heap}
        if event == "call":  # the parameter names (f_locals also holds a closure's outer variables), for the call tree's labels
            c = frame.f_code
            n = c.co_argcount + c.co_kwonlyargcount + bool(c.co_flags & 4) + bool(c.co_flags & 8)
            step["params"] = list(c.co_varnames[:n])
        if event == "return":
            step["ret"] = enc.value(arg, heap)
        if event == "exception":
            step["exc"] = f"{arg[0].__name__}: {arg[1]}"[:200]
        text = out.getvalue()
        if text and (not steps or steps[-1].get("out_len") != len(text)):
            step["out"] = text[-2000:]
        step["out_len"] = len(text)
        steps.append(step)

    raising = set()  # frames that just raised: their next "return" is the exception leaving them, not a real return
    pending = {}  # id(frame) -> the step of the if / while line it is testing (the values it compares go there)
    busy = []  # set while the tracer works inside the code's call: code it runs then (a __repr__, an __eq__) isn't a step

    def cond_operand(cid, i, v):
        s = pending.get(id(sys._getframe(1)))
        if s is not None and s["cond"]["k"] == cid:
            busy.append(1)
            try:
                s["cond"]["o"].append([i, enc.value(v, s["heap"])])
            except Exception:
                pass
            finally:
                busy.pop()
        return v

    def cond_test(cid, v):
        f = id(sys._getframe(1))
        s = pending.get(f)
        if s is not None and s["cond"]["k"] == cid:
            del pending[f]
            busy.append(1)
            try:
                s["cond"]["v"] = bool(v)
            except Exception:
                pass
            finally:
                busy.pop()
        return v

    def local(frame, event, arg):
        if event == "exception":
            raising.add(id(frame))
        elif event == "line":
            raising.discard(id(frame))  # the exception was caught
        elif event == "return" and id(frame) in raising:
            raising.discard(id(frame))
            pending.pop(id(frame), None)
            return local
        if event == "line" and frame.f_lineno in quiet and frame.f_code.co_name == "<module>":
            return local
        if event in ("line", "return", "exception"):
            snapshot(frame, event, arg)
        if event == "line" and frame.f_lineno in cond_at:
            steps[-1]["cond"] = {"k": cond_at[frame.f_lineno], "o": [], "v": None}
            pending[id(frame)] = steps[-1]
        elif event == "return":
            pending.pop(id(frame), None)
        return local

    def glob(frame, event, arg):
        c = frame.f_code
        if c.co_filename != "<solution>" or (c.co_name != "<module>" and not c.co_flags & CO_NEWLOCALS) or busy:
            return None  # not the code's own, or a class body
        snapshot(frame, "call", None)
        return local

    try:
        compiled = compile(code, "<solution>", "exec")
    except SyntaxError as e:
        result["error"] = f"The code doesn't run: SyntaxError (line {e.lineno}): {e.msg}"
        return result
    try:
        mod = ast.parse(code)
        result["conds"] = conditions(code, mod)
        compiled = compile(mod, "<solution>", "exec")
    except Exception:  # (the code as written still runs; its conditions just aren't explained)
        result["conds"] = []
    cond_at = {c["line"]: k for k, c in enumerate(result["conds"])}
    ns["__vz_op__"], ns["__vz_test__"] = cond_operand, cond_test
    quiet = definition_lines(ast.parse(code)) if script else set()
    try:
        tree_ = ast.parse(driver, "<input>")
    except SyntaxError as e:
        result["error"] = f"The input isn't valid Python (line {e.lineno}): {e.msg}"
        return result
    if tree_.body and isinstance(tree_.body[-1], ast.Expr):  # show the value of the last line
        tree_.body[-1] = ast.Assign(targets=[ast.Name("__result__", ast.Store())], value=tree_.body[-1].value)
        ast.fix_missing_locations(tree_)
    old_out = sys.stdout
    sys.stdout = out
    try:
        if not script:  # the code only defines things: run it as is, then trace the input's calls
            try:
                exec(compiled, ns)
            except Exception as e:
                result["error"] = f"The code doesn't run: {type(e).__name__}: {e}"[:300]
                return result
        sys.settrace(glob)
        if script:
            exec(compiled, ns)
        exec(compile(tree_, "<input>", "exec"), ns)
    except TooManySteps:
        pass
    except SystemExit:
        pass  # sys.exit(): the program ended
    except Exception as e:
        result["error"] = f"{type(e).__name__}: {e}"[:300]
    finally:
        sys.settrace(None)
        sys.stdout = old_out
    if "__result__" in ns:
        heap = {}
        result["result"] = {"v": enc.value(ns["__result__"], heap), "heap": heap}
    result["out"] = out.getvalue()[-4000:]
    for s in steps:
        s.pop("out_len", None)
    return result


# ---------------------------------------------------------------- which variables index which lists (static, from the code)
def own_statements(fn):
    """The statements of a function (or of the top level), not those of the functions and classes defined in it."""
    todo = list(fn.body)
    while todo:
        s = todo.pop()
        if isinstance(s, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        yield s
        for c in ast.iter_child_nodes(s):
            todo.extend([c] if isinstance(c, ast.stmt) else c.body if isinstance(c, (ast.ExceptHandler, ast.match_case)) else [])


def statement_parts(s, sure=False):
    """The expressions of a statement itself (an if's test, an assignment's sides), not those of the statements in its body or a lambda.
    `sure`: only those that always run (not the branches of `a if c else b`, nor what follows the first part of an and / or)."""
    todo = [c for c in ast.iter_child_nodes(s) if not isinstance(c, ast.stmt)]
    while todo:
        n = todo.pop()
        if isinstance(n, ast.Lambda):
            continue
        yield n
        kids = ([n.test] if isinstance(n, ast.IfExp) else n.values[:1] if isinstance(n, ast.BoolOp) else None) if sure else None
        todo.extend(c for c in (kids if kids is not None else ast.iter_child_nodes(n)) if not isinstance(c, ast.stmt))


def links(fn, idx):
    """What each line reads and writes, and how variables point into each other, for the visualizer:
    "acc": [{"line", "on", "ix" | "rc", "w"}]: each item (nums[i - 1]) or cell (dp[i][j]) a line reads or writes (w), at an index the
    visualizer can work out; "iters": {v: [graph, key]}: `for v in graph[key]` (v walks over key's neighbours);
    "holds": {nums: [stack]}: a list whose items are places in nums (temps[stack[-1]], or j = stack.pop() then ans[j])."""
    acc, iters, holds, popped = [], {}, {}, {}
    for s in own_statements(fn):
        parts = list(statement_parts(s, sure=True))  # (what a line read is what surely ran)
        rows = {id(n.value) for n in parts if isinstance(n, ast.Subscript) and isinstance(n.value, ast.Subscript)}
        for n in parts:
            if not isinstance(n, ast.Subscript) or isinstance(n.slice, ast.Slice) or id(n) in rows or isinstance(n.ctx, ast.Del):
                continue
            w = isinstance(n.ctx, ast.Store)
            if isinstance(n.value, ast.Subscript) and target_of(n.value.value) and expr(n.value.slice) and expr(n.slice):
                acc.append({"line": s.lineno, "on": target_of(n.value.value), "rc": [expr(n.value.slice), expr(n.slice)], "w": w})
            elif target_of(n.value) and expr(n.slice):
                acc.append({"line": s.lineno, "on": target_of(n.value), "ix": expr(n.slice), "w": w})
        for n in statement_parts(s):  # (how lists point into each other is in all the code)
            if isinstance(n, ast.Subscript) and target_of(n.value) and isinstance(n.slice, ast.Subscript) and target_of(n.slice.value):
                holds.setdefault(target_of(n.value), set()).add(target_of(n.slice.value))
        if isinstance(s, ast.For) and isinstance(s.iter, ast.Subscript) and target_of(s.iter.value) and isinstance(s.iter.slice, ast.Name):
            first = s.target.elts[0] if isinstance(s.target, ast.Tuple) and s.target.elts else s.target
            if isinstance(first, ast.Name):
                iters[first.id] = [target_of(s.iter.value), s.iter.slice.id]
        # j = stack.pop() / q.popleft() / stack[-1]: j is an item of that list
        if isinstance(s, ast.Assign) and len(s.targets) == 1 and isinstance(s.targets[0], ast.Name):
            v = s.value
            if isinstance(v, ast.Call) and isinstance(v.func, ast.Attribute) and v.func.attr in ("pop", "popleft") and target_of(v.func.value):
                popped[s.targets[0].id] = target_of(v.func.value)
            elif isinstance(v, ast.Subscript) and target_of(v.value) and isinstance(v.slice, (ast.Constant, ast.UnaryOp)):
                popped[s.targets[0].id] = target_of(v.value)
    for on, names in idx.items():
        for x in names:
            if x in popped and popped[x] != on:
                holds.setdefault(on, set()).add(popped[x])
    return {"acc": acc, "iters": iters, "holds": {k: sorted(v) for k, v in holds.items()}}


def analyse(code):
    """{function: {"idx": {list: [index variables]}, "keys": {dict: [key variables]}, "grid": {grid: [[row variables], [column variables]]}}}"""
    out = {}
    try:
        mod = ast.parse(code)
    except SyntaxError:
        return out

    def names(node):
        return {n.id for n in ast.walk(node) if isinstance(n, ast.Name)}

    # the top level of a script is analysed like a function named <module> (the name of its frame)
    top = ast.Module(body=[n for n in mod.body if not isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))], type_ignores=[])
    scopes = [("<module>", top)] + [(fn.name, fn) for fn in ast.walk(mod) if isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef))]
    usage = {}  # scope -> (calls, heaps, inplace, swaps), classified at the end
    for scope, fn in scopes:
        idx, grid, keys, probes = {}, {}, {}, []
        derived = {}  # a midpoint, mid = (lo + hi) // 2: mid -> {lo, hi}
        calls = {}  # variable -> method names called on it (append, pop() / pop(0), popleft ...)
        heaps, bits, inplace, swaps = set(), set(), set(), set()
        HEAP_FUNCS = {"heappush", "heappop", "heapify", "heappushpop", "heapreplace"}
        BIT_OPS = (ast.BitAnd, ast.BitOr, ast.BitXor, ast.LShift, ast.RShift)
        for n in ast.walk(fn):
            if isinstance(n, ast.Subscript):
                if isinstance(n.value, ast.Subscript) and target_of(n.value.value):
                    g = target_of(n.value.value)
                    rows, cols = grid.setdefault(g, [set(), set()])
                    rows |= {n.value.slice.id} if isinstance(n.value.slice, ast.Name) else set()
                    cols |= {n.slice.id} if isinstance(n.slice, ast.Name) else set()
                elif target_of(n.value) and isinstance(n.slice, ast.Name):  # nums[i] / seen[x]: an exact index or key
                    idx.setdefault(target_of(n.value), set()).add(n.slice.id)
                    keys.setdefault(target_of(n.value), set()).add(n.slice.id)
                elif target_of(n.value) and isinstance(n.slice, ast.Slice):  # nums[lo:hi]
                    bounds = [b for b in (n.slice.lower, n.slice.upper) if isinstance(b, ast.Name)]
                    idx.setdefault(target_of(n.value), set()).update(b.id for b in bounds)
                elif target_of(n.value) and not isinstance(n.slice, (ast.Slice, ast.Name, ast.Constant)):
                    # nums[(lo + hi) // 2]: lo and hi are index variables (complex expression)
                    idx.setdefault(target_of(n.value), set()).update(names(n.slice))
            # how a variable is used decides its picture: a heap, a stack or a queue, bits, an array sorted in place
            if isinstance(n, ast.Call):
                f = n.func
                name = f.attr if isinstance(f, ast.Attribute) else f.id if isinstance(f, ast.Name) else None
                if name in HEAP_FUNCS and n.args and target_of(n.args[0]):
                    heaps.add(target_of(n.args[0]))
                if isinstance(f, ast.Attribute) and target_of(f.value):
                    m = f.attr
                    if m == "pop":
                        m = "pop()" if not n.args else ("pop(0)" if isinstance(n.args[0], ast.Constant) and n.args[0].value == 0 else "pop(i)")
                    calls.setdefault(target_of(f.value), set()).add(m)
            if isinstance(n, ast.BinOp) and isinstance(n.op, BIT_OPS):  # (the right side of a shift is a count, not bits)
                bits |= {x.id for x in ([n.left] if isinstance(n.op, (ast.LShift, ast.RShift)) else [n.left, n.right]) if isinstance(x, ast.Name)}
            if isinstance(n, ast.AugAssign) and isinstance(n.op, BIT_OPS) and isinstance(n.target, ast.Name):
                bits.add(n.target.id)
            if isinstance(n, ast.UnaryOp) and isinstance(n.op, ast.Invert) and isinstance(n.operand, ast.Name):
                bits.add(n.operand.id)
            e = expr(n.value) if isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name) else None
            if (e and is_arithmetic(e)
                    and any(isinstance(x, ast.BinOp) and isinstance(x.op, ast.FloorDiv) for x in ast.walk(n.value))):
                # only midpoints: in j = i + k, k is a size, not a place; excludes pivot = nums[(lo + hi) // 2]
                derived.setdefault(n.targets[0].id, set()).update(names(n.value) - {n.targets[0].id})
            # n = len(array): n is the length of array, so it's an index/pointer (used as upper bound)
            if (isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name)
                    and isinstance(n.value, ast.Call) and isinstance(n.value.func, ast.Name)
                    and n.value.func.id == "len" and len(n.value.args) == 1 and target_of(n.value.args[0])):
                idx.setdefault(target_of(n.value.args[0]), set()).add(n.targets[0].id)
            if isinstance(n, ast.Assign) and isinstance(n.targets[0], ast.Tuple):  # a[i], a[j] = a[j], a[i]: elements swapped in place
                subs = [target_of(e.value) for e in n.targets[0].elts if isinstance(e, ast.Subscript)]
                swaps |= {v for v in subs if v and subs.count(v) >= 2}
            for t in (n.targets if isinstance(n, ast.Assign) else [n.target] if isinstance(n, ast.AugAssign) else []):
                for e in (t.elts if isinstance(t, ast.Tuple) else [t]):
                    if isinstance(e, ast.Subscript) and target_of(e.value) and not isinstance(e.value, ast.Subscript):
                        inplace.add(target_of(e.value))
            # lookups the visualizer can show on the line that does them: nums[i + 1], seen[target - x], x in seen
            if isinstance(n, ast.Subscript) and target_of(n.value) and not isinstance(n.slice, (ast.Slice, ast.Name, ast.Constant)) and expr(n.slice):
                probes.append({"on": target_of(n.value), "line": n.lineno, "e": expr(n.slice), "text": ast.get_source_segment(code, n.slice) or "", "kind": "get"})
            if isinstance(n, ast.Compare) and len(n.ops) == 1 and isinstance(n.ops[0], (ast.In, ast.NotIn)) and target_of(n.comparators[0]) and expr(n.left):
                probes.append({"on": target_of(n.comparators[0]), "line": n.lineno, "e": expr(n.left), "text": ast.get_source_segment(code, n.left) or "", "kind": "in"})
            if isinstance(n, (ast.For, ast.comprehension)) and isinstance(n.iter, ast.Call) and isinstance(n.iter.func, ast.Name):
                tgt = n.target.elts[0] if isinstance(n.target, ast.Tuple) and n.target.elts else n.target
                if not isinstance(tgt, ast.Name):
                    continue
                f, args = n.iter.func.id, n.iter.args
                if f == "enumerate" and args and target_of(args[0]):
                    idx.setdefault(target_of(args[0]), set()).add(tgt.id)
                if f == "range":  # for i in range(len(nums)) / range(k, len(nums)): i walks over nums
                    for a in args:
                        if isinstance(a, ast.Call) and isinstance(a.func, ast.Name) and a.func.id == "len" and a.args and target_of(a.args[0]):
                            idx.setdefault(target_of(a.args[0]), set()).add(tgt.id)
        for v in idx.values():  # an index worked out from other numbers (mid from lo and hi) makes them pointers into that list too
            v.update(*(derived.get(x, set()) for x in list(v)))
        out[scope] = {
            "idx": {k: sorted(v) for k, v in idx.items()},
            "keys": {k: sorted(v) for k, v in keys.items()},
            "grid": {k: [sorted(r), sorted(c)] for k, (r, c) in grid.items()},
            "probes": probes,
            "bits": sorted(bits),
            **links(fn, idx),
        }
        usage[scope] = (calls, heaps, inplace, swaps)
    # a class's attributes are used across its methods (push appends to self.stack, pop pops it): their usage is pooled
    pooled, pooled_heaps = {}, set()
    for calls, heaps, _, _ in usage.values():
        for v, m in calls.items():
            if v.startswith("self."):
                pooled.setdefault(v, set()).update(m)
        pooled_heaps |= {v for v in heaps if v.startswith("self.")}
    for scope, (calls, heaps, inplace, swaps) in usage.items():
        calls, heaps = {**calls, **pooled}, heaps | pooled_heaps
        out[scope].update(
            heaps=sorted(heaps),
            stacks=sorted(v for v, m in calls.items() if "pop()" in m and "append" in m and v not in heaps and not m & {"popleft", "pop(0)", "appendleft"}),
            queues=sorted(v for v, m in calls.items() if m & {"popleft", "pop(0)", "appendleft"}),
            inplace=sorted(inplace - heaps),
            swaps=sorted(swaps - heaps),
        )
    return out


# ---------------------------------------------------------------- a starting input
LITERAL = r"(\[(?:[^\[\]]|\[(?:[^\[\]]|\[[^\[\]]*\])*\])*\]|\{[^{}]*\}|\"[^\"]*\"|'[^']*'|-?\d+(?:\.\d+)?|True|False|None)"
NODE_LIST = ("head", "l1", "l2", "list1", "list2", "headA", "headB")
DEFAULTS = [
    (r"^(nums|arr|array|a|b|values|vals|heights|height|prices|weights|piles|sticks|stones|cost|costs|ratings|temperatures|data|xs|seq)$", "[5, 2, 8, 1, 9, 3]"),
    (r"^(coins)$", "[1, 2, 5]"),
    (r"^(strs|words|wordList|dictionary|tokens)$", '["eat", "tea", "tan", "ate", "nat", "bat"]'),
    (r"^(s|t|text|word|string|str1|str2|pat|pattern|p|txt|w)$", '"abcabcbb"'),
    (r"^(grid|board|matrix|mat|g2|maze|image)$", "[[1, 1, 0, 0], [1, 0, 0, 1], [0, 0, 1, 1]]"),
    (r"^(edges|connections|roads|flights|times|prerequisites|pairs)$", "[[0, 1], [0, 2], [1, 3], [2, 3], [3, 4]]"),
    (r"^(adj|graph|g|neighbors)$", "{0: [1, 2], 1: [0, 3], 2: [0, 3], 3: [1, 2]}"),
    (r"^(intervals|points|queries|positions|updates|ranges|meetings|events|ops)$", "[[1, 3], [2, 6], [8, 10], [15, 18]]"),
    (r"^(root|tree)$", "tree([4, 2, 6, 1, 3, 5, 7])"),
    (r"^(head|l1|l2|list1|list2|headA|headB|lst)$", "linked([1, 2, 3, 4, 5])"),
    (r"^(mod|MOD|M)$", "1_000_000_007"),
    (r"^(amount)$", "11"),
    (r"^(target)$", "9"),
    (r"^(k|K)$", "2"),
    (r"^(n|N|m|size|length|num|x|y|c|h|limit|capacity|cap)$", "5"),
    (r"^(key|val|value|v|start|src|source|dst|end|goal|lo|hi|left|right)$", "1"),
]


SECOND = {"[5, 2, 8, 1, 9, 3]": "[2, 8, 3, 7]", '"abcabcbb"': '"abcbdab"', "5": "3", "linked([1, 2, 3, 4, 5])": "linked([1, 3, 4])"}
KIND_DEFAULT = {
    "linked": "linked([1, 2, 3, 4, 5])",
    "tree": "tree([4, 2, 6, 1, 3, 5, 7])",
    "graph": "graph({1: [2, 4], 2: [1, 3], 3: [2, 4], 4: [1, 3]})",
    "grid": "[[1, 1, 0, 0], [1, 0, 0, 1], [0, 0, 1, 1]]",
    "pairs": "[[1, 3], [2, 6], [8, 10], [15, 18]]",
    "lists": "[[1, 4, 5], [1, 3, 4], [2, 6]]",
    "str": '"abcabcbb"',
    "strs": '["eat", "tea", "tan", "ate", "nat", "bat"]',
    "dict": "{0: [1, 2], 1: [0, 3], 2: [0, 3], 3: [1, 2]}",
    "list": "[5, 2, 8, 1, 9, 3]",
    "int": "5",
}
STR_METHODS = {"split", "lower", "upper", "strip", "isalpha", "isdigit", "isalnum", "startswith", "endswith", "find", "replace", "count", "join", "isspace", "islower", "isupper"}


def kind_of(fn, name):
    """What a parameter must be, from how the function uses it (static, from the code): 'linked', 'tree', 'grid', ... or None."""
    attrs, seen = set(), set()
    for n in ast.walk(fn):
        if isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name) and n.value.id == name:
            attrs.add(n.attr)
        if isinstance(n, ast.Subscript) and isinstance(n.value, ast.Subscript) and isinstance(n.value.value, ast.Name) and n.value.value.id == name:
            seen.add("grid")
        if isinstance(n, ast.Subscript) and isinstance(n.value, ast.Name) and n.value.id == name:
            seen.add("index")
        if isinstance(n, (ast.For, ast.comprehension)) and isinstance(n.iter, ast.Name) and n.iter.id == name:
            seen.add("pairs" if isinstance(n.target, ast.Tuple) else "iter")
            inner = [m for m in ast.walk(n) if isinstance(m, (ast.For, ast.comprehension)) and isinstance(m.iter, ast.Name) and isinstance(n.target, ast.Name) and m.iter.id == n.target.id]
            if inner:
                seen.add("lists")
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and any(isinstance(a, ast.Name) and a.id == name for a in n.args):
            seen.add("call:" + n.func.id)
        if isinstance(n, ast.BinOp) and any(isinstance(x, ast.Name) and x.id == name for x in (n.left, n.right)):
            other = n.right if isinstance(n.left, ast.Name) and n.left.id == name else n.left
            if isinstance(other, ast.Constant) and isinstance(other.value, int):
                seen.add("int")
        if isinstance(n, ast.Compare) and any(isinstance(x, ast.Name) and x.id == name for x in [n.left, *n.comparators]):
            if any(isinstance(x, ast.Constant) and isinstance(x.value, int) and not isinstance(x.value, bool) for x in [n.left, *n.comparators]):
                seen.add("int")
    if "neighbors" in attrs:
        return "graph"
    if attrs & {"left", "right"}:
        return "tree"
    if attrs & {"next", "random"}:
        return "linked"
    if "val" in attrs:
        return "tree"
    if attrs & STR_METHODS:
        return "str"
    if attrs & {"items", "keys", "values", "get"}:
        return "dict"
    if "grid" in seen:
        return "grid"
    if "pairs" in seen:
        return "pairs"
    if "lists" in seen:
        return "lists"
    if "call:range" in seen or ("int" in seen and not seen & {"index", "iter", "call:len", "call:sorted"}):
        return "int"
    if seen & {"index", "iter", "call:len", "call:sorted", "call:sum", "call:max", "call:min", "call:set", "call:enumerate", "call:Counter", "call:heapify", "call:list"} or attrs & {"append", "sort", "pop"}:
        return "list"
    return None


def default_for(name):
    for pattern, value in DEFAULTS:
        if re.match(pattern, name):
            return value
    return "3"


def entry_point(mod, every=False):
    """The function an input calls: (function, "Solution()." or "", its parameters without self and those with a default), or None
    when the code only defines classes. Of several, the last one no other calls (the others are its helpers). `every`: all of them, that
    one first (a test case's names or number of values can tell which it's for)."""
    fns = [n for n in mod.body if isinstance(n, ast.FunctionDef)]
    prefix, skip = "", 0
    sol = next((c for c in mod.body if isinstance(c, ast.ClassDef) and c.name == "Solution"), None)
    if not fns and sol:  # LeetCode style: the methods of class Solution are the functions to call
        fns = [m for m in sol.body if isinstance(m, ast.FunctionDef) and not m.name.startswith("_")]
        prefix, skip = "Solution().", 1
    if not fns:
        return None
    called = {n.func.id for n in ast.walk(mod) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)}
    called |= {n.func.attr for n in ast.walk(mod) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
               and isinstance(n.func.value, ast.Name) and n.func.value.id == "self"}  # helpers a method calls as self.helper()
    f = ([f for f in fns if f.name not in called] or fns)[-1]

    def shape(f):
        required = len(f.args.args) - len(f.args.defaults)  # parameters with a default value are left to their default
        return f, prefix, [a.arg for a in f.args.args[skip:required]]

    return [shape(f)] + [shape(g) for g in fns if g is not f] if every else shape(f)


def design_classes(mod):
    """The classes a design problem's calls are made on (not the node classes LeetCode defines for you)."""
    return [c for c in mod.body if isinstance(c, ast.ClassDef) and c.name not in ("Node", "ListNode", "TreeNode", "Solution")]


def node_kind(fn, name):
    """What LeetCode builds for a parameter from a list: "linked" (ListNode), "tree" (TreeNode, level order), "graph" (Node with
    neighbours, from an adjacency list), the same with [] for a list of them (List[ListNode]), or None for a plain value. From the type
    hint, else a docstring's `:type head: ListNode`, else how the function uses it."""
    arg = next((a for a in fn.args.args if a.arg == name), None)
    hint = ast.unparse(arg.annotation) if arg is not None and arg.annotation is not None else ""
    if not hint:
        m = re.search(rf":type\s+{re.escape(name)}\s*:\s*(.+)", ast.get_docstring(fn) or "")
        hint = m.group(1).strip() if m else ""
    many = re.match(r"(typing\.)?(List|list|Sequence)\s*\[", hint) is not None
    usage = kind_of(fn, name)
    if "ListNode" in hint:
        base = "linked"
    elif "TreeNode" in hint:
        base = "tree"
    elif re.search(r"\bNode\b", hint) or not hint:
        base = usage if usage in ("linked", "tree", "graph") else None
    else:
        base = None
    return base and base + ("[]" if many else "")


def signature(code):
    """What a LeetCode test case is turned into a call with: {"entries": [{"call": "Solution().twoSum", "params": [{"name", "kind"}]}]
    (the function an input calls first, then the others), "classes": {name: {"init": [params], "methods": {name: [params]}}}} (kind: see
    node_kind)."""
    try:
        mod = ast.parse(code)
    except SyntaxError as e:
        return {"entries": [], "classes": {}, "error": f"The code doesn't run: SyntaxError (line {e.lineno}): {e.msg}"}

    def params(fn, names):
        return [{"name": p, "kind": node_kind(fn, p)} for p in names]

    out = {"entries": [{"call": prefix + f.name, "params": params(f, names)} for f, prefix, names in entry_point(mod, True) or []],
           "classes": {}}
    for c in design_classes(mod):
        ms = [m for m in c.body if isinstance(m, ast.FunctionDef)]
        init = next((m for m in ms if m.name == "__init__"), None)
        out["classes"][c.name] = {
            "init": params(init, [a.arg for a in init.args.args[1:]]) if init else [],
            "methods": {m.name: params(m, [a.arg for a in m.args.args[1:]]) for m in ms if not m.name.startswith("_")},
        }
    return out


def suggest(code, text):
    """A first input for the visualizer: values from the problem text when it names them (nums=[2,7,11,15]), else simple defaults by name.
    Returns {"driver": python, "guessed": [names that got a default]}."""
    try:
        mod = ast.parse(code)
    except SyntaxError:
        return {"driver": "", "guessed": []}
    entry = entry_point(mod)
    text = text or ""
    chains = [c for c in re.findall(r"\d+(?:\s*->\s*-?\d+)+", text)]
    guessed = []

    def arg(name, fn=None):
        m = re.search(rf"(?<![\w.]){re.escape(name)}\s*=\s*{LITERAL}", text)
        if m:
            try:
                ast.literal_eval(m.group(1))
                return m.group(1)
            except Exception:
                pass
        if name in NODE_LIST or re.match(r"^(head|l1|l2|list1|list2|a|b)$", name):
            m = re.search(rf"(?<![\w.]){re.escape(name)}\s*=\s*(-?\d+(?:\s*->\s*-?\d+)+)", text)
            if m:
                return "linked([" + ", ".join(re.findall(r"-?\d+", m.group(1))) + "])"
        guessed.append(name)
        by_name = default_for(name)
        kind = kind_of(fn, name) if fn is not None else None
        if kind is None:
            return by_name
        # the name's default wins when it already has the right shape (nums -> a list, s -> a string, edges -> pairs ...)
        fits = {"list": by_name.startswith("[") and not by_name.startswith("[["), "str": by_name.startswith('"'),
                "pairs": by_name.startswith("[["), "grid": by_name.startswith("[["), "lists": by_name.startswith("[["),
                "int": re.fullmatch(r"[\d_]+", by_name) is not None, "dict": by_name.startswith("{"),
                "tree": by_name.startswith("tree"), "linked": by_name.startswith("linked"), "graph": by_name.startswith("graph")}
        if name in ("strs", "words", "wordList", "dictionary", "tokens"):
            return by_name
        if by_name.startswith("[[") and kind in ("list", "pairs", "grid", "lists"):  # a 2D default is also a list
            return by_name
        return by_name if fits.get(kind) else KIND_DEFAULT[kind]

    if entry:
        f, prefix, params = entry
        # a list-like parameter that the text shows as a chain (1->3->5) is a linked list
        uses_next = any(isinstance(n, ast.Attribute) and n.attr == "next" for n in ast.walk(f))
        values = []
        for i, p in enumerate(params):
            v = arg(p, f)
            if uses_next and p in guessed and chains:
                v = "linked([" + ", ".join(re.findall(r"-?\d+", chains.pop(0))) + "])"
                guessed.remove(p)
            elif uses_next and p in guessed and re.match(r"^(a|b)$", p):
                v = "linked([1, 3, 5])" if p == "a" else "linked([2, 4, 6])"
            if p in guessed and any(x.endswith("=" + v) for x in values):  # two inputs that default to the same value: make them differ
                v = SECOND.get(v, v)
            values.append(f"{p}={v}")
        return {"driver": f"{prefix}{f.name}({', '.join(values)})", "guessed": guessed}

    classes = design_classes(mod)
    if not classes:
        return {"driver": "", "guessed": []}
    c = classes[-1]
    methods = [m for m in c.body if isinstance(m, ast.FunctionDef)]
    init = next((m for m in methods if m.name == "__init__"), None)
    init_args = ", ".join(arg(a.arg, init) for a in (init.args.args[1:] if init else []))
    lines = [f"obj = {c.name}({init_args})"]
    ADDS = re.compile(r"^(insert|push|put|add|set|append|enqueue|offer|update|record|hit|post|addWord|addNum|write|book|follow|visit|store|inc)", re.I)
    public = [m for m in methods if not m.name.startswith("_")]
    order = [m for m in public if ADDS.match(m.name)] + [m for m in public if not ADDS.match(m.name)]
    for m in order:
        reps = 3 if ADDS.match(m.name) else 2
        for rep in range(reps):
            vals = []
            for i, a in enumerate(m.args.args[1:]):
                k = kind_of(m, a.arg)
                if k in (None, "int"):
                    vals.append(str((rep + 1) * (i + 1) if i else rep + 1))
                elif k == "str":
                    vals.append(repr(["apple", "app", "apply"][rep % 3]))
                else:
                    vals.append(KIND_DEFAULT[k])
            lines.append(f"obj.{m.name}({', '.join(vals)})")
    guessed.append("operations")
    return {"driver": "\n".join(lines[:12]), "guessed": guessed}


# ---------------------------------------------------------------- the code as a tree of statements
KIND = {"FunctionDef": "def", "AsyncFunctionDef": "def", "ClassDef": "class", "AugAssign": "assign", "AnnAssign": "assign",
        "ImportFrom": "import", "Delete": "del", "ExceptHandler": "except"}


def outline(code):
    """[{"t": kind, "l": first line, "e": last line, "c": [children]}] for each statement (the label is the code's own line, so it isn't
    sent). elif / else / except / finally are siblings of their if / for / try, as in the source."""
    try:
        mod = ast.parse(code)
    except SyntaxError:
        return []
    src = code.split("\n")

    def keyword_line(word, stmts, owner):  # the AST keeps no node for "else:" / "finally:": find it above the block's first statement
        for ln in range(stmts[0].lineno, owner.lineno, -1):
            if re.match(rf"\s*{word}\b", src[ln - 1]):
                return ln
        return stmts[0].lineno

    def node(s, kind=None):
        body = getattr(s, "body", [])
        item = {"t": kind or KIND.get(type(s).__name__, type(s).__name__.lower()), "l": s.lineno, "e": (body[-1] if body else s).end_lineno,
                "c": block(body)}
        if isinstance(s, ast.Match):
            item["c"] = [{"t": "case", "l": c.pattern.lineno, "e": c.body[-1].end_lineno, "c": block(c.body)} for c in s.cases]
        out = [item]
        for h in getattr(s, "handlers", []):
            out += node(h)
        orelse = getattr(s, "orelse", [])
        if isinstance(s, ast.If) and len(orelse) == 1 and isinstance(orelse[0], ast.If) and re.match(r"\s*elif\b", src[orelse[0].lineno - 1]):
            out += node(orelse[0], "elif")
        elif orelse:
            out.append({"t": "else", "l": keyword_line("else", orelse, s), "e": orelse[-1].end_lineno, "c": block(orelse)})
        if getattr(s, "finalbody", []):
            out.append({"t": "finally", "l": keyword_line("finally", s.finalbody, s), "e": s.finalbody[-1].end_lineno, "c": block(s.finalbody)})
        return out

    def block(stmts):
        return [n for s in stmts for n in node(s)]

    return block(mod.body)


def run(code, driver, text, mode):
    if mode == "suggest":
        return json.dumps(suggest(code, text))
    if mode == "signature":
        return json.dumps(signature(code))
    script, guessed = False, []
    if not driver.strip():  # no input: a script runs by itself; code that only defines functions gets a suggested call
        script = is_script(code)
        if not script:
            sug = suggest(code, text)
            driver, guessed = sug["driver"], sug["guessed"]
    r = trace(code, driver, script)
    r.update(pointers=analyse(code), outline=outline(code), driver=driver, guessed=guessed, script=script)
    return json.dumps(r)
