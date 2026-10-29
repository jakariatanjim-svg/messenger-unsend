/*
 * Messenger Bulk Unsend - side panel UI
 * -------------------------------------
 * Stage 1 scope: prove the request-capture + replay pipeline against the live
 * page. The bulk engine consumes the same captured recipe in stage 2.
 */

const MESSENGER_MATCH = /^https:\/\/(www\.)?(messenger\.com|facebook\.com\/messages)/;

const el = (id) => document.getElementById(id);
const state = {
  tabId: null,
  ops: {},
  selectedOp: null,
};

// ------------------------------------------------------------------- helpers

function log(kind, message) {
  const line = document.createElement("div");
  line.className = "logline";
  const time = new Date().toLocaleTimeString();
  line.innerHTML = `<b>${kind}</b> ${time} — ${escapeHtml(message)}`;
  el("log").prepend(line);
  while (el("log").children.length > 200) el("log").lastChild.remove();
  chrome.runtime.sendMessage({ target: "mbu-bg", kind: "log", payload: { kind, message } });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function setStatus(text, cls) {
  const node = el("status");
  node.textContent = text;
  node.className = `pill ${cls}`;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function sendToBridge(kind, payload) {
  const tab = await activeTab();
  if (!tab || !tab.id) return { error: "no active tab" };
  if (!MESSENGER_MATCH.test(tab.url || "")) {
    return { error: "Open messenger.com (or facebook.com/messages) in this tab first." };
  }
  try {
    return await chrome.tabs.sendMessage(tab.id, { target: "mbu-bridge", kind, payload });
  } catch (e) {
    return { error: `bridge unreachable: ${String((e && e.message) || e)}` };
  }
}

// -------------------------------------------------------------------- capture

async function refreshOps() {
  const local = await chrome.runtime.sendMessage({ target: "mbu-bg", kind: "get-ops" });
  const stored = (local && local.result) || {};

  const live = await sendToBridge("list-ops");
  const liveOps = Array.isArray(live && live.result) ? live.result : [];

  const merged = { ...stored };
  liveOps.forEach((op) => {
    merged[op.name] = { ...(merged[op.name] || {}), ...op };
  });
  state.ops = merged;
  renderOps();
  renderOpSelect();
  return merged;
}

function looksLikeUnsend(op) {
  const blob = `${op.name} ${(op.variableKeys || []).join(" ")} ${JSON.stringify(op.variables || {})}`.toLowerCase();
  return /unsend|delete|remove/.test(blob) && /mid\.\$|message_id|messageid|msg_id/.test(blob);
}

function renderOps() {
  const list = el("ops-list");
  const ops = Object.values(state.ops).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  list.innerHTML = "";

  if (!ops.length) {
    list.innerHTML =
      '<p class="muted small">No captures yet. Do one manual “Remove for everyone” in the Messenger tab, then press “Refresh captures”.</p>';
    return;
  }

  ops.forEach((op) => {
    const node = document.createElement("div");
    node.className = `op ${looksLikeUnsend(op) ? "op--suspect" : ""}`;
    node.innerHTML = `
      <div class="op__head">
        <span class="op__name">${escapeHtml(op.name)}</span>
        <button class="btn btn--tiny" data-op="${escapeHtml(op.name)}">use</button>
      </div>
      <div class="op__meta">doc_id: ${escapeHtml(op.docId || "?")} · hits: ${op.hits || 1} ·
        vars: ${escapeHtml((op.variableKeys || []).join(", ") || "—")}</div>
    `;
    node.querySelector("button").addEventListener("click", () => selectOp(op.name));
    list.appendChild(node);
  });

  const suspects = ops.filter(looksLikeUnsend);
  if (suspects.length) {
    log("OK", `Found ${suspects.length} candidate unsend operation(s).`);
  }
}

function renderOpSelect() {
  const select = el("op-select");
  const previous = select.value;
  select.innerHTML = "";
  Object.values(state.ops)
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
    .forEach((op) => {
      const option = document.createElement("option");
      option.value = op.name;
      option.textContent = op.name;
      select.appendChild(option);
    });
  if (previous && state.ops[previous]) select.value = previous;
  syncVarsFromSelect();
}

function selectOp(name) {
  if (!state.ops[name]) return;
  el("op-select").value = name;
  syncVarsFromSelect();
  document.querySelector('[data-tab="replay"]').click();
}

function syncVarsFromSelect() {
  const name = el("op-select").value;
  const op = state.ops[name];
  state.selectedOp = name;
  el("vars-input").value = op ? JSON.stringify(op.variables || {}, null, 2) : "";
}

// --------------------------------------------------------------------- replay

async function sendReplay() {
  const opName = el("op-select").value;
  if (!opName) {
    el("replay-out").textContent = "No captured operation selected.";
    return;
  }
  let variables = {};
  try {
    variables = JSON.parse(el("vars-input").value || "{}");
  } catch (e) {
    el("replay-out").textContent = `Invalid JSON: ${String((e && e.message) || e)}`;
    return;
  }

  el("replay-out").textContent = "Sending…";
  const res = await sendToBridge("replay", {
    opName,
    variables,
    keepTemplate: el("merge-template").checked,
  });

  if (!res || res.error) {
    el("replay-out").textContent = `Error: ${(res && res.error) || "unknown"}`;
    log("ERR", `Replay failed: ${(res && res.error) || "unknown"}`);
    return;
  }

  const r = res.result || {};
  el("replay-out").textContent = [
    `status: ${r.status} (${r.ms} ms)`,
    `variables sent: ${JSON.stringify(r.sentVariables)}`,
    "",
    r.body || "(empty)",
  ].join("\n");
  log(r.ok ? "OK" : "ERR", `Replay ${opName} → HTTP ${r.status} in ${r.ms} ms`);
}

// ------------------------------------------------------------------ wiring up

function initTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("is-active", t === tab));
      document.querySelectorAll(".panel").forEach((p) => {
        p.classList.toggle("is-active", p.id === `tab-${tab.dataset.tab}`);
      });
    });
  });
}

