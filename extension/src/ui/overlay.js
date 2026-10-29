/*
 * Floating panel shell (ISOLATED world).
 *
 * Mounts the UI inside a shadow root on a host element appended to the page, so
 * Messenger's stylesheet cannot reach the panel and the panel cannot restyle
 * Messenger. The shell handles showing/hiding, dragging, minimising and
 * remembering where the user left it.
 */

(function () {
  "use strict";

  if (globalThis.__MBU_OVERLAY__) return;
  globalThis.__MBU_OVERLAY__ = true;

  const KEY_POSITION = "mbu_position";
  const KEY_VISIBLE = "mbu_visible";
  const MARGIN = 12;
  const DEFAULT_WIDTH = 400;

  let host = null;
  let shadow = null;
  let panel = null;
  let launcher = null;
  let minimised = false;

  const SHELL_CSS = `
    .shell {
      display: flex;
      flex-direction: column;
      background: #0f1115;
      border: 1px solid #252b38;
      border-radius: 12px;
      box-shadow: 0 18px 48px rgba(0, 0, 0, 0.45);
      overflow: hidden;
      max-height: calc(100vh - 96px);
    }
    .shell.is-minimised .panel-root > *:not(.topbar) { display: none; }
    .shell__body {
      overflow: auto;
      max-height: calc(100vh - 170px);
    }
    .topbar { cursor: grab; user-select: none; }
    .shell.is-dragging .topbar { cursor: grabbing; }
    .topbar__actions { display: flex; align-items: center; gap: 6px; }
    .iconbtn {
      background: transparent;
      border: 1px solid #252b38;
      border-radius: 6px;
      color: #98a2b7;
      width: 22px;
      height: 22px;
      line-height: 1;
      font-size: 14px;
      cursor: pointer;
      padding: 0;
      font-family: inherit;
    }
    .iconbtn:hover { color: #e9edf5; border-color: #3b465c; }
  `;

  function hostStyles() {
    return {
      position: "fixed",
      zIndex: "2147483647",
      top: "72px",
      right: "24px",
      left: "auto",
      width: `${DEFAULT_WIDTH}px`,
      maxWidth: "calc(100vw - 24px)",
      maxHeight: "calc(100vh - 96px)",
      margin: "0",
      padding: "0",
      border: "0",
      background: "transparent",
      display: "block",
    };
  }

  function makeShell() {
    host = document.createElement("div");
    host.id = "mbu-unsend-host";
    Object.assign(host.style, hostStyles());

    shadow = host.attachShadow({ mode: "open" });

    const shellStyle = document.createElement("style");
    shellStyle.textContent = SHELL_CSS;
    shadow.appendChild(shellStyle);

    panel = document.createElement("div");
    panel.className = "shell";
    shadow.appendChild(panel);
    return host;
  }

  function buildLauncher() {
    const button = document.createElement("button");
    button.id = "mbu-unsend-launcher";
    button.type = "button";
    button.textContent = "MBU";
    button.title = "Open Messenger Bulk Unsend";
    Object.assign(button.style, {
      position: "fixed",
      zIndex: "2147483647",
      bottom: "20px",
      right: "20px",
      width: "46px",
      height: "46px",
      borderRadius: "50%",
      border: "1px solid #252b38",
      background: "#e5484d",
      color: "#ffffff",
      fontSize: "12px",
      fontWeight: "600",
      letterSpacing: "0.3px",
      cursor: "pointer",
      boxShadow: "0 8px 24px rgba(0, 0, 0, 0.4)",
      fontFamily: 'ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif',
    });
    button.addEventListener("click", show);
    return button;
  }

  // ------------------------------------------------------------------ position

  function placeAt(left, top) {
    const width = host.getBoundingClientRect().width || DEFAULT_WIDTH;
    const height = host.getBoundingClientRect().height || 200;
    const maxLeft = Math.max(MARGIN, window.innerWidth - width - MARGIN);
    const maxTop = Math.max(MARGIN, window.innerHeight - height - MARGIN);
    host.style.left = `${Math.min(Math.max(MARGIN, left), maxLeft)}px`;
    host.style.top = `${Math.min(Math.max(MARGIN, top), maxTop)}px`;
    host.style.right = "auto";
  }

  function persistPosition() {
    const rect = host.getBoundingClientRect();
    try {
      chrome.storage.local.set({ [KEY_POSITION]: { left: rect.left, top: rect.top } });
    } catch {
      /* storage unavailable */
    }
  }

  async function restorePosition() {
    try {
      const stored = await chrome.storage.local.get([KEY_POSITION, KEY_VISIBLE]);
      const position = stored[KEY_POSITION];
      if (position && Number.isFinite(position.left) && Number.isFinite(position.top)) {
        placeAt(position.left, position.top);
      }
      return stored[KEY_VISIBLE] !== false;
    } catch {
      return true;
    }
  }

  // ------------------------------------------------------------------ dragging

  function enableDrag() {
    const handle = shadow.querySelector(".topbar");
    if (!handle) return;

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;

    handle.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button, input, select, textarea")) return;
      const rect = host.getBoundingClientRect();
      dragging = true;
      startX = event.clientX;
      startY = event.clientY;
      originLeft = rect.left;
      originTop = rect.top;
      panel.classList.add("is-dragging");
      if (handle.setPointerCapture) handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });

    handle.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      placeAt(originLeft + (event.clientX - startX), originTop + (event.clientY - startY));
    });

    const stop = () => {
      if (!dragging) return;
      dragging = false;
      panel.classList.remove("is-dragging");
      persistPosition();
    };

    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);

    window.addEventListener("resize", () => {
      const rect = host.getBoundingClientRect();
      placeAt(rect.left, rect.top);
    });
  }

  // ------------------------------------------------------------------- display

  function show() {
    host.style.display = "block";
    if (launcher) launcher.style.display = "none";
    try {
      chrome.storage.local.set({ [KEY_VISIBLE]: true });
    } catch {
      /* ignore */
    }
    const rect = host.getBoundingClientRect();
    if (rect.width) placeAt(rect.left, rect.top);
  }

  function hide() {
    host.style.display = "none";
    if (launcher) launcher.style.display = "block";
    try {
      chrome.storage.local.set({ [KEY_VISIBLE]: false });
    } catch {
      /* ignore */
    }
  }

  function toggle() {
    if (host.style.display === "none") show();
    else hide();
  }

  function wireControls() {
    shadow.getElementById("btn-close").addEventListener("click", hide);
    shadow.getElementById("btn-min").addEventListener("click", () => {
      minimised = !minimised;
      panel.classList.toggle("is-minimised", minimised);
      const button = shadow.getElementById("btn-min");
      button.textContent = minimised ? "▢" : "–";
      button.title = minimised ? "Expand" : "Minimise";
      const rect = host.getBoundingClientRect();
      placeAt(rect.left, rect.top);
    });
  }

  // --------------------------------------------------------------------- mount

  async function loadPanelCss() {
    try {
      const response = await fetch(chrome.runtime.getURL("src/ui/panel.css"));
      return response.ok ? await response.text() : "";
    } catch {
      return "";
    }
  }

  /** Wait for the page-side runtime to answer, without blocking the panel. */
  function waitForPageRuntime(attempts = 20) {
    const once = (remaining) =>
      new Promise((resolve) => {
        const id = `o${Date.now().toString(36)}${remaining}`;
        const timer = setTimeout(() => resolve(false), 400);

        const listener = (event) => {
          const data = event.data;
          if (
            event.source === window &&
            data &&
            data.channel === "__mbu_channel__" &&
            data.dir === "from-page" &&
            data.kind === "reply" &&
            data.id === id
          ) {
            clearTimeout(timer);
            window.removeEventListener("message", listener);
            resolve(!!(data.result && data.result.alive));
          }
        };

        window.addEventListener("message", listener);
        window.postMessage(
          { channel: "__mbu_channel__", dir: "to-page", id, kind: "PING" },
          window.location.origin
        );
      }).then((ok) => {
        if (ok) return true;
        if (remaining <= 0) return false;
        return new Promise((resolve) => setTimeout(resolve, 500)).then(() => once(remaining - 1));
      });

    return once(attempts);
  }

  (async function boot() {
    makeShell();
    launcher = buildLauncher();
    document.documentElement.appendChild(launcher);

    const css = await loadPanelCss();
    if (css) {
      const style = document.createElement("style");
      style.textContent = css;
      shadow.appendChild(style);
    }

    const body = document.createElement("div");
    body.className = "shell__body";
    body.innerHTML = globalThis.__MBU_MARKUP__ || "";
    panel.appendChild(body);

    document.documentElement.appendChild(host);
    host.style.display = "none";

    wireControls();
    enableDrag();

    const visible = await restorePosition();
    await globalThis.__MBU_UI__.mount(body);
    waitForPageRuntime();

    if (visible) show();
  })();

  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.target === "mbu-overlay" && message.kind === "toggle") toggle();
    return false;
  });
})();
