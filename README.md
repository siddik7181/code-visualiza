# Visualiza

A Chrome extension that explains Python and JavaScript code by running it step by step. Select code on any page (a tutorial, Stack
Overflow, GitHub, a LeetCode solution), right-click, choose **Explain this with Visualiza**, and the side panel replays it while you watch
the data change. The code really runs, inside the extension and offline (Python is CPython 3.14 via [Pyodide](https://pyodide.org);
JavaScript runs in [Sval](https://github.com/Siubaak/sval), an interpreter); nothing is sent anywhere, and no AI is involved.

## Install

`chrome://extensions` → turn on **Developer mode** → **Load unpacked** → pick the `extension/` folder. (Chrome 116 or later.)

- Select code on a page → right-click → **Explain this with Visualiza**. The language is told from the code; the menu above the editor
  switches it.
- Or click the toolbar icon: the panel opens with examples, and you can type or paste code in it. The code is always editable (editing
  clears the run; **Ctrl+Enter** runs it again), and **⌘V** / **Ctrl+V** anywhere in the panel pastes code or test cases and runs them.
- **⤢** opens the same thing in a tab, for more room (big call trees, two columns).

## What it shows

- **Data**: every frame on the call stack with its variables, each drawn by what it is and how the code uses it: arrays with their index
  pointers (and a `lo..hi` window), bars for lists sorted in place, grids (DP tables, boards), dicts, sets, linked lists, binary trees,
  graphs from adjacency lists, heaps as trees, stacks, queues, intervals on a number line, the bits of a number. The current call and its
  two callers are open; callers are indented and connected to show the call chain, with a line badge showing where each is paused (hover
  it to highlight that line in the code). Click a frame's header to open or close it. One colour marks what the line that just ran did:
  what it looked at (compared, read) is ringed, what it changed (wrote, swapped) is filled. In sorting code a bracket marks the items
  already in their sorted place. Hover a marked cell for what it means.
- **When the code recurses**, the Data view shows the tree of its calls above the current call's data: the run's map, growing as it
  plays. The calls on the stack form the path to the current one, a caller waiting on a call shows its line with what's come back so
  far (`1 + ?`), and finished calls show what they returned. A call that redoes an earlier call (same arguments, and it recurses again)
  is dashed, with how many calls a memo / cache would save. Click a call to jump to it.
- **How the structures relate**: the items and cells the line that ran read and wrote (a copied value flies from one to the other), and in
  a DP table the cells not filled yet (dashed), so `dp[a] = min(dp[a], dp[a - c] + 1)` shows where the value came from (a table over two strings has their letters
  on its rows and columns). A sliding window's `left` is drawn with `right` even when the code never indexes with it. A stack of indexes
  marks the items it holds (monotonic stack). In divide and conquer, when a call receives a slice of its caller's list, the caller's cells
  passed to the callee are marked. A graph is drawn in layers (topological, or by distance from the source when it's weighted)
  with its edge weights; its nodes show what the other variables say about them (in `seen`, waiting in the queue / heap, `dist` /
  `indegree` per node), and the neighbour the loop is on is named, with the edge to it. A grid shows a recursion's way down (the cells
  its callers are at), a visited set of `(r, c)` and a queue of them. A lookup that misses (`6 in seen` → no) is shown as a dashed row.
- **The story**: above the pictures, one sentence for the line that just ran ("`seen[2]` is `0`", "`7 < 11` is true, so the if block
  runs", "`fib` returns `2`"), under where the run is (the loop's pass, or the calls down to the current one). The line that ran is
  highlighted in the code. An error says what went wrong and why: an index out of range shows the slot it asked for (`?`) and tags the
  line that set the index up ("← j became 5 here").
- **Timeline**: the run as a bar cut into chapters (the outer loop's passes, a recursion's calls, a red piece for an error); click or
  drag to go there.
- **Code tree**: the code as a tree of statements (from the language's own parser), with the statements around the current line marked and how
  many times each one has run. Click a statement, or a line of the code, to jump to the next time it runs.

Keys: **←** / **→** step, **Home** / **End**, **space** plays. **Shift+→** steps over a line's calls (**Shift+←** back over them),
**Shift+↑** steps out to the current call's return, **Shift+↓** goes to the loop's next pass. The **⋯** menu has the same moves and the
speed.

## What it runs

Python and JavaScript, the same way:

- **A script**: the input stays empty and the code runs as is (its top level is traced; `print` / `console.log` output is shown).
- **Functions**: write the call in the input (`fib(5)`), or leave it empty and a call is suggested from the parameter names and how the code
  uses them (a LeetCode-style `var maxProfit = function (prices)` too).
- **A class**: write the calls (`s = MinStack()` / `const s = new MinStack()`, `s.push(1)`, ...). A LeetCode-style Python `class Solution`
  gets a suggested call on its method; a JavaScript class, or a design problem written with `X.prototype.m = function`, gets calls.
- **LeetCode test cases**: paste the code from LeetCode's editor as it is, and its test cases into the input as LeetCode shows them: the
  Testcase tab's values (one per line, or each under its name), a problem's examples (`Input: nums = [2,7,11,15], target = 9`,
  `Output: [0,1]`), a design problem's two lines (`["MinStack","push",...]` / `[[],[-2],...]`), or a Test Result. They become calls of
  the code's function (`null` → `None` in Python), with a list built into the `ListNode`, `TreeNode` or graph `Node` a parameter is (from
  its type hint, JSDoc or docstring, or how the code uses it). Several cases get a tab each; every case is run, and its tab is
  marked with how it came out — the answer checked against the expected one (✓, ✓ in another order, ✗), an error (⚠, with the
  message), or cut off (⋯) — so you see at a glance which input causes what, with a line naming the ones that failed and their
  reasons. Click a tab to replay that case. Code pasted for another problem clears the old test cases.
- Selected code is cleaned up first: common indentation removed (a method copied out of its class), non-breaking spaces made spaces.
- Built in, no import or definition needed: `linked([1, 2, 3])` (a linked list), `tree([3, 9, 20, None, None, 15, 7])` (a binary tree,
  level order; `null` in JavaScript), `graph({1: [2], 2: [1]})`, `ListNode`, `TreeNode`; in Python also `heapq`, `deque`, `defaultdict`,
  `Counter`, `bisect`, `math`, `List`, `Optional`, `inf` and friends.
- Limits: a run stops after 1,500 steps, and after 20 seconds (a builtin that never returns). Code selected inside some editors (Monaco,
  CodeMirror) isn't a page selection: copy it into the panel instead.
  - Python: the standard library only (no numpy); `input()` can't ask for typing, so put the value in the code.
  - JavaScript: no DOM, no `import`; generator and async functions run but show no steps of their own, and neither do one-line arrow
    callbacks passed to a call (sort comparators, `map` / `filter`), as builtins don't.

## Privacy and permissions

- `contextMenus`, `sidePanel`: the menu item and the panel.
- `activeTab`, `scripting`: read the selected text, with its line breaks, from the tab you right-clicked, only at that click (the menu's own
  copy of the selection loses line breaks, which breaks Python).
- `storage`: hand the selection to the panel (`storage.session`, cleared when the browser closes).
- The code runs in a worker inside the extension that can't reach the network (`connect-src 'self'`), so code from a page can't send
  anything anywhere.

## Files

| File                          | What it does                                                                                                                        |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `extension/manifest.json`     | The extension (Manifest V3)                                                                                                         |
| `extension/background.js`     | The menu item and toolbar button: reads the selection, opens the panel, hands the code over                                         |
| `extension/selection.js`      | The function background.js runs in the page to read the selection with its line breaks                                              |
| `extension/panel.html`, `.js` | The side panel (also a tab): takes code from the menu or the ⤢ button                                                               |
| `extension/visualizer.js`     | Replays a trace: the pictures, captions, call tree, code tree, and the player                                                       |
| `extension/tracer.py`         | Python: runs the code under `sys.settrace` and records each step (line, call, return) with the full state; finds pointers and usage |
| `extension/tracer.js`         | JavaScript: rewrites the code to report each step, runs it in Sval, and records the same trace as tracer.py                         |
| `extension/worker.js`         | Runs the tracers off the page's thread; a run that hangs is stopped by terminating the worker                                       |
| `extension/vendor/pyodide/`   | Pyodide 314.0.7 (MPL-2.0), unchanged; see its README                                                                                |
| `extension/vendor/sval/`      | Sval 0.6.12 (MIT), with three fixes to its `try` / `finally` and destructuring; see its README                                      |
| `extension/examples.js`       | The examples in the panel                                                                                                           |
| `extension/leetcode.js`       | LeetCode test cases pasted in the input: read from each way LeetCode shows them, turned into calls, results checked                 |
| `test/`                       | The tests (below)                                                                                                                   |

## Development

`npm install` once, then:

| Command               | What it does                                                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run format`      | Prettier: rewrites files to the project style (`format:check` only checks)                                                                     |
| `npm run lint`        | ESLint: unused variables, `==`, `let` that should be `const`, and other likely bugs                                                            |
| `npm run typecheck`   | TypeScript checks the JavaScript (no build step: Chrome loads `extension/` as is; JSDoc adds types where needed)                               |
| `npm test`            | Unit tests (`test/*.test.mjs`, Node's test runner): both tracers, the call tree, the clean-up, language detection, the manifest, every example |
| `npm run test:e2e`    | End to end (`test/*.e2e.mjs`): loads the unpacked extension in Chrome and drives the panel (needs Chrome; `CHROME_PATH` to point at it)        |
| `npm run check`       | format:check, lint, typecheck and the unit tests, in that order                                                                                |
| `npm run build`       | Zips `extension/` into `visualiza.zip`, the Chrome Web Store package (leaves out `.DS_Store` and the vendored READMEs)                         |
| `npm run build:store` | Zips `store/` into `visualiza-store-assets.zip`, the listing images                                                                            |

The bundled libraries (`extension/vendor/`) are left out of formatting, linting and type checks.

[GitHub Actions](.github/workflows) runs `npm run check` on every push and pull request (`ci.yml`).

## Release and publish to the Chrome Web Store

The release is built for you: bump `version` in `extension/manifest.json`, then either push a matching tag
(`git tag v0.1.0 && git push origin v0.1.0`) or run the **Release** workflow from the Actions tab. It runs
the checks, builds the package, and attaches two files to a GitHub release:

- `visualiza.zip` — the extension. Upload it as the item in the
  [Chrome Web Store dashboard](https://chrome.google.com/webstore/devconsole).
- `visualiza-store-assets.zip` — the listing images (screenshots, promo tiles). Drop your images into
  `store/` first (see [`store/README.md`](store/README.md) for the sizes the store wants); unzip this and
  upload them in the listing form.

To build the same package locally: `npm run build`.
