/*
 * Panel behaviour.
 *
 * Runs inside the shadow root mounted by overlay.js. Talks to the page through
 * window.postMessage: the page-side engine answers commands and streams events
 * back on the same channel.
 */

(function () {
  "use strict";

  const CHANNEL = "__mbu_channel__";
  const MAX_LOG = 200;
  const LONG_TIMEOUT = 30 * 60 * 1000;

  const state = {
    root: null,
    messages: [],
    selected: new Set(),
    running: false,
    paused: false,
    summary: null,
    pending: new Map(),
    counter: 0,
    mounted: false,
  };

  // ------------------------------------------------------------------ plumbing

  function el(id) {
    return state.root ? state.root.getElementById(id) : null;
  }

  function queryAll(selector) {
    return state.root ? Array.from(state.root.querySelectorAll(selector)) : [];
  }

  function callPage(kind, payload) {
    return new Promise((resolve) => {
      const id = `u${Date.now().toString(36)}${(state.counter += 1)}`;
      const timeout = ["SCAN", "UNSEND", "VERIFY"].includes(kind) ? LONG_TIMEOUT : 20000;

      const timer = setTimeout(() => {
        state.pending.delete(id);
        resolve({ error: `the page did not answer within ${Math.round(timeout / 1000)}s` });
      }, timeout);

      state.pending.set(id, { resolve, timer });
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

    if (data.kind === "reply" && data.id && state.pending.has(data.id)) {
      const entry = state.pending.get(data.id);
      clearTimeout(entry.timer);
      state.pending.delete(data.id);
      entry.resolve({ result: data.result, error: data.error });
      return;
    }

    if (data.kind === "event") handleEvent(data);
  });

  // ----------------------------------------------------------------- utilities

  function log(kind, text) {
    const box = el("log");
    if (!box) return;
    const line = document.createElement("div");
    const time = new Date().toLocaleTimeString();
    line.innerHTML = `<b>${escapeHtml(kind)}</b> ${time} — ${escapeHtml(text)}`;
    box.prepend(line);
    while (box.children.length > MAX_LOG) box.lastChild.remove();
  }

  function escapeHtml(value) {
    return String(value).replace(
      /[&<>"']/g,
      (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]
    );
  }

  function setStatus(text, cls) {
    const pill = el("status");
    if (!pill) return;
    pill.textContent = text;
    pill.className = `pill ${cls || "pill--idle"}`;
  }

  function toLocalInput(date) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
      date.getHours()
    )}:${pad(date.getMinutes())}`;
  }

  function applyPreset(kind) {
    const now = new Date();
    const hours = { "1h": 1, "12h": 12, "24h": 24, "7d": 24 * 7 }[kind];
    if (!hours) return;
    el("from").value = toLocalInput(new Date(now.getTime() - hours * 3600 * 1000));
    el("to").value = toLocalInput(now);
  }

  function selectedTypes() {
    return queryAll("#types input:checked").map((input) => input.value);
  }

  // ----------------------------------------------------------------- rendering

  function renderMessages() {
    const list = el("messages");
    if (!list) return;
    list.innerHTML = "";

    if (!state.messages.length) {
      list.innerHTML = '<p class="muted small">Nothing here yet. Run a scan first.</p>';
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const message of state.messages) {
      const row = document.createElement("div");
      row.className = `msg ${message.status ? `msg--${message.status}` : ""}`;

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = state.selected.has(message.id);
      checkbox.disabled = message.status === "sent" || state.running;
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) state.selected.add(message.id);
        else state.selected.delete(message.id);
        updateButtons();
      });

      const main = document.createElement("div");
      main.className = "msg__main";
      main.innerHTML = `
        <div class="msg__title">
          <span class="msg__type">${escapeHtml(message.type)}</span>
          <span class="msg__preview">${escapeHtml(
            message.preview || message.threadName || "(no text)"
          )}</span>
        </div>
      `;

      const time = document.createElement("div");
      time.className = "msg__time";
      time.textContent = message.ts ? new Date(message.ts).toLocaleString() : "—";

      row.append(checkbox, main, time);
      fragment.appendChild(row);
    }
    list.appendChild(fragment);
  }

  function renderSummary() {
    const box = el("summary");
    if (!box) return;
    if (!state.summary) {
      box.textContent = "No scan yet.";
      return;
    }
    const counts = state.messages.reduce((acc, message) => {
      acc[message.type] = (acc[message.type] || 0) + 1;
      return acc;
    }, {});
    const parts = Object.entries(counts)
      .map(([type, count]) => `${count} ${type}`)
      .join(", ");

    box.innerHTML = `
      <b>${state.messages.length}</b> message(s) from your account in this window
      (${escapeHtml(parts || "none")}).<br />
      Checked conversations: <b>${state.summary.scannedThreads}</b> · selected:
      <b id="selected-count">${state.selected.size}</b>
    `;
  }

  function updateProgressBar(progress) {
    const total = progress.total || 0;
    const done = progress.done || 0;
    const percent = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
    const bar = el("bar");
    if (bar) bar.style.width = `${percent}%`;

    const stats = progress.stats || {};
    const label = el("progress-text");
    if (!label) return;
    label.textContent = total
      ? `${done}/${total} — removed ${stats.sent || 0}, failed ${stats.failed || 0}, ` +
        `skipped ${stats.skipped || 0}, throttled ${stats.rateLimited || 0}` +
        (progress.perMinute ? ` · ${progress.perMinute}/min` : "")
      : "Idle.";
  }

  function updateButtons() {
    const hasMessages = state.messages.length > 0;
    const selection = state.selected.size;

    const start = el("btn-start");
    start.disabled = state.running || !hasMessages || selection === 0;
    start.textContent = selection ? `Remove ${selection} for everyone` : "Remove for everyone";

    const pause = el("btn-pause");
    pause.disabled = !state.running;
    pause.textContent = state.paused ? "Resume" : "Pause";

    el("btn-stop").disabled = !state.running;
    el("btn-verify").disabled = state.running || !hasMessages;
    el("btn-csv").disabled = !hasMessages;
    el("btn-scan").disabled = state.running;

    const counter = el("selected-count");
    if (counter) counter.textContent = String(selection);
  }

  // -------------------------------------------------------------------- events

  function handleEvent(event) {
    switch (event.event) {
      case "status":
        if (event.status === "running") {
          state.running = true;
          state.paused = false;
          setStatus("working", "pill--busy");
          renderMessages();
        }
        if (event.status === "paused") {
          state.paused = true;
          setStatus("paused", "pill--warn");
        }
        if (event.status === "stopped") {
          state.running = false;
          setStatus("stopped", "pill--warn");
        }
        updateButtons();
        break;

      case "scan-progress":
        if (event.detail && event.detail.stage === "threads") {
          el("scan-note").textContent = `${event.detail.threadCount} conversations`;
        }
        if (event.detail && event.detail.stage === "thread") {
          el("scan-note").textContent = `checking ${event.detail.done}/${event.detail.total}…`;
        }
        break;

      case "scan-complete": {
        state.messages = (event.messages || []).map((message) => ({ ...message }));
        state.selected = new Set(state.messages.map((message) => message.id));
        state.summary = { scannedThreads: event.scannedThreads };
        state.running = false;
        setStatus("scanned", "pill--ok");
        renderSummary();
        renderMessages();
        updateButtons();
        el("scan-note").textContent = `${state.messages.length} message(s) found`;
        log(
          "SCAN",
          `${state.messages.length} message(s) in ${event.scannedThreads} conversation(s)`
        );
        if (!state.messages.length) {
          log(
            "INFO",
            "Nothing matched. Widen the time window, tick more message types, or open a chat once so its history loads."
          );
        }
        if (event.skipped && Object.keys(event.skipped).length) {
          log("WARN", `${Object.keys(event.skipped).length} conversation(s) could not be read; see Diagnose.`);
        }
        queryAll(".tab").forEach((tab) => tab.classList.toggle("is-active", tab.dataset.tab === "messages"));
        queryAll(".panel").forEach((panel) => panel.classList.toggle("is-active", panel.id === "tab-messages"));
        break;
      }

      case "progress":
        state.running = true;
        state.paused = event.status === "paused";
        updateProgressBar(event);
        updateButtons();
        break;

      case "cooldown":
        setStatus("throttled — cooling down", "pill--warn");
        log("THROTTLE", `Server asked us to slow down; pausing ${Math.round(event.ms / 1000)}s.`);
        break;

      case "rate-limited":
        log("THROTTLE", `Rate limit hit on ${event.messageId}; cooling down, retrying with one worker.`);
        break;

      case "auto-paused":
        state.paused = true;
        state.running = false;
        setStatus("paused", "pill--warn");
        log("PAUSE", `${event.reason}. Last error: ${event.lastError || "unknown"}`);
        updateButtons();
        break;

      case "job-finished": {
        state.running = false;
        state.paused = event.status === "paused";
        setStatus(
          event.status === "done" ? "finished" : event.status,
          event.status === "done" ? "pill--ok" : "pill--warn"
        );
        const stats = event.stats || {};
        log(
          "DONE",
          `${event.status} in ${Math.round((event.durationMs || 0) / 1000)}s — removed ${
            stats.sent || 0
          }, failed ${stats.failed || 0}, skipped ${stats.skipped || 0}`
        );
        updateButtons();
        break;
      }

      default:
        break;
    }
  }

  // ------------------------------------------------------------------- actions

  function buildFilters() {
    const from = el("from").value ? new Date(el("from").value) : null;
    const to = el("to").value ? new Date(el("to").value) : null;
    return {
      from: from ? from.getTime() : null,
      to: to ? to.getTime() : null,
      types: selectedTypes(),
      onlyMine: true,
      skipUnsendable: true,
    };
  }

  async function doScan() {
    if (state.running) return;
    el("btn-scan").disabled = true;
    el("scan-note").textContent = "scanning…";
    setStatus("scanning", "pill--busy");

    const res = await callPage("SCAN", {
      filters: buildFilters(),
      scope: el("scope").value,
      deep: el("deep").checked,
      concurrency: Number(el("parallel").value) || 6,
    });

    el("btn-scan").disabled = false;

    if (!res || res.error) {
      el("scan-note").textContent = "";
      setStatus("scan failed", "pill--err");
      log("ERROR", res.error || "unknown error");
      el("diag-out").textContent = res.error || "unknown error";
      return;
    }

    // Events normally paint the list; this covers a dropped event.
    if (res.result && !state.messages.length) {
      state.messages = res.result.messages || [];
      state.selected = new Set(state.messages.map((message) => message.id));
      state.summary = { scannedThreads: res.result.scannedThreads };
      renderSummary();
      renderMessages();
    }
    updateButtons();
  }

  async function doStart() {
    if (!state.selected.size) return;
    const ids = Array.from(state.selected);
    const confirmed = window.confirm(
      `Remove ${ids.length} message(s) for everyone?\n\n` +
        'They disappear for the other person too and show as "This message was deleted". ' +
        "This cannot be undone."
    );
    if (!confirmed) return;

    state.running = true;
    updateButtons();
    setStatus("working", "pill--busy");

    const res = await callPage("UNSEND", {
      ids,
      concurrency: Number(el("parallel").value) || 6,
      cap: Number(el("cap").value) || 0,
    });

    if (!res || res.error) {
      state.running = false;
      setStatus("failed", "pill--err");
      log("ERROR", res.error || "unknown error");
      updateButtons();
    }
  }

  async function doPauseToggle() {
    const res = await callPage(state.paused ? "RESUME" : "PAUSE");
    if (res && res.result) {
      state.paused = res.result.status === "paused";
      log("INFO", state.paused ? "Paused." : "Resumed.");
      updateButtons();
    }
  }

  async function doStop() {
    await callPage("STOP");
    log("INFO", "Stop requested — finishing the requests already in flight.");
  }

  async function doVerify() {
    const ids = state.messages.filter((message) => message.status === "sent").map((m) => m.id);
    if (!ids.length) {
      log("INFO", "Nothing has been removed yet in this session.");
      return;
    }
    const res = await callPage("VERIFY", { ids });
    if (!res || res.error) {
      log("ERROR", res.error || "verification failed");
      return;
    }
    const report = res.result;
    log(
      "VERIFY",
      `${report.checked} checked — ${report.gone + report.alreadyUnsent} removed, ${
        report.stillThere.length
      } still present`
    );
    if (report.stillThere.length) {
      log("WARN", `Still visible: ${report.stillThere.slice(0, 5).join(", ")}`);
    }
  }

  function exportCsv() {
    const header = ["thread", "type", "sent_at", "status", "message_id", "preview"];
    const escape = (value) => {
      const text = value == null ? "" : String(value);
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const csv = [
      header.join(","),
      ...state.messages.map((message) =>
        [
          message.threadKey,
          message.type,
          message.ts ? new Date(message.ts).toISOString() : "",
          message.status || "not attempted",
          message.id,
          message.preview,
        ]
          .map(escape)
          .join(",")
      ),
    ].join("\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `messenger-unsend-${new Date()
      .toISOString()
      .slice(0, 19)
      .replace(/[:T]/g, "-")}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    log("INFO", `Exported ${state.messages.length} row(s) to CSV.`);
  }

  async function doDiagnostics(full) {
    const res = await callPage(full ? "DIAG" : "CAPS");
    if (!res || res.error) {
      el("diag-out").textContent = res.error || "no answer from the page";
      return;
    }
    el("diag-out").textContent = JSON.stringify(res.result, null, 2);
  }

  // --------------------------------------------------------------------- setup

  const KEY_SETTINGS = "mbu_settings";

  async function restoreSettings() {
    let settings = null;
    try {
      const stored = await chrome.storage.local.get(KEY_SETTINGS);
      settings = stored[KEY_SETTINGS] || null;
    } catch {
      settings = null;
    }

    if (settings && settings.from) {
      el("from").value = settings.from;
      el("to").value = settings.to;
      if (settings.scope) el("scope").value = settings.scope;
      if (settings.types) {
        queryAll("#types input").forEach((input) => {
          input.checked = settings.types.includes(input.value);
        });
      }
      if (settings.concurrency) el("parallel").value = settings.concurrency;
    } else {
      applyPreset("24h");
    }
  }

  function saveSettings() {
    try {
      chrome.storage.local.set({
        [KEY_SETTINGS]: {
          from: el("from").value,
          to: el("to").value,
          scope: el("scope").value,
          types: selectedTypes(),
          concurrency: Number(el("parallel").value) || 6,
        },
      });
    } catch {
      /* storage unavailable: settings simply do not persist */
    }
  }

  async function connect() {
    const res = await callPage("PING");
    if (res && res.result && res.result.alive) {
      setStatus("connected", "pill--ok");
      return true;
    }
    setStatus("page not ready", "pill--err");
    log("ERROR", (res && res.error) || "The page-side runtime did not answer. Reload the Messenger tab.");
    return false;
  }

  function wireUi() {
    queryAll(".tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        queryAll(".tab").forEach((other) => other.classList.toggle("is-active", other === tab));
        queryAll(".panel").forEach((panel) => {
          panel.classList.toggle("is-active", panel.id === `tab-${tab.dataset.tab}`);
        });
      });
    });

    ["from", "to", "scope", "types"].forEach((id) => {
      const node = el(id);
      if (node) node.addEventListener("change", saveSettings);
    });

    el("parallel").addEventListener("change", () => {
      const value = Math.max(1, Math.min(20, Number(el("parallel").value) || 6));
      el("parallel").value = value;
      saveSettings();
    });

    queryAll("[data-preset]").forEach((button) => {
      button.addEventListener("click", () => {
        applyPreset(button.dataset.preset);
        saveSettings();
      });
    });

    el("btn-scan").addEventListener("click", doScan);
    el("btn-start").addEventListener("click", doStart);
    el("btn-pause").addEventListener("click", doPauseToggle);
    el("btn-stop").addEventListener("click", doStop);
    el("btn-verify").addEventListener("click", doVerify);
    el("btn-csv").addEventListener("click", exportCsv);
    el("btn-caps").addEventListener("click", () => doDiagnostics(false));
    el("btn-diag").addEventListener("click", () => doDiagnostics(true));
    el("btn-copy").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(el("diag-out").textContent || "");
        log("INFO", "Report copied.");
      } catch {
        log("ERROR", "Clipboard is blocked here; select the text manually.");
      }
    });

    el("select-all").addEventListener("change", (event) => {
      state.selected = new Set(
        event.target.checked
          ? state.messages.filter((message) => message.status !== "sent").map((m) => m.id)
          : []
      );
      renderMessages();
      renderSummary();
      updateButtons();
    });
  }

  /** Mount the panel into a shadow root (or any container) and start it. */
  async function mount(root) {
    if (state.mounted) return;
    state.mounted = true;
    state.root = root;

    wireUi();
    await restoreSettings();
    const connected = await connect();
    if (connected) log("INFO", "Connected to this Messenger tab.");
    updateButtons();
  }

  globalThis.__MBU_UI__ = { mount, state };
})();
