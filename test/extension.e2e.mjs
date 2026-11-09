// End to end (npm run test:e2e): the unpacked extension in a real Chrome, driven by puppeteer-core. Chrome comes from CHROME_PATH or the
// usual macOS place; without one, these tests are skipped. What can't be driven: the right-click menu itself and the side panel's frame,
// so the menu's hand-off is done the way background.js does it (storage.session) and the panel page is opened as a page.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { EXAMPLES } from "../extension/examples.js";
import { selectedText } from "../extension/selection.js";

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const EXTENSION = fileURLToPath(new URL("../extension", import.meta.url));
const SIDE_PANEL = { width: 420, height: 900 };

/** @type {import("puppeteer-core").Browser} */
let browser;
let id = "";
const errors = [];

// a panel page; `idle` waits until a run is shown (or failed). Selectors name the element's tag (textarea.vz-editor) so puppeteer types
// the element the callback gets.
/** @returns {Promise<import("puppeteer-core").Page>} */
async function openPanel(viewport = SIDE_PANEL, hash = "") {
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setViewport(viewport);
  await page.goto(`chrome-extension://${id}/panel.html${hash}`);
  await idle(page);
  return page;
}
/** @param {import("puppeteer-core").Page} page */
const idle = (page) =>
  page.waitForFunction(
    () =>
      (!document.querySelector(".vz-run:disabled") && document.querySelector(".vz-count")?.textContent.includes("/")) ||
      document.querySelector(".vz-status.err")?.textContent,
    { timeout: 90_000 },
  );
/** What the panel shows now. @param {import("puppeteer-core").Page} page */
async function view(page) {
  const text = (sel) => page.$eval(sel, (e) => e.textContent);
  const count = await text(".vz-count");
  return {
    count,
    step: Number(count.split(" / ")[0]),
    caption: await text(".vz-caption"),
    status: await text(".vz-status"),
    out: await text(".vz-out"),
    picker: await page.$eval("select#examples", (e) => e.selectedOptions[0]?.textContent),
    code: await page.$eval("textarea.vz-editor", (e) => e.value),
    input: await page.$eval("textarea.vz-input", (e) => e.value),
    tab: await page.$$eval("button.vz-tab", (bs) => bs.find((b) => b.ariaPressed === "true")?.textContent),
  };
}
/** Clicks the first `sel` element whose text starts with `start`. @param {import("puppeteer-core").Page} page */
const clickText = (page, sel, start) =>
  page.$$eval(sel, (es, start) => /** @type {HTMLElement} */ (es.find((e) => e.textContent.trim().startsWith(start))).click(), start);
/** Runs code the way a user does: Edit code, type, Run. @param {import("puppeteer-core").Page} page */
async function runCode(page, code, input = "") {
  if (await page.$("button.vz-edit:not([hidden])")) await page.click("button.vz-edit");
  await page.$eval("textarea.vz-editor", (e, v) => (e.value = v), code);
  await page.$eval("textarea.vz-input", (e, v) => (e.value = v), input);
  await page.click(".vz-run");
  await idle(page);
}
/** Pastes text the way ⌘V does: into `sel` (all of it selected), or into the page when sel is null. @param {import("puppeteer-core").Page} page */
async function paste(page, sel, text) {
  await page.evaluate(
    (sel, text) => {
      const box = sel && /** @type {HTMLTextAreaElement} */ (document.querySelector(sel));
      const t = box || document.body;
      if (box) {
        box.focus();
        box.select();
      }
      const data = new DataTransfer();
      data.setData("text/plain", text);
      t.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    },
    sel,
    text,
  );
  await page.waitForFunction(() => !document.querySelector(".vz-run:disabled"));
  await idle(page);
}
/** @param {import("puppeteer-core").Page} page @param {import("puppeteer-core").KeyInput} key */
const press = async (page, key, times = 1) => {
  for (let k = 0; k < times; k++) await page.keyboard.press(key);
};

