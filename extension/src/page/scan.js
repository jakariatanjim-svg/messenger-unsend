/*
 * Scanner (MAIN world).
 *
 * Walks the conversations, reads messages through the client's own query
 * builder, and keeps only rows that match the user's window, types and sender.
 *
 * The scanner never deletes anything.
 */

(function () {
  "use strict";

  const NS = (globalThis.__MBU__ = globalThis.__MBU__ || {});
  if (NS.scan) return;

  const CORE = globalThis.MBU_CORE;
  const THREAD_CONCURRENCY = 4;
  const E2EE_MAX_PAGES = 12;

  /**
   * Encrypted one-to-one chats usually keep an older plain "sibling" thread with
   * the numeric part of the jid as its key. Both halves have to be scanned.
   */
  async function expandEncryptedThreads(threads) {
    const byKey = new Map(threads.map((thread) => [thread.threadKey, thread]));
    const out = [];

    for (const thread of threads) {
      if (!thread.isE2ee) {
        out.push(thread);
        continue;
      }

      if (!thread.chatJid) {
        thread.chatJid = await NS.api.resolveChatJid(thread).catch(() => null);
      }
      out.push(thread);

      const numeric = thread.chatJid ? thread.chatJid.split("@")[0] : null;
      if (numeric && /^\d+$/.test(numeric) && numeric !== thread.threadKey) {
        const sibling = byKey.get(numeric);
        if (sibling) {
          out.push({ ...sibling, role: "legacy_sibling", name: sibling.name || thread.name });
        }
      }
    }

    return out;
  }

  function parseThreadKeyFromHref(href) {
    const match = /\/t\/([0-9]{1,24})/.exec(href || "");
    return match ? match[1] : null;
  }

  // ------------------------------------------------------------------ gather

  async function listThreads({ scope = "inbox", loadMore = false } = {}) {
    if (scope === "open") {
      const key = parseThreadKeyFromHref(location.href);
      if (!key) return [];
      const threads = await NS.api.readThreads().catch(() => []);
      const found = threads.find((thread) => thread.threadKey === key);
      return [found || { threadKey: key, name: "current conversation", isE2ee: false }];
    }

    let threads = await NS.api.readThreads();

    if (loadMore) {
      const more = await NS.api.loadMoreThreads();
      if (more && more.added) threads = await NS.api.readThreads();
    }

    const supported = threads.filter((thread) => thread.isOneToOne || thread.isGroup);
    return expandEncryptedThreads(supported);
  }

  /**
   * Encrypted threads page their history in from the encrypted message service.
   * Pull pages until the window is covered, the history ends, or we hit the cap.
   */
  function oldestTimestamp(rows) {
    return rows.reduce((min, row) => {
      const ts = CORE.normalizeTs(row.timestampMs);
      return ts && (!min || ts < min) ? ts : min;
    }, 0);
  }

  async function extendEncryptedHistory(thread, fromTs, onProgress) {
    if (!thread.isE2ee) return false;
    if (!NS.api.e2eeLoadingAvailable()) return false;

    const chatJid = thread.chatJid || thread.threadKey;
    let cursor = null;
    let loaded = false;

    for (let page = 0; page < E2EE_MAX_PAGES; page += 1) {
      const cached = await NS.api.readThreadMessages(thread.threadKey, {
        descending: true,
        limit: 400,
      });
      const oldest = oldestTimestamp(cached);
      if (cached.length && oldest && oldest <= fromTs) break;

      const result = await NS.api.loadEncryptedPage(chatJid, cursor);
      loaded = true;
      if (onProgress) onProgress({ stage: "e2ee-page", thread: thread.threadKey, page: page + 1 });

      if (!result.hasNext || !result.endCursor) break;
      cursor = result.endCursor;
    }

    return loaded;
  }

  /** Read everything the local table has for one thread inside the window. */
  async function readThreadWindow(thread, filters, { deep }) {
    let rows = await NS.api.readThreadMessages(thread.threadKey, {
      descending: true,
      fromTs: filters.from,
      toTs: filters.to,
      limit: 1200,
    });

    // The window may sit further back than what the client has cached.
    if (deep && !rows.length && filters.from != null) {
      const requested = await NS.api.requestOlderMessages(thread.threadKey, filters.from);
      if (requested.requested) {
        const started = Date.now();
        while (Date.now() - started < 5000) {
          await new Promise((resolve) => setTimeout(resolve, 300));
          rows = await NS.api.readThreadMessages(thread.threadKey, {
            descending: true,
            fromTs: filters.from,
            toTs: filters.to,
            limit: 1200,
          });
          if (rows.length) break;
        }
      }
    }

    return rows;
  }

  // ---------------------------------------------------------------- analysing

  function toMessages(rows, thread, attachments, filters, myUserId) {
    const out = [];

    for (const row of rows) {
      const messageId = row.messageId;
      if (!messageId) continue;

      const attached = attachments[messageId] || null;
      const parsed = CORE.parseMessageRow(
        attached ? { ...row, attachments: attached } : row,
        { fallbackThreadKey: thread.threadKey }
      );
      if (!parsed) continue;
      if (parsed.isUnsent || parsed.isAdmin) continue;
      if (!CORE.matchesFilters(parsed, filters, myUserId)) continue;

      const e2ee = CORE.parseE2eeMessageId(messageId);
      parsed.protocol = e2ee || thread.isE2ee ? "e2ee" : "plain";
      parsed.chatJid = e2ee ? e2ee.chatJid : thread.isE2ee ? thread.threadKey : null;
      parsed.threadName = thread.name || "";
      parsed.threadKey = thread.threadKey;
      out.push(parsed);
    }

    return out;
  }

  // -------------------------------------------------------------------- scan

  async function scan({ filters = {}, scope = "inbox", deep = false, onProgress } = {}) {
    const report = (stage, detail) => {
      if (typeof onProgress === "function") onProgress({ stage, ...detail });
    };

    const caps = await NS.api.getCapabilities();
    const myUserId = caps.identity.userId;
    report("capabilities", { caps });

    const threads = await listThreads({ scope, loadMore: deep });
    report("threads", { threadCount: threads.length });

    const messages = [];
    const seenMessages = new Set();
    const handledThreads = new Set();
    const skipped = {};
    let scanned = 0;

    async function handleThread(thread) {
      try {
        // A conversation whose last activity is older than the window cannot
        // contain a match, so there is nothing to read.
        if (filters.from != null && thread.lastActivityMs && thread.lastActivityMs < filters.from) {
          scanned += 1;
          report("thread", {
            done: scanned,
            total: threads.length,
            thread: thread.name || thread.threadKey,
            found: 0,
            skippedReason: "outside window",
          });
          return;
        }

        if (thread.isE2ee && deep && caps.e2eeHistory && filters.from != null) {
          await extendEncryptedHistory(thread, filters.from, report);
        }

        const rows = await readThreadWindow(thread, filters, { deep });
        const attachments = rows.length ? await NS.api.readAttachments(thread.threadKey) : {};
        const found = toMessages(rows, thread, attachments, filters, myUserId);
        const fresh = [];
        for (const message of found) {
          if (seenMessages.has(message.id)) continue;
          seenMessages.add(message.id);
          fresh.push(message);
        }
        messages.push(...fresh);
        scanned += 1;
        report("thread", {
          done: scanned,
          total: threads.length,
          thread: thread.name || thread.threadKey,
          found: fresh.length,
        });
      } catch (error) {
        skipped[thread.threadKey] = String((error && error.message) || error);
        report("thread-error", {
          thread: thread.threadKey,
          error: skipped[thread.threadKey],
        });
      } finally {
        handledThreads.add(thread.threadKey);
      }
    }

    const queue = threads.slice();
    const workers = Array.from({ length: Math.min(THREAD_CONCURRENCY, queue.length) }, async () => {
      for (;;) {
        const thread = queue.shift();
        if (!thread) return;
        if (handledThreads.has(thread.threadKey)) continue;
        await handleThread(thread);
      }
    });
    await Promise.all(workers);

    messages.sort((a, b) => a.ts - b.ts);
    report("messages", { matched: messages.length, scannedThreads: scanned });

    return {
      source: caps.database ? "database" : "unavailable",
      myUserId,
      scannedThreads: scanned,
      messages,
      skipped,
      capabilities: caps,
      filters,
    };
  }

  NS.scan = {
    scan,
    listThreads,
    parseThreadKeyFromHref,
  };
})();
