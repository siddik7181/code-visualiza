import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/", "extension/vendor/"] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: "latest", sourceType: "module" },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      eqeqeq: ["error", "always", { null: "ignore" }],
      "prefer-const": "error",
    },
  },
  // the panel (and selection.js, which runs in the page): a browser, plus the extension APIs (chrome.*)
  { files: ["extension/*.js"], languageOptions: { globals: { ...globals.browser, ...globals.webextensions } } },
  // the background service worker, and the Python worker
  { files: ["extension/background.js"], languageOptions: { globals: { ...globals.serviceworker, ...globals.webextensions } } },
  { files: ["extension/worker.js"], languageOptions: { globals: globals.worker } },
  // tests run in Node; the e2e tests' page.evaluate() callbacks run in the panel or a page
  { files: ["test/*.mjs"], languageOptions: { globals: { ...globals.node, ...globals.browser, ...globals.webextensions } } },
  { files: ["eslint.config.js"], languageOptions: { globals: globals.node } },
];
