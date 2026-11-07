// Runs in the page, injected by background.js (chrome.scripting): the selected text with its line breaks. A selection inside a text box
// (GitHub's code view, editors built on a textarea) isn't part of getSelection(). Self-contained: it's sent to the page as source.
export function selectedText() {
  const a = document.activeElement;
  if ((a instanceof HTMLTextAreaElement || a instanceof HTMLInputElement) && a.selectionEnd > a.selectionStart)
    return a.value.slice(a.selectionStart, a.selectionEnd);
  return String(getSelection());
}
