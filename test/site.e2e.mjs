// End to end (npm run test:e2e): the web build (npm run build:site, what GitHub Pages serves) in a real Chrome, from a subpath like
// https://<user>.github.io/<repo>/. Guards the one way it breaks quietly: the shared engine gaining a chrome.* call or an absolute URL.
// Chrome comes from CHROME_PATH or the usual macOS place; without one, this is skipped.
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { EXAMPLES } from "../extension/examples.js";

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SITE = join(ROOT, "_site");
const BASE = "/code-visualiza/";
// what Pages sends: module workers need a JavaScript type on .mjs, and wasm streaming needs application/wasm
const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".zip": "application/zip",
  ".json": "application/json",
  ".py": "text/x-python",
};

/** @type {import("puppeteer-core").Browser} */
let browser;
/** @type {import("node:http").Server} */
let server;
let origin = "";
const errors = [];

describe("the web build in Chrome", { skip: !existsSync(CHROME) && `no Chrome at ${CHROME} (set CHROME_PATH)` }, () => {
  before(async () => {
    execSync("npm run build:site", { cwd: ROOT, stdio: "ignore" });
    server = createServer((req, res) => {
      const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
      const file = normalize(join(SITE, path.startsWith(BASE) ? path.slice(BASE.length) || "index.html" : "\0"));
      if (!file.startsWith(SITE) || !existsSync(file)) return res.writeHead(404).end();
      res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" }).end(readFileSync(file));
    }).listen(0);
    origin = `http://localhost:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}${BASE}`;
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, pipe: true });
  });
  after(async () => {
    await browser?.close();
    server?.close();
    assert.deepEqual(errors, [], "the page threw");
  });

  /** @param {import("puppeteer-core").Page} page */
  const idle = (page) =>
    page.waitForFunction(
      () =>
        (!document.querySelector(".vz-run:disabled") && document.querySelector(".vz-count")?.textContent.includes("/")) ||
        document.querySelector(".vz-status.err")?.textContent,
      { timeout: 90_000 },
    );

  test("it opens on the first example (Python, so Pyodide starts) and a JavaScript example runs too", async () => {
    const page = await browser.newPage();
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(origin);
    await idle(page);
    assert.equal(await page.$eval("select#examples", (e) => e.selectedOptions[0]?.textContent), EXAMPLES[0].title);
    assert.equal(await page.$eval(".vz-status", (e) => e.textContent), "");
    await page.keyboard.press("End");
    assert.match(await page.$eval(".vz-out", (e) => e.textContent), /Result 5/);

    await page.select("#examples", String(EXAMPLES.findIndex((e) => e.title === "Two Sum (Map)")));
    await idle(page);
    assert.equal(await page.$eval("select.vz-lang", (e) => e.value), "javascript");
    assert.equal(await page.$eval(".vz-status", (e) => e.textContent), "");
    await page.close();
  });
});
