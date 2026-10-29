/*
 * Runtime access layer (MAIN world).
 *
 * Messenger's web client keeps its own local database. Data is only reachable
 * through the client's ReQL query builder — the table objects themselves are
 * schema descriptors, not row collections.
 *
 * Everything here is read-only, and nothing leaves the browser.
 */

(function () {
  "use strict";

  const CORE = globalThis.MBU_CORE;
  const NS = (globalThis.__MBU__ = globalThis.__MBU__ || {});
  if (NS.api) return;

  const MODULES = {
    i64: "I64",
    intEnum: "LSIntEnum",
    store: "LSDatabaseSingleton",
    factory: "LSFactory",
    plainUnsend: "LSOptimisticUnsendMessageStoredProcedure",
    plainUnsendPreload: "MWV2OnlyGlobalRemoveMessageDialog.entrypoint",
    e2eeBridge: "MAWBridgeSendAndReceive",
    qpl: "qpl",
    threadTypes: "LSMessagingThreadTypeUtil",
    loadMoreThreads: "loadMoreLSThreads",
    rangeQuery: "LSIssueMessagesRangeQueryStoredProcedure",
    mpsToResponse: "MpsMessageToLoadResponse",
    putMessages: "MAWPutMessagesToDB",
  };

  const probeErrors = {};

  function pageRequire() {
    const req = globalThis.require;
    return typeof req === "function" ? req : null;
  }

  function requireModule(name) {
    const req = pageRequire();
    if (!req) return null;
    try {
      const mod = req(name);
      return mod == null ? null : mod;
    } catch (error) {
      probeErrors[name] = String((error && error.message) || error);
      return null;
    }
  }

  function cookieValue(name) {
    try {
      const hit = document.cookie
        .split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith(`${name}=`));
      return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null;
    } catch {
      return null;
    }
  }

  function readIdentity() {
    const currentUser = requireModule("CurrentUserInitialData");
    const fromCookie = cookieValue("c_user");
    const rawId = (currentUser && (currentUser.ACCOUNT_ID || currentUser.USER_ID)) || fromCookie;
    const id = rawId && String(rawId) !== "0" ? String(rawId) : null;
    return { userId: id, source: currentUser ? "module" : fromCookie ? "cookie" : "none" };
  }

  // ------------------------------------------------------------------ runtime

  let runtimePromise = null;

  function withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  /**
   * The pieces every query needs: the ReQL builder, the I64 helper for the
   * client's 64-bit keys, and the open database singleton.
   */
  function getRuntime() {
    if (runtimePromise) return runtimePromise;

    runtimePromise = (async () => {
      if (!pageRequire()) throw new Error("page module loader (window.require) is not available yet");

      const ReQL = requireModule("ReQL");
      const I64 = requireModule(MODULES.i64);
      const singleton = requireModule(MODULES.store);
      if (!ReQL) throw new Error("ReQL module not found");
      if (!I64) throw new Error("I64 module not found");
      if (!singleton || !singleton.LSDatabaseSingleton) {
        throw new Error("LSDatabaseSingleton module not found");
      }

      const store = await withTimeout(
        Promise.resolve(singleton.LSDatabaseSingleton),
        10000,
        "database"
      );
      if (!store || !store.tables) throw new Error("database opened but exposes no tables");

      return { ReQL, I64, store, LSIntEnum: requireModule(MODULES.intEnum) };
    })().catch((error) => {
      runtimePromise = null; // allow a retry after navigation
      throw error;
    });

    return runtimePromise;
  }

  // -------------------------------------------------------------- i64 helpers

  function toI64(runtime, value) {
    const { I64 } = runtime;
    if (typeof I64.of_string === "function") return I64.of_string(String(value));
    return String(value);
  }

  function i64ToString(runtime, value) {
    if (value == null) return null;
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "bigint") return String(value);
    const i64 = runtime && runtime.I64;
    if (i64 && typeof i64.to_string === "function") {
      try {
        return String(i64.to_string(value));
      } catch {
        /* fall through to the generic conversion */
      }
    }
    const text = String(value);
    return text && text !== "[object Object]" ? text : null;
  }

  function i64ToNumber(runtime, value) {
    if (value == null) return 0;
    if (typeof value === "number") return value;
    const text = i64ToString(runtime, value);
    const number = Number(text);
    return Number.isFinite(number) ? number : 0;
  }

  function i64IsZero(runtime, value) {
    if (value == null) return true;
    const text = i64ToString(runtime, value);
    return text === null || text === "0";
  }

  /** Convert the client's 64-bit wrapper objects into plain strings. */
  function normalizeRow(runtime, row) {
    if (!row || typeof row !== "object") return row;
    const out = {};
    for (const [key, value] of Object.entries(row)) {
      if (value == null || typeof value !== "object") {
        out[key] = value;
        continue;
      }
      const converted = i64ToString(runtime, value);
      out[key] = converted != null ? converted : value;
    }
    return out;
  }

  // ------------------------------------------------------------------ threads

  const THREAD_TYPE = {
    1: { isOneToOne: true, isE2ee: false },
    2: { isGroup: true, isE2ee: false },
    15: { isOneToOne: true, isE2ee: true },
    16: { isGroup: true, isE2ee: true },
  };

  function describeThreadType(runtime, threadTypeValue) {
    const numeric = i64ToNumber(runtime, threadTypeValue);
    const util = requireModule(MODULES.threadTypes);
    const call = (name) => {
      try {
        const fn = util && util[name];
        return typeof fn === "function" ? !!fn(threadTypeValue) : null;
      } catch {
        return null;
      }
    };

    const fallback = THREAD_TYPE[numeric] || {};
    const isE2ee = call("isArmadilloSecure") ?? fallback.isE2ee ?? false;
    const isOneToOne = call("isOneToOne") ?? fallback.isOneToOne ?? false;
    const isGroup = call("isGroup") ?? fallback.isGroup ?? (!isOneToOne && numeric > 0);
    return { numeric, isE2ee, isOneToOne, isGroup };
  }

  async function readThreads() {
    const runtime = await getRuntime();
    const rows = await runtime.ReQL.toArrayAsync(
      runtime.ReQL.fromTableAscending(runtime.store.tables.threads)
    );

    const out = [];
    for (const row of rows || []) {
      const parentKey = i64ToString(runtime, row.parentThreadKey);
      const folderName = typeof row.folderName === "string" ? row.folderName : "";
      // Skip sub-folders and parent containers; keep real conversations only.
      if (parentKey && parentKey !== "0") continue;
      if (folderName && folderName !== "inbox") continue;

      const kind = describeThreadType(runtime, row.threadType);
      const threadKey = i64ToString(runtime, row.threadKey);
      if (!threadKey) continue;

      out.push({
        threadKey,
        threadType: kind.numeric,
        name: typeof row.threadName === "string" ? row.threadName.trim() : "",
        isE2ee: kind.isE2ee,
        isOneToOne: kind.isOneToOne,
        isGroup: kind.isGroup,
        lastActivityMs: CORE.normalizeTs(i64ToNumber(runtime, row.lastActivityTimestampMs)),
        cannotUnsend: !i64IsZero(runtime, row.cannotUnsendReason),
      });
    }

    return out;
  }

  async function loadMoreThreads() {
    const runtime = await getRuntime();
    const loader = requireModule(MODULES.loadMoreThreads);
    if (typeof loader !== "function") return { added: 0, hasMore: false, unsupported: true };

    const count = async () =>
      (await runtime.ReQL.toArrayAsync(runtime.ReQL.fromTableAscending(runtime.store.tables.threads)))
        .length;

    const before = await count();
    try {
      await runtime.store.runInTransaction(
        (transaction) => loader(transaction, runtime.I64.zero),
        "readwrite",
        undefined,
        undefined,
        "BulkUnsendLoadThreads"
      );
    } catch (error) {
      probeErrors.loadMoreThreads = String((error && error.message) || error);
      return { added: 0, hasMore: false, error: probeErrors.loadMoreThreads };
    }

    const started = Date.now();
    while (Date.now() - started < 6000) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const now = await count();
      if (now > before) return { added: now - before, hasMore: true };
    }
    return { added: 0, hasMore: false };
  }

  // ----------------------------------------------------------------- messages

  const MESSAGE_FILTER_LIMIT = 2000;

  /**
   * Messages of one thread, keyed by (threadKey, timestampMs, messageId).
   * `getKeyRange` gives every row of the thread; a ReQL filter trims by time
   * before the rows cross into JS.
   */
  async function readThreadMessages(threadKey, options = {}) {
    const runtime = await getRuntime();
    const { descending = true, fromTs = null, toTs = null, limit = MESSAGE_FILTER_LIMIT } = options;
    const table = runtime.store.tables.messages;
    if (!table) throw new Error("messages table not found");

    const base = descending
      ? runtime.ReQL.fromTableDescending(table)
      : runtime.ReQL.fromTableAscending(table);

    let query = base.getKeyRange(toI64(runtime, threadKey));
    if (fromTs != null || toTs != null) {
      query = query.filter((row) => {
        const ts = CORE.normalizeTs(i64ToNumber(runtime, row.timestampMs));
        if (fromTs != null && ts < fromTs) return false;
        if (toTs != null && ts > toTs) return false;
        return true;
      });
    }

    const rows = await runtime.ReQL.toArrayAsync(query.take(limit));
    return (rows || []).map((row) => normalizeRow(runtime, row));
  }

  async function readMessagesByIds(threadKey, ids, options = {}) {
    if (!ids || !ids.size) return new Map();
    const rows = await readThreadMessages(threadKey, { ...options, limit: options.limit || 2000 });
    const out = new Map();
    for (const row of rows) {
      if (ids.has(row.messageId)) out.set(row.messageId, row);
    }
    return out;
  }

  async function readParticipants(threadKey) {
    const runtime = await getRuntime();
    const table = runtime.store.tables.participants;
    if (!table) return [];
    try {
      const rows = await runtime.ReQL.toArrayAsync(
        runtime.ReQL.fromTableAscending(table).getKeyRange(toI64(runtime, threadKey))
      );
      return (rows || [])
        .map((row) => i64ToString(runtime, row.contactId))
        .filter((id) => id && id !== "0");
    } catch (error) {
      probeErrors.participants = String((error && error.message) || error);
      return [];
    }
  }

  /**
   * Encrypted conversations are addressed by a "chat jid" that is not stored on
   * the thread row. It is recoverable from the newest encrypted message ids, or
   * for one-to-one chats from the other participant's id.
   */
  async function resolveChatJid(thread) {
    if (!thread) return null;
    try {
      const rows = await readThreadMessages(thread.threadKey, { descending: true, limit: 5 });
      for (const row of rows) {
        const parsed = CORE.parseE2eeMessageId(String(row.messageId || ""));
        if (parsed) return parsed.chatJid;
      }
    } catch {
      /* fall through */
    }

    if (thread.isOneToOne) {
      const me = readIdentity().userId;
      const others = (await readParticipants(thread.threadKey)).filter((id) => id !== me);
      if (others.length) return `${others[0]}@msgr`;
    }
    return null;
  }

  /** Best-effort attachment lookup; returns {} when the table cannot be read. */
  async function readAttachments(threadKey) {
    const runtime = await getRuntime();
    const table = runtime.store.tables.attachments;
    if (!table) return {};

    try {
      const rows = await runtime.ReQL.toArrayAsync(
        runtime.ReQL.fromTableAscending(table).getKeyRange(toI64(runtime, threadKey))
      );
      const byMessage = {};
      for (const row of rows || []) {
        const messageId = row.messageId;
        if (!messageId) continue;
        (byMessage[messageId] = byMessage[messageId] || []).push(normalizeRow(runtime, row));
      }
      delete probeErrors["table:attachments"];
      return byMessage;
    } catch (error) {
      probeErrors["table:attachments"] = String((error && error.message) || error);
      return {};
    }
  }

  // ------------------------------------------------------------------ loading

  /** Ask the client to fetch older plain messages around a timestamp. */
  async function requestOlderMessages(threadKey, referenceTs) {
    const runtime = await getRuntime();
    const procedure = requireModule(MODULES.rangeQuery);
    const factory = requireModule(MODULES.factory);
    if (typeof procedure !== "function" || typeof factory !== "function") {
      return { requested: false, reason: "range query unavailable" };
    }

    try {
      await runtime.store.runInTransaction(
        (transaction) =>
          procedure(factory(transaction), {
            threadKey: toI64(runtime, threadKey),
            referenceTimestampMs: toI64(runtime, Math.max(1, Math.round(referenceTs))),
            direction: runtime.LSIntEnum
              ? runtime.LSIntEnum.ofNumber(0)
              : toI64(runtime, 0),
          }),
        "readwrite",
        undefined,
        undefined,
        "BulkUnsendLoadHistory"
      );
      return { requested: true };
    } catch (error) {
      probeErrors.olderMessages = String((error && error.message) || error);
      return { requested: false, reason: probeErrors.olderMessages };
    }
  }

  // ---------------------------------------------------------------- encrypted

  function e2eeLoadingAvailable() {
    const bridge = requireModule(MODULES.e2eeBridge);
    const converter = requireModule(MODULES.mpsToResponse);
    const writer = requireModule(MODULES.putMessages);
    return (
      !!bridge &&
      typeof bridge.sendAndReceive === "function" &&
      !!converter &&
      typeof converter.messageToLoadMsgsResponse === "function" &&
      !!writer &&
      typeof writer.insertMessageResponseIntoDatabase === "function"
    );
  }

  /**
   * Encrypted conversations are not fully in the local table; each page has to
   * be pulled from the client's encrypted message service and stored first.
   */
  async function loadEncryptedPage(chatJid, cursor) {
    if (!e2eeLoadingAvailable()) throw new Error("encrypted history is not available in this build");

    const runtime = await getRuntime();
    const bridge = requireModule(MODULES.e2eeBridge);
    const converter = requireModule(MODULES.mpsToResponse);
    const writer = requireModule(MODULES.putMessages);

    const response = await bridge.sendAndReceive("mps", "mpsLoadMessages", {
      config: { includeVisibilityMetadataMessages: true },
      debug: { purpose: "load-more" },
      direction: "desc",
      from: cursor || [Date.now() + 60000, "0"],
      numMessages: 100,
      threadId: chatJid,
    });

    if (!response || response.success === false) {
      throw new Error(String((response && response.error) || "encrypted page load failed"));
    }

    const converted = converter.messageToLoadMsgsResponse(
      (response.value && response.value.messages) || [],
      null,
      { chatJid }
    );
    await writer.insertMessageResponseIntoDatabase(runtime.store, converted, Date.now());

    const ids = [];
    for (const message of converted.msgs || []) {
      if (typeof message.msgId === "string") ids.push(message.msgId);
      else if (message.externalId) ids.push(`${message.chatJid || chatJid}.${message.externalId}`);
    }

    const cursorInfo = response.value && response.value.cursorInfo;
    const endCursor =
      Array.isArray(cursorInfo && cursorInfo.endCursor) && cursorInfo.endCursor.length >= 2
        ? [Number(cursorInfo.endCursor[0]), String(cursorInfo.endCursor[1])]
        : null;

    return { ids, endCursor, hasNext: !!(cursorInfo && cursorInfo.hasNext) };
  }

  // --------------------------------------------------------------- capabilities

  let capabilitiesCache = null;

  async function getCapabilities({ force = false } = {}) {
    if (capabilitiesCache && !force) return capabilitiesCache;

    const caps = {
      loader: !!pageRequire(),
      identity: readIdentity(),
      runtime: false,
      database: false,
      tables: [],
      plainUnsend: false,
      e2eeUnsend: false,
      e2eeHistory: false,
      loadOlderMessages: false,
      loadMoreThreads: typeof requireModule(MODULES.loadMoreThreads) === "function",
      reason: null,
    };

    try {
      const runtime = await getRuntime();
      caps.database = true;
      caps.tables = Object.keys(runtime.store.tables || {});
      caps.runtime = true;
    } catch (error) {
      caps.reason = String((error && error.message) || error);
    }

    // The plain-unsend procedure is registered only after the client loads the
    // "remove message" dialog, so trigger that before reporting it missing.
    try {
      if (NS.unsend) await NS.unsend.preloadPlainUnsend();
    } catch {
      /* reported below */
    }
    caps.plainUnsend = typeof requireModule(MODULES.plainUnsend) === "function";

    const bridge = requireModule(MODULES.e2eeBridge);
    const qpl = requireModule(MODULES.qpl);
    caps.e2eeUnsend =
      !!bridge && typeof bridge.sendAndReceive === "function" && !!qpl && typeof qpl._ === "function";
    caps.e2eeHistory = e2eeLoadingAvailable();
    caps.loadOlderMessages =
      typeof requireModule(MODULES.rangeQuery) === "function" &&
      typeof requireModule(MODULES.factory) === "function";

    capabilitiesCache = caps;
    return caps;
  }

  // --------------------------------------------------------------- diagnostics

  function flatten(value) {
    if (value == null) return value;
    if (typeof value !== "object") return value;
    try {
      const text = JSON.stringify(value);
      return text.length > 140 ? `${text.slice(0, 140)}…` : text;
    } catch {
      return "[object]";
    }
  }

  async function getDiagnostics() {
    const caps = await getCapabilities({ force: true });
    const out = { caps, probeErrors: { ...probeErrors }, threads: [], sample: null };

    if (!caps.database) return out;

    try {
      const threads = await readThreads();
      out.threadCount = threads.length;
      out.threads = threads.slice(0, 5);

      const interesting = threads.find((thread) => !thread.cannotUnsend) || threads[0];
      if (interesting) {
        const rows = await readThreadMessages(interesting.threadKey, { limit: 5 });
        out.sample = {
          thread: interesting,
          rows: rows.slice(0, 3).map((row) => {
            const flat = {};
            for (const [key, value] of Object.entries(row)) flat[key] = flatten(value);
            return flat;
          }),
          parsed: rows
            .slice(0, 3)
            .map((row) => CORE.parseMessageRow(row, { fallbackThreadKey: interesting.threadKey })),
        };
        const attachments = await readAttachments(interesting.threadKey);
        out.attachmentMessageCount = Object.keys(attachments).length;
      }
    } catch (error) {
      out.error = String((error && error.message) || error);
    }

    out.modules = {};
    for (const name of Object.values(MODULES)) out.modules[name] = !!requireModule(name);
    return out;
  }

  NS.api = {
    core: CORE,
    MODULES,
    requireModule,
    readIdentity,
    getRuntime,
    getStore: async () => (await getRuntime()).store,
    toI64,
    i64ToString,
    i64ToNumber,
    i64IsZero,
    normalizeRow,
    readThreads,
    loadMoreThreads,
    readThreadMessages,
    readMessagesByIds,
    readParticipants,
    resolveChatJid,
    readAttachments,
    requestOlderMessages,
    loadEncryptedPage,
    e2eeLoadingAvailable,
    getCapabilities,
    getDiagnostics,
  };
})();
