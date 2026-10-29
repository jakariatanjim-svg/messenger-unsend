/*
 * Side panel.
 *
 * Talks to the page through the bridge and drives the scan/unsend job. All
 * destructive actions stay behind the explicit button on the Messages tab.
 */

const MESSENGER_URL = /^https:\/\/(www\.)?(messenger\.com|facebook\.com\/messages)/;
const MAX_LOG = 200;

const el = (id) => document.getElementById(id);

const state = {
  messages: [],
  selected: new Set(),
  status: "idle",
  running: false,
  paused: false,
  summary: null,
};

// ------------------------------------------------------------------- utilities

function log(kind, text) {
  const line = document.createElement("div");
  const time = new Date().toLocaleTimeString();
  line.innerHTML = `<b>${escapeHtml(kind)}</b> ${time} — ${escapeHtml(text)}`;
  el("log").prepend(line);
  while (el("log").children.length > MAX_LOG) el("log").lastChild.remove();
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]
  );
}

function setStatus(text, cls) {
  const pill = el("status");
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
  const span = { "1h": 1, "12h": 12, "24h": 24, "7d": 24 * 7 }[kind];
  const start = new Date(now.getTime() - span * 3600 * 1000);
  el("from").value = toLocalInput(start);
  el("to").value = toLocalInput(now);
}

function selectedTypes() {
  return Array.from(el("types").querySelectorAll("input:checked")).map((input) => input.value);
}

function activeTab() {
  return chrome.runtime.sendMessage({ target: "mbu-bg", kind: "active-tab" }).then((res) => res && res.result);
}

async function callPage(kind, payload) {
  const tab = await activeTab();
  if (!tab || !tab.id) return { error: "No active tab." };
  if (!MESSENGER_URL.test(tab.url || "")) {
    return { error: "Open Messenger (messenger.com) in this window first, then try again." };
  }
  try {
    return await chrome.tabs.sendMessage(tab.id, { target: "mbu-bridge", kind, payload });
  } catch (error) {
    return {
      error: `Cannot reach the page: ${String((error && error.message) || error)}. Reload the Messenger tab.`,
    };
  }
}

// ------------------------------------------------------------------ rendering

function renderMessages() {
  const list = el("messages");
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
        <span class="msg__preview">${escapeHtml(message.preview || message.threadName || "(no text)")}</span>
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
    Checked threads: <b>${state.summary.scannedThreads}</b> · source:
    ${escapeHtml(state.summary.source)} · selected: <b id="selected-count">${state.selected.size}</b>
  `;
}

function updateProgressBar(progress) {
  const total = progress.total || 0;
  const done = progress.done || 0;
  const percent = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  el("bar").style.width = `${percent}%`;

  const stats = progress.stats || {};
  el("progress-text").textContent = total
    ? `${done}/${total} — removed ${stats.sent || 0}, failed ${stats.failed || 0}, ` +
      `skipped ${stats.skipped || 0}, throttled ${stats.rateLimited || 0}` +
      (progress.perMinute ? ` · ${progress.perMinute}/min` : "")
    : "Idle.";
}

function updateButtons() {
  const hasMessages = state.messages.length > 0;
  const selection = state.selected.size;
  el("btn-start").disabled = state.running || !hasMessages || selection === 0;
  el("btn-start").textContent = selection
    ? `Remove ${selection} for everyone`
    : "Remove for everyone";
  el("btn-pause").disabled = !state.running;
  el("btn-pause").textContent = state.paused ? "Resume" : "Pause";
  el("btn-stop").disabled = !state.running;
  el("btn-verify").disabled = state.running || !hasMessages;
  el("btn-csv").disabled = !hasMessages;
  el("btn-scan").disabled = state.running;

  const counter = document.getElementById("selected-count");
  if (counter) counter.textContent = String(selection);
}

// ---------------------------------------------------------------------- events

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.from !== "mbu-relay" || !message.payload) return;

  const event = message.payload;
  switch (event.event) {
    case "status":
      state.status = event.status;
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
      break;

    case "scan-complete": {
      state.messages = (event.messages || []).map((m) => ({ ...m }));
      state.selected = new Set(state.messages.map((m) => m.id));
      state.summary = {
        scannedThreads: event.scannedThreads,
        source: event.source,
      };
      state.running = false;
      setStatus("scanned", "pill--ok");
      renderSummary();
      renderMessages();
      updateButtons();
      el("scan-note").textContent = `${state.messages.length} message(s) found`;
      log("SCAN", `${state.messages.length} message(s) in ${event.scannedThreads} conversation(s) via ${event.source}`);
      document.querySelector('[data-tab="messages"]').click();
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
      log("THROTTLE", `Rate limit hit on ${event.messageId}; cooling down and retrying with 1 worker.`);
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
        `${event.status} in ${Math.round((event.durationMs || 0) / 1000)}s — removed ${stats.sent || 0}, ` +
          `failed ${stats.failed || 0}, skipped ${stats.skipped || 0}`
      );
      updateButtons();
      break;
    }

    case "tab-closed":
      setStatus("messenger tab closed", "pill--err");
      break;

    default:
      break;
  }
});

// -------------------------------------------------------------------- actions

async function connect() {
  const res = await callPage("PING");
  if (res && res.result && res.result.alive) {
    setStatus("connected", "pill--ok");
    return true;
  }
  setStatus("open messenger.com", "pill--err");
  return false;
}

function buildFilters() {
  const fromValue = el("from").value ? new Date(el("from").value) : null;
  const toValue = el("to").value ? new Date(el("to").value) : null;
  return {
    from: fromValue ? fromValue.getTime() : null,
    to: toValue ? toValue.getTime() : null,
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

  const payload = {
    filters: buildFilters(),
    scope: el("scope").value,
    deep: el("deep").checked,
    concurrency: Number(el("parallel").value) || 6,
  };

  const res = await callPage("SCAN", payload);
  if (!res || res.error) {
    el("scan-note").textContent = "";
    el("btn-scan").disabled = false;
    setStatus("scan failed", "pill--err");
    log("ERROR", (res && res.error) || "unknown error");
    el("diag-out").textContent = (res && res.error) || "unknown error";
    return;
  }
  // The scan-complete event normally paints the list; this covers the case
  // where events could not be delivered.
  if (res.result && !state.messages.length) {
    state.messages = res.result.messages || [];
    state.selected = new Set(state.messages.map((m) => m.id));
    state.summary = { scannedThreads: res.result.scannedThreads, source: res.result.source };
    renderSummary();
    renderMessages();
  }
  el("btn-scan").disabled = false;
  updateButtons();
}

async function doStart() {
  if (!state.selected.size) return;
  const ids = Array.from(state.selected);
  const confirmed = window.confirm(
    `Remove ${ids.length} message(s) for everyone?\n\n` +
      "They disappear for the other person too, and show as \"This message was deleted\". " +
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
    log("ERROR", (res && res.error) || "unknown error");
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
  const ids = state.messages.filter((m) => m.status === "sent").map((m) => m.id);
  if (!ids.length) {
    log("INFO", "Nothing has been removed yet in this session.");
    return;
  }
  const res = await callPage("VERIFY", { ids });
  if (!res || res.error) {
    log("ERROR", (res && res.error) || "verification failed");
    return;
  }
  const report = res.result;
  log(
    "VERIFY",
    `${report.checked} checked — ${report.gone + report.alreadyUnsent} removed, ${report.stillThere.length} still present`
  );
  if (report.stillThere.length) {
    log("WARN", `Still visible: ${report.stillThere.slice(0, 5).join(", ")}`);
  }
}

function exportCsv() {
  const rows = state.messages.map((message) => ({
    ...message,
    status: message.status || "not attempted",
  }));
  const header = ["thread", "type", "sent_at", "status", "message_id", "preview"];
  const escape = (value) => {
    const text = value == null ? "" : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const csv = [
    header.join(","),
    ...rows.map((row) =>
      [
        row.threadKey,
        row.type,
        row.ts ? new Date(row.ts).toISOString() : "",
        row.status,
        row.id,
        row.preview,
      ]
        .map(escape)
        .join(",")
    ),
  ].join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `messenger-unsend-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
  link.click();
  URL.revokeObjectURL(url);
  log("INFO", `Exported ${rows.length} row(s) to CSV.`);
}

