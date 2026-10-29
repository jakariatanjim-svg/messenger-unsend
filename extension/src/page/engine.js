/*
 * Job engine (MAIN world).
 *
 * Owns the scan/un-send job, the worker pool and the adaptive throttle, and
 * answers commands coming from the side panel through the bridge.
 *
 * Speed model: no fixed sleep between messages. Work is pipelined through a
 * bounded pool; the pool only slows down when the server says so.
 */

(function () {
  "use strict";

  const NS = (globalThis.__MBU__ = globalThis.__MBU__ || {});
  if (NS.engine) return;

  const CORE = globalThis.MBU_CORE;

  const DEFAULT_CONCURRENCY = 6;
  const MAX_CONCURRENCY = 20;
  const AUTO_PAUSE_AFTER_FAILURES = 5;
  const RATE_LIMIT_COOLDOWN_MS = 30000;
  const MAX_COOLDOWNS = 6;
  const PROGRESS_INTERVAL_MS = 400;

  const state = {
    status: "idle",
    job: null,
    lastResult: null,
    stopRequested: false,
    pauseRequested: false,
  };

  let lastProgressAt = 0;

  function emit(payload) {
    try {
      window.postMessage(
        Object.assign({ channel: "__mbu_channel__", dir: "from-page", kind: "event" }, payload),
        window.location.origin
      );
    } catch {
      /* page is tearing down */
    }
  }

  function progress(force = false) {
    const job = state.job;
    if (!job) return;
    const now = Date.now();
    if (!force && now - lastProgressAt < PROGRESS_INTERVAL_MS) return;
    lastProgressAt = now;

    const elapsed = Math.max(1, now - job.startedAt);
    const total = job.runTotal || job.messages.length;
    const done = job.stats.sent + job.stats.failed + job.stats.skipped;
    emit({
      event: "progress",
      status: state.status,
      stats: { ...job.stats },
      total,
      done,
      perMinute: Math.round((done / elapsed) * 60000),
      concurrency: job.concurrency,
      cooldownUntil: job.cooldownUntil,
      pauseReason: job.pauseReason,
    });
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ------------------------------------------------------------------- scanning

  async function runScan(payload) {
    state.status = "scanning";
    emit({ event: "status", status: state.status });

    const scan = await NS.scan.scan({
      filters: payload.filters || {},
      scope: payload.scope || "inbox",
      deep: !!payload.deep,
      onProgress: (detail) => emit({ event: "scan-progress", detail }),
    });

    state.job = {
      id: `job-${Date.now().toString(36)}`,
      messages: scan.messages.map((message) => ({ ...message, status: "pending" })),
      results: {},
      stats: { sent: 0, failed: 0, skipped: 0, rateLimited: 0 },
      concurrency: clampConcurrency(payload.concurrency || DEFAULT_CONCURRENCY),
      startedAt: Date.now(),
      cooldownUntil: 0,
      pauseReason: null,
      scope: payload.scope || "inbox",
      filters: payload.filters || {},
      runTotal: 0,
    };
    state.status = "ready";

    emit({
      event: "scan-complete",
      status: state.status,
      source: scan.source,
      scannedThreads: scan.scannedThreads,
      myUserId: scan.myUserId,
      capabilities: scan.capabilities,
      messages: state.job.messages,
      total: state.job.messages.length,
    });

    return {
      source: scan.source,
      total: state.job.messages.length,
      scannedThreads: scan.scannedThreads,
      myUserId: scan.myUserId,
      capabilities: scan.capabilities,
      messages: state.job.messages,
    };
  }

  function clampConcurrency(value) {
    const n = Number(value) || DEFAULT_CONCURRENCY;
    return Math.max(1, Math.min(MAX_CONCURRENCY, Math.round(n)));
  }

  // -------------------------------------------------------------------- running

  async function runUnsend(payload = {}) {
    const job = state.job;
    if (!job) throw new Error("scan first: there is no message list to work through");
    if (state.status === "running") throw new Error("a job is already running");

    const ids = Array.isArray(payload.ids) && payload.ids.length
      ? new Set(payload.ids)
      : new Set(job.messages.filter((m) => m.status === "pending").map((m) => m.id));

    const cap = Number(payload.cap) > 0 ? Number(payload.cap) : Infinity;
    const queue = job.messages
      .filter((message) => ids.has(message.id) && message.status === "pending")
      .slice(0, cap);

    if (!queue.length) throw new Error("nothing selected to unsend");

    job.runTotal = queue.length;
    job.concurrency = clampConcurrency(payload.concurrency || job.concurrency);
    job.startedAt = Date.now();
    job.cooldownUntil = 0;
    job.pauseReason = null;
    state.stopRequested = false;
    state.pauseRequested = false;
    state.status = "running";
    emit({ event: "status", status: state.status });

    const pending = queue.slice();
    let inFlight = 0;
    let consecutiveFailures = 0;
    let cooldowns = 0;
    let activeConcurrency = job.concurrency;
    const ceiling = job.concurrency;

    function handleResult(message, result) {
      if (result.outcome === "sent") {
        job.stats.sent += 1;
        message.status = "sent";
        consecutiveFailures = 0;
        // Recover one slot at a time after a throttle episode.
        if (activeConcurrency < ceiling) activeConcurrency += 1;
        return;
      }

      if (result.outcome === "rate_limited") {
        job.stats.rateLimited += 1;
        message.status = "pending";
        pending.unshift(message); // retry it after the cooldown
        consecutiveFailures += 1;
        activeConcurrency = 1;
        cooldowns += 1;
        job.cooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
        if (cooldowns >= MAX_COOLDOWNS) {
          state.pauseRequested = true;
          state.status = "paused";
          job.pauseReason = `throttled ${cooldowns} times — paused to protect the account`;
          emit({ event: "auto-paused", reason: job.pauseReason, lastError: result.reason });
        }
        emit({
          event: "rate-limited",
          messageId: message.id,
          cooldownMs: RATE_LIMIT_COOLDOWN_MS,
          concurrency: activeConcurrency,
        });
        return;
      }

      if (result.outcome === "skipped") {
        job.stats.skipped += 1;
        message.status = "skipped";
        message.skipReason = result.reason;
        return;
      }

      job.stats.failed += 1;
      message.status = "failed";
      message.failReason = result.reason;
      consecutiveFailures += 1;
      if (consecutiveFailures >= AUTO_PAUSE_AFTER_FAILURES) {
        state.pauseRequested = true;
        state.status = "paused";
        job.pauseReason = `${consecutiveFailures} failures in a row — paused`;
        emit({ event: "auto-paused", reason: job.pauseReason, lastError: result.reason });
      }
    }

    // Bounded scheduler: keeps `activeConcurrency` requests in flight, so the
    // pool can grow or shrink at any moment without killing live requests.
    const running = new Set();

    for (;;) {
      if (state.stopRequested) break;

      while (state.pauseRequested && !state.stopRequested) {
        await sleep(300);
      }
      if (state.stopRequested) break;

      if (job.cooldownUntil > Date.now()) {
        const wait = job.cooldownUntil - Date.now();
        emit({ event: "cooldown", ms: wait, concurrency: activeConcurrency });
        await sleep(Math.min(wait, RATE_LIMIT_COOLDOWN_MS));
        continue;
      }

      while (inFlight < activeConcurrency && pending.length && !state.stopRequested) {
        const message = pending.shift();
        message.status = "sending";
        inFlight += 1;

        const task = NS.unsend
          .unsendOne(message)
          .then((result) => {
            job.results[message.id] = result;
            handleResult(message, result);
          })
          .catch((error) => {
            job.stats.failed += 1;
            message.status = "failed";
            message.failReason = String((error && error.message) || error);
          })
          .finally(() => {
            inFlight -= 1;
            running.delete(task);
            progress();
          });

        running.add(task);
      }

      if (!running.size) {
        if (!pending.length) break;
        await sleep(120);
        continue;
      }

      await Promise.race(running);
    }

    await Promise.allSettled(running);

    const finished = state.stopRequested
      ? "stopped"
      : queue.every((message) => message.status !== "pending")
        ? "done"
        : "paused";

    state.status = finished;
    if (finished === "done") state.pauseRequested = false;
    progress(true);
    emit({
      event: "job-finished",
      status: state.status,
      stats: { ...job.stats },
      pauseReason: job.pauseReason,
      durationMs: Date.now() - job.startedAt,
    });

    return { status: state.status, stats: job.stats, total: queue.length };
  }

  // ------------------------------------------------------------- verification

  /**
   * Re-read the local rows and report which messages no longer show as sent.
   * Runs once at the end instead of after every single message.
   */
  async function verify(payload = {}) {
    const ids = new Set(payload.ids || []);
    if (!ids.size) return { checked: 0 };
    NS.scan.invalidateMessages();
    const rows = await NS.api.readTable("messages", { limit: 40000 });
    const byId = new Map();
    for (const row of rows) {
      const message = CORE.parseMessageRow(row);
      if (message) byId.set(message.id, message);
    }

    const report = { checked: 0, gone: 0, stillThere: [], alreadyUnsent: 0 };
    for (const id of ids) {
      report.checked += 1;
      const row = byId.get(id);
      if (!row) {
        report.gone += 1;
      } else if (row.isUnsent) {
        report.alreadyUnsent += 1;
      } else {
        report.stillThere.push(id);
      }
    }
    return report;
  }

  // -------------------------------------------------------------------- router

  const handlers = {
    PING: async () => ({
      alive: true,
      href: location.href,
      status: state.status,
      hasLoader: typeof globalThis.require === "function",
    }),
    CAPS: () => NS.api.getCapabilities({ force: true }),
    DIAG: () => NS.api.getDiagnostics(),
    SCAN: (payload) => runScan(payload || {}),
    UNSEND: (payload) => runUnsend(payload || {}),
    VERIFY: (payload) => verify(payload || {}),
    PAUSE: async () => {
      state.pauseRequested = true;
      state.status = "paused";
      emit({ event: "status", status: state.status });
      return { status: state.status };
    },
    RESUME: async () => {
      state.pauseRequested = false;
      state.status = "running";
      emit({ event: "status", status: state.status });
      return { status: state.status };
    },
    STOP: async () => {
      state.stopRequested = true;
      state.pauseRequested = false;
      return { status: "stopping" };
    },
    STATE: async () => ({
      status: state.status,
      total: state.job ? state.job.messages.length : 0,
      stats: state.job ? state.job.stats : null,
    }),
  };

  NS.engine = {
    handle: handlers,
    state,
    runScan,
    runUnsend,
    verify,
  };

  // Command channel from the bridge (ISOLATED world).
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.channel !== "__mbu_channel__" || data.dir !== "to-page") return;

    const reply = (payload) =>
      window.postMessage(
        Object.assign(
          { channel: "__mbu_channel__", dir: "from-page", id: data.id, kind: "reply" },
          payload
        ),
        window.location.origin
      );

    const handler = handlers[data.kind];
    if (!handler) {
      reply({ error: `unknown command: ${data.kind}` });
      return;
    }

    Promise.resolve()
      .then(() => handler(data.payload))
      .then((result) => reply({ result }))
      .catch((error) => reply({ error: String((error && error.message) || error) }));
  });
})();
