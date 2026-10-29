/*
 * Messenger Bulk Unsend - service worker
 * --------------------------------------
 * Keeps a persistent (storage-backed) index of captured GraphQL operations and
 * the current job state. Deliberately tiny: no network calls, no telemetry.
 */

const KEY_OPS = "mbu_ops";
const KEY_LOG = "mbu_log";
const MAX_LOG = 400;

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

// Fallback for browsers that ignore setPanelBehavior.
chrome.action.onClicked.addListener(async (tab) => {
  try {
    if (tab && tab.windowId) {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    }
  } catch {
    /* side panel may already be open */
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;

  if (msg.from === "mbu-bridge" && msg.kind === "hook-event") {
    handleHookEvent(msg.payload, sender).catch(() => {});
    return false;
  }

  if (msg.target === "mbu-bg") {
    (async () => {
      try {
        if (msg.kind === "get-ops") sendResponse({ result: await getOps() });
        else if (msg.kind === "clear-ops") {
          await chrome.storage.local.set({ [KEY_OPS]: {} });
          sendResponse({ result: true });
        } else if (msg.kind === "get-log") sendResponse({ result: await getLog() });
        else if (msg.kind === "clear-log") {
          await chrome.storage.local.set({ [KEY_LOG]: [] });
          sendResponse({ result: true });
        } else if (msg.kind === "log") {
          await addLog(msg.payload);
          sendResponse({ result: true });
        } else sendResponse({ error: `unknown command: ${msg.kind}` });
      } catch (e) {
        sendResponse({ error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  return false;
});

async function getOps() {
  const store = await chrome.storage.local.get(KEY_OPS);
  return store[KEY_OPS] || {};
}

async function getLog() {
  const store = await chrome.storage.local.get(KEY_LOG);
  return store[KEY_LOG] || [];
}

async function addLog(entry) {
  const log = await getLog();
  log.unshift({ at: Date.now(), ...entry });
  const trimmed = log.slice(0, MAX_LOG);
  await chrome.storage.local.set({ [KEY_LOG]: trimmed });
  return trimmed;
}

async function handleHookEvent(payload, sender) {
  if (!payload) return;
  const tabId = sender && sender.tab ? sender.tab.id : null;

  if (payload.kind === "op" && payload.recipe) {
    const ops = await getOps();
    ops[payload.recipe.name] = { ...payload.recipe, tabId };
    await chrome.storage.local.set({ [KEY_OPS]: ops });
    chrome.runtime.sendMessage({ from: "mbu-bg-refresh" }).catch(() => {});
    return;
  }

  if (payload.kind === "resp") {
    const ops = await getOps();
    if (ops[payload.name]) {
      ops[payload.name].lastResponse = payload.status;
      ops[payload.name].lastOk = payload.ok;
      await chrome.storage.local.set({ [KEY_OPS]: ops });
    }
  }
}
