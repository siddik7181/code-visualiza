// Visualiza's service worker. The toolbar button opens the side panel (panel.html); "Explain this with Visualiza" on selected code opens it
// and sends the code there through storage.session (the panel takes it when it opens, or right away if it's already open).
import { selectedText } from "./selection.js";

const MENU = "explain";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU,
    title: "Explain this with Visualiza",
    contexts: ["selection"],
    documentUrlPatterns: ["http://*/*", "https://*/*", "file:///*"],
  });
});
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU || !tab) return;
  // first, while the click still counts as a user gesture (sidePanel.open is refused after an await)
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  // the menu's selectionText has its line breaks squashed, which breaks Python's indentation: read the selection from the page instead
  // (activeTab allows it for this click). It stays the fallback where the page can't be read (another site's frame, the Web Store).
  const code = await chrome.scripting
    .executeScript({ target: { tabId: tab.id, frameIds: [info.frameId || 0] }, func: selectedText })
    .then(([r]) => r?.result || info.selectionText)
    .catch(() => info.selectionText);
  await chrome.storage.session.set({ pending: { code, at: Date.now() } });
});
