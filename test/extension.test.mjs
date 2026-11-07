// The extension as Chrome and the Chrome Web Store see it (the manifest, the files, the security rules), and every example in the panel.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { describe, test } from "node:test";
import { EXAMPLES } from "../extension/examples.js";
import { run as runJs } from "../extension/tracer.js";
import { ext, trace } from "./python.mjs";

const manifest = JSON.parse(await readFile(ext("manifest.json"), "utf8"));
const scripts = (await readdir(ext(""))).filter((f) => /\.(js|html)$/.test(f));

describe("the manifest", () => {
  test("names files that exist", () => {
    const named = [
      manifest.background.service_worker,
      manifest.side_panel.default_path,
      ...Object.values(manifest.icons),
      ...Object.values(manifest.action.default_icon),
    ];
    for (const f of named) assert.ok(existsSync(ext(f)), `manifest.json names ${f}, which doesn't exist`);
  });

  test("fits the Chrome Web Store's limits (name up to 75 characters, description up to 132)", () => {
    assert.ok(manifest.name.length <= 75, `name: ${manifest.name.length}`);
    assert.ok(manifest.description.length <= 132, `description: ${manifest.description.length}`);
  });

  test("keeps eval off and Python off the network", () => {
    const csp = manifest.content_security_policy.extension_pages;
    assert.ok(!csp.includes("'unsafe-eval'"), csp); // ('wasm-unsafe-eval' is all Pyodide needs)
    assert.match(csp, /connect-src 'self'/); // code selected on a page can't send anything anywhere
  });

  test("asks only for the permissions the extension uses, and no host permissions", () => {
    assert.deepEqual([...manifest.permissions].sort(), ["activeTab", "contextMenus", "scripting", "sidePanel", "storage"]);
    assert.equal(manifest.host_permissions, undefined);
  });
});

describe("the files", () => {
  for (const f of scripts) {
    test(`${f} loads no code from the network, and only files that exist`, async () => {
      const src = await readFile(ext(f), "utf8");
      assert.doesNotMatch(src, /(import|from|src=|importScripts\()\s*["'`(]?https?:/);
      for (const [, dep] of src.matchAll(/(?:from|src=|href=)\s*["']\.?\/?([\w./-]+\.(?:js|mjs|css|png))["']/g))
        assert.ok(existsSync(ext(dep)), `${f} loads ${dep}, which doesn't exist`);
    });
  }

  test("pages have no inline script (extension pages don't run them)", async () => {
    for (const f of scripts.filter((x) => x.endsWith(".html")))
      assert.doesNotMatch(await readFile(ext(f), "utf8"), /<script(?![^>]*\bsrc=)[^>]*>\s*\S/, f);
  });
});

describe("the examples", () => {
  for (const ex of EXAMPLES) {
    test(`${ex.lang}: ${ex.title}`, () => {
      const r = ex.lang === "javascript" ? runJs(ex.code, ex.input) : trace(ex.code, ex.input);
      assert.equal(r.error, null);
      assert.ok(r.steps.length > 1, `only ${r.steps.length} step`);
      assert.equal(r.truncated, false);
    });
  }
});
