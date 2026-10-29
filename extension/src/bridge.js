/*
 * Messenger Bulk Unsend - ISOLATED world bridge
 * ---------------------------------------------
 * The page hook lives in MAIN world and cannot use chrome.* APIs.
 * This script relays messages between the hook and the extension
 * (side panel / service worker).
 */

(function () {
  "use strict";

  const CHANNEL = "__mbu_channel__";
  const pending = new Map(); // requestId -> { resolve, timer }

  function post(kind, payload) {
    const id = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ error: "timeout: no reply from page hook" });
      }, 15000);
      pending.set(id, { resolve, timer });
      window.postMessage(
        { channel: CHANNEL, dir: "to-hook", id, kind, payload },
        window.location.origin
      );
    });
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.channel !== CHANNEL || data.dir !== "from-hook") return;

    if (data.kind === "reply" && data.id && pending.has(data.id)) {
      const entry = pending.get(data.id);
      clearTimeout(entry.timer);
      pending.delete(data.id);
      entry.resolve({ result: data.result, error: data.error });
      return;
    }

    if (data.kind === "op" || data.kind === "resp" || data.kind === "ready") {
      try {
        chrome.runtime.sendMessage({ from: "mbu-bridge", kind: "hook-event", payload: data });
      } catch {
        /* extension reloaded - ignore */
      }
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.target !== "mbu-bridge") return false;

    (async () => {
      try {
        if (msg.kind === "ping") {
          sendResponse(await post("ping"));
        } else if (msg.kind === "list-ops") {
          sendResponse(await post("list-ops"));
        } else if (msg.kind === "replay") {
          sendResponse(await post("replay", msg.payload));
        } else {
          sendResponse({ error: `unknown bridge command: ${msg.kind}` });
        }
      } catch (e) {
        sendResponse({ error: String((e && e.message) || e) });
      }
    })();

    return true; // async response
  });
})();
