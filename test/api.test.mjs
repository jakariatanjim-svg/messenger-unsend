/*
 * Tests for the runtime access layer. The page's ReQL builder is replaced with a
 * small fake that behaves like the real one for our query shapes, so the test
 * pins down what the extension asks the client for.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const EXT = path.join(import.meta.dirname, "..", "extension");
const coreSource = fs.readFileSync(path.join(EXT, "src/page/core.js"), "utf8");
const apiSource = fs.readFileSync(path.join(EXT, "src/page/api.js"), "utf8");

const ms = (iso) => new Date(iso).getTime();

/** Minimal stand-in for a 64-bit value. */
const i64 = (text) => ({ __i64: String(text), toString: () => String(text) });

const I64 = {
  of_string: (value) => i64(value),
  to_string: (value) => {
    if (value && value.__i64 != null) return value.__i64;
    if (typeof value === "string" || typeof value === "number") return String(value);
    throw new Error("not an i64");
  },
  zero: i64("0"),
};

const THREADS = [
  { threadKey: i64("101"), threadType: i64("1"), threadName: "Sister", lastActivityTimestampMs: i64(String(ms("2026-10-29T09:00:00Z"))) },
  { threadKey: i64("102"), threadType: i64("2"), threadName: "Family group", lastActivityTimestampMs: i64(String(ms("2026-10-29T08:00:00Z"))) },
  { threadKey: i64("103"), threadType: i64("15"), threadName: "Encrypted friend", lastActivityTimestampMs: i64(String(ms("2026-10-29T07:00:00Z"))) },
  { threadKey: i64("104"), threadType: i64("1"), threadName: "Sub folder", parentThreadKey: i64("1"), lastActivityTimestampMs: i64("0") },
];

const MESSAGES = [
  {
    threadKey: i64("101"),
    messageId: "mid.$mine-recent",
    timestampMs: i64(String(ms("2026-10-29T08:58:00Z"))),
    senderId: i64("61567807754817"),
    text: "hello",
  },
  {
    threadKey: i64("101"),
    messageId: "mid.$mine-old",
    timestampMs: i64(String(ms("2026-10-26T08:58:00Z"))),
    senderId: i64("61567807754817"),
    text: "old",
  },
  {
    threadKey: i64("101"),
    messageId: "mid.$theirs",
    timestampMs: i64(String(ms("2026-10-29T08:59:00Z"))),
    senderId: i64("999"),
    text: "theirs",
  },
  {
    threadKey: i64("102"),
    messageId: "mid.$group-photo",
    timestampMs: i64(String(ms("2026-10-29T08:30:00Z"))),
    senderId: i64("61567807754817"),
    text: "",
  },
];

/** Query builder that mirrors the shapes the extension actually calls. */
function makeReql(tables) {
  function build(rows, order) {
    const query = {
      rows: [...rows],
      filter(fn) {
        return build(this.rows.filter((row) => fn(row)), this.order);
      },
      take(count) {
        const sorted = [...this.rows].sort((a, b) =>
          this.order === "desc"
            ? Number(String(b.timestampMs)) - Number(String(a.timestampMs))
            : Number(String(a.timestampMs)) - Number(String(b.timestampMs))
        );
        return build(sorted.slice(0, count), this.order);
      },
      order,
    };
    return query;
  }

  const from = (table, order) => ({
    getKeyRange: (key) =>
      build(
        (table.rows || []).filter((row) => String(row.threadKey) === String(key)),
        order
      ),
    __all: () => build(table.rows || [], order),
  });

  return {
    fromTableDescending: (table) => from(table, "desc"),
    fromTableAscending: (table) => {
      const base = from(table, "asc");
      // The real builder supports a bare table read for the thread list.
      base.then = undefined;
      return new Proxy(base, {
        get(target, prop) {
          if (prop === "getKeyRange") return target.getKeyRange;
          return target[prop];
        },
      });
    },
    toArrayAsync: async (query) => {
      if (query && query.rows) return query.rows;
      if (query && typeof query.__all === "function") return query.__all().rows;
      return [];
    },
  };
}

