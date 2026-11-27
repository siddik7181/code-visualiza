// The web build (GitHub Pages): the same visualizer as the extension's panel, minus the extension hand-offs (chrome.storage, tabs, side panel).
// `npm run build:site` copies extension/ and this folder into _site/, so the imports below sit next to this file.
import { mountApp } from "./visualizer.js";
import { EXAMPLES } from "./examples.js";

const picker = /** @type {HTMLSelectElement} */ (document.getElementById("examples"));
mountApp(document.getElementById("app"), picker, EXAMPLES).take();
