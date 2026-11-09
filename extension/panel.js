// The side panel (also opens as a tab). Extension pages only run script files, so this replaces an inline <script>.
import { mountApp } from "./visualizer.js";
import { EXAMPLES } from "./examples.js";

const picker = /** @type {HTMLSelectElement} */ (document.getElementById("examples"));
const { take, now } = mountApp(document.getElementById("app"), picker, EXAMPLES);

// code sent from a page ("Explain this with Visualiza", see background.js): waiting when the panel opens, or arriving while it's open
const receive = (p) => {
  if (!p) return false;
  chrome.storage.session.remove("pending");
  take(p.code);
  return true;
};
chrome.storage.session.onChanged.addListener((ch) => receive(ch.pending?.newValue));
const { pending } = await chrome.storage.session.get("pending");
// (a tab opened with ⤢ gets the code in its address: the panel listens to storage.session, so a handoff there would be taken by the panel)
const handoff = location.hash.length > 1 ? JSON.parse(decodeURIComponent(location.hash.slice(1))) : null;
history.replaceState(null, "", location.pathname);
if (!receive(pending)) take(handoff && handoff.code, handoff && handoff.input, handoff && handoff.lang);

// the same page in a tab, with the code and input as they are now; the side panel then closes (the tab takes over), a tab stays
const inTab = !!(await chrome.tabs.getCurrent());
document.getElementById("tab").onclick = async () => {
  const tab = await chrome.tabs.create({ url: `panel.html#${encodeURIComponent(JSON.stringify(now()))}` });
  if (inTab) return;
  // (sidePanel.close is Chrome 141+; before it, a side panel closes itself with window.close)
  if (chrome.sidePanel.close) chrome.sidePanel.close({ windowId: tab.windowId }).catch(() => window.close());
  else window.close();
};
