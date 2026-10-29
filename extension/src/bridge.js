/*
 * Bridge (ISOLATED world).
 *
 * Relays commands from the side panel into the page context and forwards page
 * events back out. MAIN-world scripts cannot use chrome.* APIs, so this file is
 * the only crossing point.
 */

(function () {
  "use strict";

  const CHANNEL = "__mbu_channel__";
  const pending = new Map();
  let counter = 0;

  function newId() {
    counter += 1;
    return `c${Date.now().toString(36)}${counter}`;
  }

  function callPage(kind, payload, timeoutMs) {
    return new Promise((resolve) => {
      const id = newId();
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ error: `timed out after ${timeoutMs}ms` });
      }, timeoutMs);

      pending.set(id, { resolve, timer });
      window.postMessage(
        { channel: CHANNEL, dir: "to-page", id, kind, payload },
        window.location.origin
      );
    });
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.channel !== CHANNEL || data.dir !== "from-page") return;

    if (data.kind === "reply" && data.id && pending.has(data.id)) {
      const entry = pending.get(data.id);
      clearTimeout(entry.timer);
      pending.delete(data.id);
      entry.resolve({ result: data.result, error: data.error });
      return;
    }

    if (data.kind === "event") {
      try {
        chrome.runtime.sendMessage({ from: "mbu-page", payload: data });
      } catch {
        /* extension reloaded */
      }
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.target !== "mbu-bridge") return false;

    // Scans and unsend jobs legitimately run for minutes.
    const timeout = ["SCAN", "UNSEND", "VERIFY"].includes(message.kind) ? 30 * 60 * 1000 : 20000;

    callPage(message.kind, message.payload, timeout).then(sendResponse).catch((error) => {
      sendResponse({ error: String((error && error.message) || error) });
    });

    return true;
  });
})();