async function boot() {
  initTabs();

  el("btn-refresh-ops").addEventListener("click", async () => {
    const ops = await refreshOps();
    log("INFO", `Refreshed. ${Object.keys(ops).length} operation(s) known.`);
  });

  el("btn-clear-ops").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ target: "mbu-bg", kind: "clear-ops" });
    state.ops = {};
    renderOps();
    renderOpSelect();
    log("INFO", "Capture store cleared.");
  });

  el("op-select").addEventListener("change", syncVarsFromSelect);
  el("btn-send").addEventListener("click", sendReplay);
  el("btn-ping").addEventListener("click", async () => {
    const res = await sendToBridge("ping");
    el("replay-out").textContent = JSON.stringify(res, null, 2);
  });

  el("parallel").addEventListener("change", (e) => {
    const v = Math.max(1, Math.min(20, Number(e.target.value) || 5));
    e.target.value = v;
  });

  const tab = await activeTab();
  state.tabId = tab ? tab.id : null;

  if (!tab || !MESSENGER_MATCH.test(tab.url || "")) {
    setStatus("open messenger.com", "pill--err");
    log("INFO", "Open a Messenger conversation in this window, then press Refresh captures.");
    await refreshOps();
    return;
  }

  const ping = await sendToBridge("ping");
  if (ping && ping.result && ping.result.alive) {
    setStatus("page hooked", "pill--ok");
    log("OK", `Hook alive on ${ping.result.href}`);
  } else {
    setStatus("hook missing — reload the tab", "pill--err");
    log("ERR", (ping && ping.error) || "No reply from page hook. Reload the Messenger tab.");
  }

  await refreshOps();

  // Refresh the capture list whenever the service worker records a new op.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.from === "mbu-bg-refresh") refreshOps();
  });
}

document.addEventListener("DOMContentLoaded", boot);