describe("the extension in Chrome", { skip: !existsSync(CHROME) && `no Chrome at ${CHROME} (set CHROME_PATH)` }, () => {
  before(async () => {
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, pipe: true, enableExtensions: true });
    id = await browser.installExtension(EXTENSION);
  });
  after(async () => {
    await browser?.close();
    assert.deepEqual(errors, [], "the panel threw");
  });

  test("its service worker starts and registers the menu's click handler", async () => {
    const target = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().includes(id));
    const sw = await target.worker();
    assert.equal(await sw.evaluate(() => chrome.contextMenus.onClicked.hasListeners()), true);
  });

  test("the panel opens on the first example and replays it", async () => {
    const page = await openPanel();
    const v = await view(page);
    assert.deepEqual([v.picker, v.input, v.count, v.status], ["Fibonacci (call tree)", "fib(5)", "1 / 60", ""]);
    assert.equal(v.tab, "Call tree"); // recursion opens on its call tree
    await press(page, "End");
    assert.match((await view(page)).out, /Result 5/);
    await page.close();
  });

  test("every example runs in the panel", async (t) => {
    const page = await openPanel();
    for (const [n, ex] of EXAMPLES.entries()) {
      await t.test(ex.title, async () => {
        await page.select("#examples", String(n));
        await idle(page);
        const v = await view(page);
        assert.deepEqual([v.code, v.status], [ex.code, ""]);
        if (ex.input) assert.equal(v.input, ex.input); // (an empty one is a script's, or gets the suggested call)
        assert.match(v.count, /^1 \/ \d+$/);
      });
    }
    await page.close();
  });

  test("the call tree grows with the run, and a click on a call goes to it", async () => {
    const page = await openPanel();
    await press(page, "ArrowRight", 20);
    const shown = () => page.$$eval(".vz-cnode:not(.off)", (n) => n.length);
    const before = await shown();
    await press(page, "End");
    assert.ok(before < (await shown()), "calls appear as the run goes");
    assert.equal(await shown(), 15); // fib(5) makes 15 calls
    await clickText(page, "button.vz-cnode", "fib(3)");
    assert.match((await view(page)).caption, /fib\(n=3\)/);
    assert.equal(await page.$eval(".vz-stage", (e) => e.hasAttribute("hidden")), false); // the data stays in view under the call tree
    assert.match(await page.$eval(".vz-csum", (e) => e.textContent), /^15 calls · 3 redo an earlier call/);
    await page.keyboard.down("Shift");
    await press(page, "ArrowUp"); // step out: to fib(3)'s return
    await page.keyboard.up("Shift");
    assert.match((await view(page)).caption, /fib returns 2/);
    await page.close();
  });

  test("a click on a statement in the code tree, or on a line, goes to the next time it runs", async () => {
    const page = await openPanel();
    await clickText(page, "button.vz-tab", "Code tree");
    await clickText(page, "button.vz-onode", "returnreturn n"); // (its kind tag, then its line)
    const at = (await view(page)).step;
    assert.equal(await page.$eval(".vz-line.cur .vz-src", (e) => e.textContent.trim()), "return n");
    await page.$$eval("div.vz-line", (lines) => lines[2].click()); // line 3 again: its next run
    assert.ok((await view(page)).step > at);
    await page.close();
  });

  test("code sent from the menu reaches a panel that's open: cleaned up, with a call suggested", async () => {
    const page = await openPanel();
    await page.evaluate(() =>
      chrome.storage.session.set({
        pending: {
          code: "    def climb(n):\n        a, b = 1, 1\n        for _ in range(n):\n            a, b = b, a + b\n        return a\n",
          at: Date.now(),
        },
      }),
    );
    await page.waitForFunction(() =>
      /** @type {HTMLTextAreaElement} */ (document.querySelector(".vz-editor")).value.startsWith("def climb"),
    );
    await idle(page);
    const v = await view(page);
    assert.deepEqual([v.picker, v.input, v.status], ["Your code", "climb(n=5)", ""]);
    assert.equal(await page.evaluate(() => chrome.storage.session.get("pending").then((s) => s.pending)), undefined); // taken
    await page.close();
  });

  test("code sent from the menu waits for a panel that opens later", async () => {
    const sw = await (await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().includes(id))).worker();
    await sw.evaluate(() =>
      chrome.storage.session.set({ pending: { code: "nums = [3, 1, 2]\nnums.sort()\nprint(nums)", at: Date.now() } }),
    );
    const page = await openPanel();
    await press(page, "End");
    const v = await view(page);
    assert.equal(v.code, "nums = [3, 1, 2]\nnums.sort()\nprint(nums)");
    assert.match(v.out, /\[1, 2, 3\]/);
    await page.close();
  });

  test("JavaScript sent from the menu is run as JavaScript, with a call suggested", async () => {
    const page = await openPanel();
    const code = "  function twice(nums) {\n    const out = [];\n    for (const x of nums) out.push(x * 2);\n    return out;\n  }";
    await page.evaluate((code) => chrome.storage.session.set({ pending: { code, at: Date.now() } }), code);
    await page.waitForFunction(() =>
      /** @type {HTMLTextAreaElement} */ (document.querySelector(".vz-editor")).value.startsWith("function twice"),
    );
    await idle(page);
    assert.equal(await page.$eval("select.vz-lang", (e) => e.value), "javascript");
    await press(page, "End");
    const v = await view(page);
    assert.deepEqual([v.input, v.status], ["twice([5, 2, 8, 1, 9, 3])", ""]);
    assert.match(v.out, /Result \[10, 4, 16, 2, 18, 6\]/);
    await page.close();
  });

  test("a JavaScript example is shown the JavaScript way: its language, a Map, null", async () => {
    const page = await openPanel();
    await page.select("#examples", String(EXAMPLES.findIndex((e) => e.title === "Two Sum (Map)")));
    await idle(page);
    assert.equal(await page.$eval("select.vz-lang", (e) => e.value), "javascript");
    await press(page, "ArrowRight", 8);
    assert.match(await page.$eval(".vz-structs", (e) => e.textContent), /seen\s*Map · \d/);
    await runCode(page, "function f() {\n  let x = null;\n  return x;\n}", "f()");
    await press(page, "End");
    assert.match((await view(page)).out, /Result null/);
    await page.close();
  });

  test("⤢ opens a tab with the same code and input", async () => {
    const page = await openPanel();
    await runCode(page, "def sq(x):\n    return x * x", "sq(7)");
    const [tab] = await Promise.all([
      new Promise((r) => browser.once("targetcreated", async (t) => r(await t.page()))),
      page.click("#tab"),
    ]);
    await idle(tab);
    await press(tab, "End");
    const v = await view(tab);
    assert.deepEqual([v.code, v.input], ["def sq(x):\n    return x * x", "sq(7)"]);
    assert.match(v.out, /Result 49/);
    assert.ok(tab.url().endsWith("panel.html"), "the code isn't left in the address");
    await tab.close();
    await page.close();
  });

  test("Python can't reach the network", async () => {
    const page = await openPanel();
    await runCode(page, "from pyodide.http import open_url\nprint(open_url('https://example.com').read())");
    await press(page, "End");
    assert.match((await view(page)).out, /NetworkError/);
    await page.close();
  });

  test("a run that hangs in a builtin is stopped after 20 seconds, and the next run works", { timeout: 60_000 }, async () => {
    const page = await openPanel();
    await runCode(page, "x = sum(range(10**15))");
    assert.match((await view(page)).status, /more than 20 seconds/);
    await runCode(page, "y = 1 + 1");
    assert.equal((await view(page)).status, "");
    await page.close();
  });

  test("LeetCode test cases pasted in the input run as calls of the code, one tab per case, checked against the answer", async () => {
    const page = await openPanel();
    const code =
      "class Solution:\n    def twoSum(self, nums: List[int], target: int) -> List[int]:\n        seen = {}\n        for i, x in enumerate(nums):\n" +
      "            if target - x in seen:\n                return [seen[target - x], i]\n            seen[x] = i";
    await runCode(page, code);
    await paste(
      page,
      "textarea.vz-input",
      "Example 1:\nInput: nums = [2,7,11,15], target = 9\nOutput: [0,1]\n\nExample 2:\nInput: nums = [3,2,4], target = 6\nOutput: [2,1]",
    );
    assert.deepEqual(await page.$$eval("button.vz-case", (bs) => bs.map((b) => `${b.textContent}${b.ariaPressed === "true" ? "*" : ""}`)), [
      "Case 1*",
      "Case 2",
    ]);
    assert.equal(await page.$eval(".vz-note", (e) => e.textContent), "Case 1: ran Solution().twoSum([2, 7, 11, 15], 9)");
    await page.click("button.vz-case:nth-child(2)");
    await idle(page);
    await press(page, "End");
    assert.match((await view(page)).out, /Result \[1, 2\] · expected \[2,1\] ✓ same items, in another order/);
    await page.close();
  });

  test("code pasted anywhere in the panel replaces the code (its language detected) and runs; a node parameter is built", async () => {
    const page = await openPanel();
    await paste(
      page,
      null,
      "/**\n * @param {ListNode} head\n */\nvar reverseList = function(head) {\n  let prev = null;\n  while (head) [head.next, prev, head] = [prev, head, head.next];\n  return prev;\n};",
    );
    assert.equal(await page.$eval("select.vz-lang", (e) => e.value), "javascript");
    await paste(page, null, "head =\n[1,2,3]");
    await press(page, "End");
    assert.match((await view(page)).out, /Result ListNode \[3,2,1\]/);
    await page.close();
  });

  test("the code is always editable: editing clears the run, Ctrl+Enter runs it again", async () => {
    const page = await openPanel();
    await page.focus("textarea.vz-editor");
    await page.keyboard.type("# hi\n");
    assert.equal(await page.$$eval(".vz-frame", (f) => f.length), 0);
    assert.match((await view(page)).caption, /The code changed/);
    await page.keyboard.down("Control");
    await press(page, "Enter");
    await page.keyboard.up("Control");
    await idle(page);
    await press(page, "ArrowRight", 2); // (the run took the keys back from the code)
    assert.equal((await view(page)).step, 3);
    await page.close();
  });

  test("the selection is read with its line breaks, from the page and from a text box", async () => {
    const page = await browser.newPage();
    await page.setContent(
      "<pre id=p>def f(n):\n    if n:\n        return 1</pre><textarea id=t>x = 1\nfor i in range(3):\n    x += i</textarea>",
    );
    // (selectedText is sent to the page as source, as chrome.scripting does)
    await page.evaluate(() => getSelection().selectAllChildren(document.getElementById("p")));
    const fromPre = await page.evaluate(selectedText);
    await page.$eval("textarea#t", (t) => {
      t.focus();
      t.setSelectionRange(6, t.value.length);
    });
    const fromTextarea = await page.evaluate(selectedText);
    assert.equal(fromPre, "def f(n):\n    if n:\n        return 1");
    assert.equal(fromTextarea, "for i in range(3):\n    x += i");
    await page.close();
  });

  test("hovering a chip highlights its pointer and the cell it points at", async () => {
    const page = await openPanel();
    await page.select("#examples", String(EXAMPLES.findIndex((e) => e.title === "Binary search")));
    await idle(page);
    await press(page, "ArrowRight", 5);
    // hover a chip that's also drawn as a pointer
    const chip = await page.$("span.vz-var[data-var='mid']");
    assert.ok(chip, "mid chip exists");
    await chip.hover();
    // check that the pointer gets the .link class
    const linkedPointer = await page.$eval(".vz-ptr[data-var='mid'].link", (el) => el.textContent);
    assert.equal(linkedPointer, "mid", "pointer gets .link on hover");
    // check that the cell also gets .link
    const linkedCell = await page.$(".vz-cell.link[data-var*='mid']");
    assert.ok(linkedCell, "cell pointed at by mid gets .link");
    // check that the chip itself gets .link
    const chipLinked = await page.$eval("span.vz-var[data-var='mid'].link", (el) => !!el);
    assert.ok(chipLinked, "chip gets .link on hover");
    await page.close();
  });
});
