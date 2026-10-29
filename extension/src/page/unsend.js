/*
 * Remove-for-everyone engine (MAIN world).
 *
 * Two paths, because Messenger keeps encrypted and legacy conversations in
 * different places:
 *   plain  -> the page's own optimistic unsend stored procedure
 *   e2ee   -> the page's encrypted-messaging bridge ("sendRevokeMsg")
 *
 * Both use procedures the client already ships with; nothing is invented and no
 * private endpoint is hardcoded.
 */

(function () {
  "use strict";

  const NS = (globalThis.__MBU__ = globalThis.__MBU__ || {});
  if (NS.unsend) return;

  const CORE = globalThis.MBU_CORE;
  const api = NS.api;

  // ------------------------------------------------------------- availability

  let preloadPromise = null;

  /**
   * The plain-unsend procedure is only registered after the client loads the
   * "remove message" dialog entrypoint. Loading it once is enough.
   */
  function preloadPlainUnsend() {
    if (typeof api.requireModule(api.MODULES.plainUnsend) === "function") {
      return Promise.resolve(true);
    }
    if (preloadPromise) return preloadPromise;

    preloadPromise = (async () => {
      const entrypoint = api.requireModule(api.MODULES.plainUnsendPreload);
      const root = entrypoint && entrypoint.root;
      if (root && typeof root.load === "function") {
        await Promise.race([
          Promise.resolve(root.load()).catch(() => undefined),
          new Promise((resolve) => setTimeout(resolve, 8000)),
        ]);
      }
      return typeof api.requireModule(api.MODULES.plainUnsend) === "function";
    })().then((ok) => {
      if (!ok) preloadPromise = null;
      return ok;
    });

    return preloadPromise;
  }

  function e2eeAvailable() {
    const bridge = api.requireModule(api.MODULES.e2eeBridge);
    const qpl = api.requireModule(api.MODULES.qpl);
    return (
      !!bridge &&
      typeof bridge.sendAndReceive === "function" &&
      !!qpl &&
      typeof qpl._ === "function"
    );
  }

  // ---------------------------------------------------------------- plain path

  async function unsendPlain({ messageId, threadKey }) {
    if (!threadKey) throw new Error("MISSING_THREAD_KEY");
    const store = await api.getStore();
    const I64 = api.requireModule(api.MODULES.i64);
    const factory = api.requireModule(api.MODULES.factory);
    const procedure = api.requireModule(api.MODULES.plainUnsend);

    if (!procedure) throw new Error("plain unsend procedure unavailable");
    if (!factory) throw new Error("LSFactory module unavailable");
    if (!I64 || typeof I64.of_string !== "function") {
      throw new Error("I64 module unavailable (cannot convert thread key)");
    }

    if (typeof store.runInTransaction !== "function") {
      throw new Error("database has no runInTransaction()");
    }

    await store.runInTransaction(
      (transaction) =>
        procedure(factory(transaction), {
          messageId,
          pluginType: undefined,
          threadKey: I64.of_string(String(threadKey)),
        }),
      "readwrite",
      undefined,
      undefined,
      "BulkUnsend"
    );

    return { outcome: "sent" };
  }

  // ----------------------------------------------------------------- e2ee path

  async function unsendE2ee({ messageId }) {
    const bridge = api.requireModule(api.MODULES.e2eeBridge);
    const qpl = api.requireModule(api.MODULES.qpl);
    if (!bridge || typeof bridge.sendAndReceive !== "function") {
      throw new Error("encrypted messaging bridge unavailable");
    }
    if (!qpl || typeof qpl._ !== "function") throw new Error("qpl module unavailable");

    const parsed = CORE.parseE2eeMessageId(messageId);
    if (!parsed) return { outcome: "skipped", reason: "INVALID_E2EE_ID" };

    const response = await bridge.sendAndReceive("backend", "sendRevokeMsg", {
      msgId: {
        author: "@me",
        chat: parsed.chatJid,
        externalId: parsed.externalId,
      },
      messageExpiryTimestampMs: undefined,
      qplEventType: qpl._(25313175, "1551"),
      qplInstanceKey: Math.floor(Date.now() % 1e9),
    });

    if (response && response.success === false) {
      const text = String((response.error && (response.error.message || response.error)) || "");
      return { outcome: "failed", reason: text || "UNSEND_REJECTED" };
    }
    return { outcome: "sent" };
  }

  // ------------------------------------------------------------------ dispatch

  const rateLimitPattern = /rate limit|ratelimit|too many|checkpoint|try again later|429|throttl/i;

  function looksRateLimited(text) {
    return rateLimitPattern.test(String(text || ""));
  }

  async function unsendOne(message) {
    const started = Date.now();
    const protocol = message.protocol === "e2ee" ? "e2ee" : "plain";

    try {
      let result;
      if (protocol === "e2ee") {
        if (!e2eeAvailable()) throw new Error("encrypted unsend not available in this build");
        result = await unsendE2ee(message);
      } else {
        const ready = await preloadPlainUnsend();
        if (!ready) throw new Error("plain unsend not available in this build");
        result = await unsendPlain({ messageId: message.id, threadKey: message.threadKey });
      }

      return {
        id: message.id,
        protocol,
        ms: Date.now() - started,
        ...result,
      };
    } catch (error) {
      const text = String((error && error.message) || error);
      return {
        id: message.id,
        protocol,
        ms: Date.now() - started,
        outcome: looksRateLimited(text) ? "rate_limited" : "failed",
        reason: text,
      };
    }
  }

  NS.unsend = {
    preloadPlainUnsend,
    e2eeAvailable,
    unsendOne,
    looksRateLimited,
  };
})();