async function doDiagnostics(full) {
  const res = await callPage(full ? "DIAG" : "CAPS");
  if (!res || res.error) {
    el("diag-out").textContent = (res && res.error) || "no answer from the page";
    return;
  }
  el("diag-out").textContent = JSON.stringify(res.result, null, 2);
}

// ----------------------------------------------------------------------- setup

function initTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("is-active", t === tab));
      document.querySelectorAll(".panel").forEach((panel) => {
        panel.classList.toggle("is-active", panel.id === `tab-${tab.dataset.tab}`);
      });
    });
  });
}

async function restoreSettings() {
  const stored = await chrome.runtime.sendMessage({ target: "mbu-bg", kind: "get-settings" });
  const settings = (stored && stored.result) || null;

  if (settings && settings.from) {
    el("from").value = settings.from;
    el("to").value = settings.to;
    if (settings.scope) el("scope").value = settings.scope;
    if (settings.types) {
      el("types")
        .querySelectorAll("input")
        .forEach((input) => (input.checked = settings.types.includes(input.value)));
    }
    if (settings.concurrency) el("parallel").value = settings.concurrency;
  } else {
    applyPreset("24h");
  }
}

function saveSettings() {
  chrome.runtime.sendMessage({
    target: "mbu-bg",
    kind: "save-settings",
    payload: {
      from: el("from").value,
      to: el("to").value,
      scope: el("scope").value,
      types: selectedTypes(),
      concurrency: Number(el("parallel").value) || 6,
    },
  });
}

async function boot() {
  initTabs();
  await restoreSettings();

  el("from").addEventListener("change", saveSettings);
  el("to").addEventListener("change", saveSettings);
  el("scope").addEventListener("change", saveSettings);
  el("types").addEventListener("change", saveSettings);
  el("parallel").addEventListener("change", () => {
    const value = Math.max(1, Math.min(20, Number(el("parallel").value) || 6));
    el("parallel").value = value;
    saveSettings();
  });

  document.querySelectorAll("[data-preset]").forEach((button) => {
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
    const checked = event.target.checked;
    state.selected = new Set(
      checked ? state.messages.filter((m) => m.status !== "sent").map((m) => m.id) : []
    );
    renderMessages();
    renderSummary();
    updateButtons();
  });

  const connected = await connect();
  log(
    "INFO",
    connected
      ? "Connected to the Messenger tab."
      : "No Messenger tab found. Open messenger.com, then press Check connection on the Diagnose tab."
  );
  updateButtons();
}

document.addEventListener("DOMContentLoaded", boot);
