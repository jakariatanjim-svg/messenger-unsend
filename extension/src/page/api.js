/*
 * Runtime access layer (MAIN world).
 *
 * Messenger's web client keeps its own local database and message-removal
 * procedures inside the page. This file locates them, reports what is
 * available, and exposes small helpers the scanner and the unsend engine use.
 *
 * Everything here is read-only. Nothing leaves the browser.
 */

(function () {
  "use strict";

  const CORE = globalThis.MBU_CORE;
  const NS = (globalThis.__MBU__ = globalThis.__MBU__ || {});
  if (NS.api) return;

  const MODULES = {
    reql: "ReQL",
    i64: "I64",
    intEnum: "LSIntEnum",
    store: "LSDatabaseSingleton",
    factory: "LSFactory",
    plainUnsend: "LSOptimisticUnsendMessageStoredProcedure",
    plainUnsendPreload: "MWV2OnlyGlobalRemoveMessageDialog.entrypoint",
    e2eeBridge: "MAWBridgeSendAndReceive",
    qpl: "qpl",
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

  // --------------------------------------------------------------- store access

  let storePromise = null;

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

  /** Resolve the page's local database singleton, once. */
  function getStore() {
    if (storePromise) return storePromise;
    storePromise = (async () => {
      if (!pageRequire()) throw new Error("page module loader (window.require) is not available yet");
      const singleton = requireModule(MODULES.store);
      if (!singleton || !singleton.LSDatabaseSingleton) {
        throw new Error("LSDatabaseSingleton module not found");
      }
      const store = await withTimeout(
        Promise.resolve(singleton.LSDatabaseSingleton),
        10000,
        "database"
      );
      if (!store || !store.tables) throw new Error("database opened but exposes no tables");
      return store;
    })().catch((error) => {
      storePromise = null; // allow a retry after navigation
      throw error;
    });
    return storePromise;
  }

  /**
   * Materialise a table into an array. Meta's table objects have changed shape
   * between builds, so several read strategies are attempted in order and the
   * failures are kept for the diagnostics panel.
   */
  async function readTable(tableName, { limit = 5000 } = {}) {
    const store = await getStore();
    const table = store.tables[tableName];
    if (!table) {
      probeErrors[`table:${tableName}`] = "table missing";
      return [];
    }

    const attempts = [
      ["toArray", () => table.toArray && table.toArray()],
      ["toArray+opts", () => table.toArray && table.toArray({ limit })],
      ["all", () => table.all && table.all()],
      ["getAll", () => table.getAll && table.getAll()],
      ["values", () => table.values && table.values()],
    ];

    for (const [label, run] of attempts) {
      try {
        const value = await withTimeout(Promise.resolve(run()), 8000, `read ${tableName} via ${label}`);
        const rows = CORE.toArray(value);
        if (rows.length) {
          delete probeErrors[`table:${tableName}`];
          return rows.slice(0, limit);
        }
      } catch (error) {
        probeErrors[`table:${tableName}:${label}`] = String((error && error.message) || error);
      }
    }

    // Last resort: plain object/Map storage.
    try {
      if (table instanceof Map) return Array.from(table.values()).slice(0, limit);
      if (typeof table === "object") {
        const rows = Object.values(table).filter((row) => row && typeof row === "object");
        if (rows.length) return rows.slice(0, limit);
      }
    } catch (error) {
      probeErrors[`table:${tableName}:enumerate`] = String((error && error.message) || error);
    }

    return [];
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
      reason: null,
    };

    try {
      const store = await getStore();
      caps.database = true;
      caps.tables = Object.keys(store.tables || {});
      caps.runtime = true;
    } catch (error) {
      caps.reason = String((error && error.message) || error);
    }

    caps.plainUnsend = typeof requireModule(MODULES.plainUnsend) === "function";
    const bridge = requireModule(MODULES.e2eeBridge);
    const qpl = requireModule(MODULES.qpl);
    caps.e2eeUnsend =
      !!bridge && typeof bridge.sendAndReceive === "function" && !!qpl && typeof qpl._ === "function";

    capabilitiesCache = caps;
    return caps;
  }

  // --------------------------------------------------------------- diagnostics

  function tableSample(rows, count = 3) {
    return rows.slice(0, count).map((row) => {
      const flat = {};
      for (const [key, value] of Object.entries(row || {})) {
        if (value == null) continue;
        if (typeof value === "function") continue;
        if (typeof value === "object") {
          const text = (() => {
            try {
              return JSON.stringify(value);
            } catch {
              return "[object]";
            }
          })();
          flat[key] = text.length > 120 ? `${text.slice(0, 120)}…` : text;
        } else {
          flat[key] = value;
        }
      }
      return flat;
    });
  }

  async function getDiagnostics() {
    const caps = await getCapabilities({ force: true });
    const out = { caps, probeErrors: { ...probeErrors }, samples: {}, counts: {} };

    if (caps.database) {
      for (const tableName of ["messages", "threads", "participants"]) {
        const rows = await readTable(tableName, { limit: 200 });
        out.counts[tableName] = rows.length;
        out.samples[tableName] = tableSample(rows);
        out.parsed = out.parsed || {};
        if (tableName === "messages" && rows.length) {
          out.parsed.messages = rows
            .slice(0, 5)
            .map((row) => CORE.parseMessageRow(row))
            .filter(Boolean);
        }
        if (tableName === "threads" && rows.length) {
          out.parsed.threads = rows
            .slice(0, 5)
            .map((row) => CORE.parseThreadRow(row))
            .filter(Boolean);
        }
      }
    }

    out.modules = {};
    for (const name of Object.values(MODULES)) {
      out.modules[name] = !!requireModule(name);
    }
    return out;
  }

  NS.api = {
    core: CORE,
    MODULES,
    requireModule,
    readIdentity,
    getStore,
    readTable,
    getCapabilities,
    getDiagnostics,
  };
})();
