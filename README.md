# Visualiza

A Chrome extension that explains Python and JavaScript code by running it step by step. Select code on any page (a tutorial, Stack
Overflow, GitHub, a LeetCode solution), right-click, choose **Explain this with Visualiza**, and the side panel replays it while you watch
the data change. The code really runs, inside the extension and offline (Python is CPython 3.14 via [Pyodide](https://pyodide.org);
JavaScript runs in [Sval](https://github.com/Siubaak/sval), an interpreter); nothing is sent anywhere, and no AI is involved.

## Install

`chrome://extensions` → turn on **Developer mode** → **Load unpacked** → pick the `extension/` folder. (Chrome 116 or later.)

- Select code on a page → right-click → **Explain this with Visualiza**. The language is told from the code; the menu above the editor
  switches it.
- Or click the toolbar icon: the panel opens with examples, and you can type or paste code in it.
- **⤢** opens the same thing in a tab, for more room (big call trees, two columns).

## What it shows

- **Data**: every frame on the call stack with its variables, each drawn by what it is and how the code uses it: arrays with their index
  pointers (and a `lo..hi` window), bars for lists sorted in place, grids (DP tables, boards), dicts, sets, linked lists, binary trees,
  graphs from adjacency lists, heaps as trees, stacks, queues, intervals on a number line, the bits of a number. A caption says what each
  step changed ("`seen[2] = 0 (new key)`", "`swap a[1] ↔ a[2]`", "next: is `target - x = 6` in seen? no").
- **Call tree**: every call the run made, growing as it plays. The calls on the stack form the path to the current one, and finished calls
  show what they returned. Good for recursion, backtracking and divide and conquer. Click a call to jump to it.
- **Code tree**: the code as a tree of statements (from the language's own parser), with the statements around the current line marked and how
  many times each one has run. Click a statement, or a line of the code, to jump to the next time it runs.

## What it runs

Python and JavaScript, the same way:

- **A script**: the input stays empty and the code runs as is (its top level is traced; `print` / `console.log` output is shown).
- **Functions**: write the call in the input (`fib(5)`), or leave it empty and a call is suggested from the parameter names and how the code
  uses them (a LeetCode-style `var maxProfit = function (prices)` too).
- **A class**: write the calls (`s = MinStack()` / `const s = new MinStack()`, `s.push(1)`, ...). A LeetCode-style Python `class Solution`
  gets a suggested call on its method; a JavaScript class, or a design problem written with `X.prototype.m = function`, gets calls.
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
| `test/`                       | The tests (below)                                                                                                                   |

## Development

`npm install` once, then:

| Command             | What it does                                                                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run format`    | Prettier: rewrites files to the project style (`format:check` only checks)                                                                     |
| `npm run lint`      | ESLint: unused variables, `==`, `let` that should be `const`, and other likely bugs                                                            |
| `npm run typecheck` | TypeScript checks the JavaScript (no build step: Chrome loads `extension/` as is; JSDoc adds types where needed)                               |
| `npm test`          | Unit tests (`test/*.test.mjs`, Node's test runner): both tracers, the call tree, the clean-up, language detection, the manifest, every example |
| `npm run test:e2e`  | End to end (`test/*.e2e.mjs`): loads the unpacked extension in Chrome and drives the panel (needs Chrome; `CHROME_PATH` to point at it)        |
| `npm run check`     | format:check, lint, typecheck and the unit tests, in that order                                                                                |

The bundled libraries (`extension/vendor/`) are left out of formatting, linting and type checks.

## Package for the Chrome Web Store

```sh
cd extension && zip -r ../visualiza.zip . -x '*.DS_Store' 'vendor/*/README.md' 'vendor/*/*.d.mts'
```
