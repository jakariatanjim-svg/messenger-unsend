/*
 * Service worker.
 *
 * Its only job is the toolbar button: clicking the extension icon asks the panel
 * in the active tab to open or close. No network access, no stored data.
 */

const MESSENGER_URL = /^https:\/\/(www\.)?(messenger\.com|facebook\.com\/messages)/;

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) return;

  // On any other page there is nothing to toggle, so point the user at Messenger
  // instead of failing silently.
  if (!MESSENGER_URL.test(tab.url || "")) {
    await chrome.tabs
      .create({ url: "https://www.messenger.com/" })
      .catch(() => {});
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { target: "mbu-overlay", kind: "toggle" });
  } catch {
    // The content script is not injected yet (page opened before install):
    // injecting it now makes the button work on the first click.
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["src/ui/markup.js", "src/ui/app.js", "src/ui/overlay.js"],
      });
    } catch {
      /* the page may forbid injection; the user can reload the tab */
    }
  }
});