function loadApi({ threads = THREADS, messages = MESSAGES } = {}) {
  const tables = {
    threads: { name: "threads", rows: threads },
    messages: { name: "messages", rows: messages },
    attachments: { name: "attachments", rows: [] },
  };

  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    JSON,
    Math,
    Number,
    String,
    Object,
    Array,
    Set,
    Map,
    Date,
    Promise,
    Error,
    RegExp,
    document: { cookie: "c_user=61567807754817" },
    location: { href: "https://www.messenger.com/t/101", origin: "https://www.messenger.com" },
  });
  context.window = context;
  context.globalThis = context;

  vm.runInContext(coreSource, context, { filename: "core.js" });
  context.MBU_CORE = context.MBU_CORE;

  context.require = (name) => {
    if (name === "ReQL") return makeReql(tables);
    if (name === "I64") return I64;
    if (name === "LSDatabaseSingleton") return { LSDatabaseSingleton: Promise.resolve({ tables }) };
    if (name === "LSIntEnum") return { ofNumber: (n) => i64(n) };
    if (name === "CurrentUserInitialData") return { USER_ID: "61567807754817" };
    throw new Error(`missing module ${name}`);
  };

  vm.runInContext(apiSource, context, { filename: "api.js" });
  return context.__MBU__.api;
}

// ---------------------------------------------------------------------- tests

test("i64 helpers convert the client's 64-bit wrappers", () => {
  const api = loadApi();
  assert.equal(api.i64ToString({ I64 }, i64("61567807754817")), "61567807754817");
  assert.equal(api.i64ToString({}, "plain"), "plain", "falls back when the helper is missing");
  assert.equal(api.i64ToNumber({ I64 }, i64("1700000000000")), 1700000000000);
  assert.equal(api.i64IsZero({ I64 }, i64("0")), true);
  assert.equal(api.i64IsZero({ I64 }, i64("5")), false);
});

test("normalizeRow flattens 64-bit fields and leaves other data alone", () => {
  const api = loadApi();
  const row = api.normalizeRow(
    { I64 },
    { threadKey: i64("101"), messageId: "mid.$a", attachments: [{ type: "image/png" }] }
  );
  assert.equal(row.threadKey, "101");
  assert.equal(row.messageId, "mid.$a");
  assert.deepEqual(row.attachments, [{ type: "image/png" }]);
});

test("readThreads keeps real conversations and detects encrypted ones", async () => {
  const api = loadApi();
  const threads = await api.readThreads();
  const keys = Array.from(threads, (thread) => String(thread.threadKey));

  assert.deepEqual(keys, ["101", "102", "103"], "sub-folders must be skipped");
  const [first, second, third] = threads;
  assert.equal(first.isOneToOne, true);
  assert.equal(second.isGroup, true);
  assert.equal(third.isE2ee, true, "threadType 15 is an encrypted thread");
  assert.equal(first.name, "Sister");
  assert.equal(Number(first.lastActivityMs), ms("2026-10-29T09:00:00Z"));
});

test("readThreadMessages reads through the key range and filters by time", async () => {
  const api = loadApi();
  const rows = await api.readThreadMessages("101", {
    descending: true,
    fromTs: ms("2026-10-29T00:00:00Z"),
    toTs: ms("2026-10-30T00:00:00Z"),
    limit: 100,
  });

  assert.deepEqual(
    Array.from(rows, (row) => String(row.messageId)),
    ["mid.$theirs", "mid.$mine-recent"],
    "newest first, older message excluded, other thread excluded"
  );
  const [newest] = rows;
  assert.equal(typeof newest.timestampMs, "string", "row values arrive normalised");
  assert.equal(String(newest.threadKey), "101");
});

test("readMessagesByIds only returns the requested rows", async () => {
  const api = loadApi();
  const found = await api.readMessagesByIds("101", new Set(["mid.$mine-recent", "nope"]));
  assert.deepEqual(Array.from(found.keys(), String), ["mid.$mine-recent"]);
});

test("getCapabilities reports the unsend paths the page actually offers", async () => {
  const api = loadApi();
  const caps = await api.getCapabilities({ force: true });
  assert.equal(caps.database, true);
  assert.equal(caps.identity.userId, "61567807754817");
  assert.ok(Array.isArray(caps.tables));
  assert.equal(caps.plainUnsend, false, "not registered until the client loads its dialog");
  assert.equal(caps.e2eeUnsend, false);
});
