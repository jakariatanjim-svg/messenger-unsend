/*
 * Scanner (MAIN world).
 *
 * Finds your own messages inside a date/time window, across one conversation or
 * the whole inbox. Strategy order:
 *   1. the page's local message table (fast, no network, no UI clicking)
 *   2. the rendered conversation DOM (fallback when the table cannot be read)
 *
 * The scanner never deletes anything.
 */

(function () {
  "use strict";

  const NS = (globalThis.__MBU__ = globalThis.__MBU__ || {});
  if (NS.scan) return;

  const CORE = globalThis.MBU_CORE;

  // ------------------------------------------------------------- thread list

  function parseThreadKeyFromHref(href) {
    const match = /\/t\/([0-9]{1,24})/.exec(href || "");
    return match ? match[1] : null;
  }

  /** Threads visible in the sidebar, in display order. */
  function threadsFromDom() {
    const seen = new Map();
    document.querySelectorAll('a[href*="/t/"]').forEach((anchor) => {
      const key = parseThreadKeyFromHref(anchor.getAttribute("href"));
      if (!key || seen.has(key)) return;
      const label =
        anchor.getAttribute("aria-label") ||
        (anchor.querySelector("span") && anchor.querySelector("span").textContent) ||
        "";
      seen.set(key, {
        threadKey: key,
        name: String(label).trim().slice(0, 80),
        isE2ee: false,
        chatJid: null,
        lastTs: 0,
        source: "dom",
      });
    });
    return Array.from(seen.values());
  }

  /** Give the inbox a chance to load more rows before reading the DOM again. */
  async function scrollInbox(rounds = 3, onTick) {
    const container =
      document.querySelector('[role="grid"]') ||
      document.querySelector('[aria-label*="Conversations"]') ||
      document.querySelector('[aria-label*="Chats"]');
    if (!container) return 0;

    for (let i = 0; i < rounds; i += 1) {
      container.scrollTop = container.scrollHeight;
      await new Promise((resolve) => setTimeout(resolve, 350));
      if (onTick) onTick(threadsFromDom().length);
    }
    return threadsFromDom().length;
  }

  async function listThreads({ scope = "inbox", allowDom = true } = {}) {
    if (scope === "open") {
      const key = parseThreadKeyFromHref(location.href);
      return key ? [{ threadKey: key, name: "current conversation", isE2ee: false, source: "url" }] : [];
    }

    let threads = [];
    try {
      const rows = await NS.api.readTable("threads", { limit: 4000 });
      threads = rows.map((row) => CORE.parseThreadRow(row)).filter(Boolean);
      threads.forEach((thread) => (thread.source = "db"));
    } catch {
      threads = [];
    }

    if (allowDom) {
      const seen = new Set(threads.map((t) => t.threadKey));
      for (const thread of threadsFromDom()) {
        if (!seen.has(thread.threadKey)) {
          seen.add(thread.threadKey);
          threads.push(thread);
        }
      }
    }

    return threads;
  }

  // ------------------------------------------------------------ message rows

  let messageRowsCache = null;
  let messageRowsAt = 0;

  async function readAllMessages({ maxAgeMs = 60000 } = {}) {
    if (messageRowsCache && Date.now() - messageRowsAt < maxAgeMs) return messageRowsCache;
    const rows = await NS.api.readTable("messages", { limit: 40000 });
    messageRowsCache = rows;
    messageRowsAt = Date.now();
    return rows;
  }

  function invalidateMessages() {
    messageRowsCache = null;
  }

  function messagesFromRows(rows, threadKeys, filters, myUserId) {
    const wanted = threadKeys ? new Set(threadKeys) : null;
    const out = [];

    for (const row of rows) {
      const message = CORE.parseMessageRow(row);
      if (!message) continue;
      if (wanted && message.threadKey && !wanted.has(message.threadKey)) continue;
      if (message.isUnsent || message.isAdmin) continue;
      if (!message.ts) continue;
      if (!CORE.matchesFilters(message, filters, myUserId)) continue;
      // Plain rows need a thread key for the unsend call. Encrypted rows are
      // addressed by their own id, so a missing key is fine there.
      if (!message.threadKey && !CORE.parseE2eeMessageId(message.id)) continue;
      out.push(message);
    }

    out.sort((a, b) => a.ts - b.ts);
    return out;
  }

  // --------------------------------------------------------------- DOM reader

  function timestampFromNode(node) {
    const candidates = [
      node.getAttribute && node.getAttribute("data-timestamp"),
      node.querySelector && node.querySelector("[data-timestamp]")?.getAttribute("data-timestamp"),
      node.querySelector && node.querySelector("time")?.getAttribute("datetime"),
      node.getAttribute && node.getAttribute("aria-label"),
      node.closest && node.closest("[data-testid]")?.getAttribute("data-timestamp"),
    ];

    for (const candidate of candidates) {
      if (!candidate) continue;
      const numeric = Number(candidate);
      if (Number.isFinite(numeric) && numeric > 0) return CORE.normalizeTs(numeric);
      const parsed = Date.parse(candidate);
      if (Number.isFinite(parsed)) return parsed;
    }
    return 0;
  }

  /**
   * Fallback: read the conversation that is currently on screen. Slower and
   * less complete than the database, but it survives schema changes.
   */
  function messagesFromDom(filters, myUserId) {
    const threadKey = parseThreadKeyFromHref(location.href);
    if (!threadKey) return [];

    const nodes = document.querySelectorAll(
      '[data-message-id], [data-id^="mid."], [role="row"][data-testid*="message"]'
    );
    const out = [];
    const seen = new Set();

    nodes.forEach((node) => {
      const id =
        node.getAttribute("data-message-id") ||
        node.getAttribute("data-id") ||
        node.id ||
        "";
      if (!id || seen.has(id)) return;
      seen.add(id);

      const hasVideo = !!node.querySelector("video");
      const hasImage = !!node.querySelector("img");
      const text = (node.innerText || "").trim();

      const message = {
        id,
        threadKey,
        ts: timestampFromNode(node),
        type: hasVideo ? "video" : hasImage ? "photo" : "text",
        senderId: null,
        preview: text.replace(/\s+/g, " ").slice(0, 80),
        isUnsent: /message was deleted|আপনি একটি মেসেজ|removed a message/i.test(text),
        isAdmin: false,
        cannotUnsend: false,
        expired: false,
      };

      if (!message.ts) return;
      if (!CORE.matchesFilters(message, filters, myUserId)) return;
      out.push(message);
    });

    return out.sort((a, b) => a.ts - b.ts);
  }

  // -------------------------------------------------------------------- scan

  async function scan({ filters = {}, scope = "inbox", deep = false, onProgress } = {}) {
    const caps = await NS.api.getCapabilities();
    const myUserId = caps.identity.userId;
    const report = (stage, detail) => {
      if (typeof onProgress === "function") onProgress({ stage, ...detail });
    };

    report("capabilities", { caps });

    const threads = await listThreads({ scope, allowDom: scope !== "open" });
    report("threads", { threadCount: threads.length });

    let messages = [];
    let source = "db";

    if (deep && scope === "inbox") {
      // Give the client a moment to page in more rows before reading the table.
      await scrollInbox(2, (count) => report("inbox-scroll", { threadCount: count }));
    }

    try {
      const rows = await readAllMessages();
      if (!rows.length) throw new Error("message table returned no rows");
      const threadKeys = scope === "inbox" ? null : threads.map((thread) => thread.threadKey);
      messages = messagesFromRows(rows, threadKeys, filters, myUserId);
      report("messages", { rowCount: rows.length, matched: messages.length });
    } catch (error) {
      source = "dom";
      report("db-unavailable", { error: String((error && error.message) || error) });
      messages = messagesFromDom(filters, myUserId);
      report("messages", { rowCount: messages.length, matched: messages.length });
    }

    // Attach the thread's protocol so the engine knows which unsend path to use.
    const threadIndex = new Map(threads.map((thread) => [thread.threadKey, thread]));
    for (const message of messages) {
      const thread = threadIndex.get(message.threadKey);
      const e2ee = CORE.parseE2eeMessageId(message.id);
      message.protocol = e2ee ? "e2ee" : thread && thread.isE2ee ? "e2ee" : "plain";
      message.chatJid = e2ee ? e2ee.chatJid : (thread && thread.chatJid) || null;
      message.threadName = (thread && thread.name) || "";
    }

    return {
      source,
      myUserId,
      scannedThreads: threads.length,
      messages,
      capabilities: caps,
      filters,
    };
  }

  NS.scan = {
    scan,
    listThreads,
    threadsFromDom,
    scrollInbox,
    messagesFromDom,
    invalidateMessages,
  };
})();
