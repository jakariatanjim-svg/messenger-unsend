/*
 * Service worker.
 *
 * Responsibilities: open the side panel on toolbar click, keep the user's
 * filters between sessions, and relay page events to an open panel.
 *
 * It never talks to the network and never stores session data.
 */

const KEY_SETTINGS = "mbu_settings";

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.action.onClicked.addListener(async (tab) => {
  try {
    if (tab && tab.windowId) await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch {
    /* already open, or unsupported */
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return false;

  // Page events: forward to whatever panel is open, and remember nothing else.
  if (message.from === "mbu-page") {
    chrome.runtime.sendMessage({ from: "mbu-relay", payload: message.payload }).catch(() => {});
    return false;
  }

  if (message.target === "mbu-bg") {
    (async () => {
      try {
        if (message.kind === "get-settings") {
          const store = await chrome.storage.local.get(KEY_SETTINGS);
          sendResponse({ result: store[KEY_SETTINGS] || null });
        } else if (message.kind === "save-settings") {
          await chrome.storage.local.set({ [KEY_SETTINGS]: message.payload });
          sendResponse({ result: true });
        } else if (message.kind === "active-tab") {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          sendResponse({ result: tab ? { id: tab.id, url: tab.url } : null });
        } else {
          sendResponse({ error: `unknown command: ${message.kind}` });
        }
      } catch (error) {
        sendResponse({ error: String((error && error.message) || error) });
      }
    })();
    return true;
  }

  return false;
});

// Tab open/close nudges the panel so it can show "page not reachable" honestly.
chrome.tabs.onRemoved.addListener(() => {
  chrome.runtime.sendMessage({ from: "mbu-relay", payload: { event: "tab-closed" } }).catch(() => {});
});
