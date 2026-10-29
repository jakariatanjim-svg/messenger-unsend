/*
 * Unit tests for the pure helpers and a static integrity check of the build.
 * Run: npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const core = require("../extension/src/page/core.js");
const ROOT = path.join(import.meta.dirname, "..");
const EXT = path.join(ROOT, "extension");

// ---------------------------------------------------------------- timestamps

test("normalizeTs understands seconds, milliseconds and microseconds", () => {
  const seconds = 1700000000;
  const millis = 1700000000000;
  const micros = 1700000000000000;

  assert.equal(core.normalizeTs(seconds), millis);
  assert.equal(core.normalizeTs(millis), millis);
  assert.equal(core.normalizeTs(micros), millis);
  assert.equal(core.normalizeTs("1700000000000"), millis);
  assert.equal(core.normalizeTs(0), 0);
  assert.equal(core.normalizeTs(null), 0);
});

// ----------------------------------------------------------------- row shapes

test("parseMessageRow accepts several field spellings", () => {
  const variants = [
    { messageId: "mid.$a", timestampMs: 1700000000000, senderId: "42", text: "hi" },
    { message_id: "mid.$a", timestamp_ms: 1700000000000, sender_fbid: 42, body: "hi" },
    { id: "mid.$a", timestamp: 1700000000, author: "42", message: "hi" },
  ];

  for (const row of variants) {
    const parsed = core.parseMessageRow(row);
    assert.ok(parsed, "row should parse");
    assert.equal(parsed.id, "mid.$a");
    assert.equal(parsed.ts, 1700000000000);
    assert.equal(parsed.senderId, "42");
  }
});

test("parseMessageRow rejects rows without an id", () => {
  assert.equal(core.parseMessageRow({ text: "no id" }), null);
  assert.equal(core.parseMessageRow(null), null);
});

test("parseMessageRow inherits a fallback thread and flags unsendable rows", () => {
  const parsed = core.parseMessageRow(
    { messageId: "mid.$b", timestampMs: 1700000000000, cannotUnsendReason: "5" },
    { fallbackThreadKey: "999" }
  );
  assert.equal(parsed.threadKey, "999");
  assert.equal(parsed.cannotUnsend, true);
});

// --------------------------------------------------------------------- types

test("classifyType detects media from attachments", () => {
  assert.equal(
    core.classifyType({ attachments: [{ type: "image/png" }], text: "" }),
    "photo"
  );
  assert.equal(core.classifyType({ attachments: [{ type: "video/mp4" }] }), "video");
  assert.equal(core.classifyType({ attachments: [{ type: "audio/mp4" }] }), "audio");
  assert.equal(core.classifyType({ attachments: [{ type: "application/pdf" }] }), "file");
  assert.equal(core.classifyType({ attachments: [{ type: "sticker" }] }), "sticker");
  assert.equal(core.classifyType({ stickerId: "123" }), "sticker");
  assert.equal(core.classifyType({ text: "just words" }), "text");
  assert.equal(core.classifyType({ text: "https://example.com/x" }), "link");
});

test("classifyType falls back to the attachment url extension", () => {
  assert.equal(core.classifyType({ attachments: [{ url: "https://cdn/x.JPG?x=1" }] }), "photo");
  assert.equal(core.classifyType({ attachments: [{ downloadUrl: "https://cdn/clip.webm" }] }), "video");
});

// ------------------------------------------------------------------ e2ee ids

test("parseE2eeMessageId splits jid and external id", () => {
  const parsed = core.parseE2eeMessageId("123456@msgr.ABCDEF");
  assert.deepEqual(parsed, { chatJid: "123456@msgr", externalId: "ABCDEF" });
  assert.equal(core.parseE2eeMessageId("mid.$plain"), null);
  assert.equal(core.parseE2eeMessageId("no-dot@jid"), null);
  assert.equal(core.isPlainMessageId("mid.$x"), true);
});

// -------------------------------------------------------------------- filters

const base = {
  id: "mid.$1",
  threadKey: "1",
  ts: 1700000000000,
  type: "photo",
  senderId: "me",
  preview: "crypto casino",
  cannotUnsend: false,
  expired: false,
};

test("matchesFilters enforces the time window", () => {
  assert.equal(core.matchesFilters(base, { from: 1699999999000, to: 1700000001000 }, "me"), true);
  assert.equal(core.matchesFilters(base, { from: 1700000000001 }, "me"), false);
  assert.equal(core.matchesFilters(base, { to: 1699999999999 }, "me"), false);
});

test("matchesFilters keeps only my messages and the chosen types", () => {
  assert.equal(core.matchesFilters(base, { types: ["photo"] }, "me"), true);
  assert.equal(core.matchesFilters(base, { types: ["text"] }, "me"), false);
  assert.equal(core.matchesFilters({ ...base, senderId: "someone" }, {}, "me"), false);
  assert.equal(core.matchesFilters(base, { keyword: "casino" }, "me"), true);
  assert.equal(core.matchesFilters(base, { keyword: "hello" }, "me"), false);
});

test("matchesFilters skips messages the server flags as unsendable", () => {
  assert.equal(core.matchesFilters({ ...base, cannotUnsend: true }, {}, "me"), false);
  assert.equal(core.matchesFilters({ ...base, cannotUnsend: true }, { skipUnsendable: false }, "me"), true);
});

// ----------------------------------------------------------------------- misc

test("formatCsv escapes quotes and commas", () => {
  const csv = core.formatCsv([{ threadKey: "1", type: "text", ts: 0, id: "mid.$a", preview: 'a,"b"' }]);
  const lines = csv.split("\n");
  assert.equal(lines[0], "thread,type,sent_at,status,message_id,preview");
  assert.match(lines[1], /"a,""b"""/);
});

// ------------------------------------------------------------- build integrity

test("manifest is valid and lists the page scripts in dependency order", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);

  const mainScript = manifest.content_scripts.find((entry) => entry.world === "MAIN");
  assert.ok(mainScript, "a MAIN world content script is required");
  assert.deepEqual(mainScript.js, [
    "src/page/core.js",
    "src/page/api.js",
    "src/page/scan.js",
    "src/page/unsend.js",
    "src/page/engine.js",
  ]);

  for (const script of mainScript.js) {
    assert.ok(fs.existsSync(path.join(EXT, script)), `missing ${script}`);
  }
  for (const icon of Object.values(manifest.icons)) {
    assert.ok(fs.existsSync(path.join(EXT, icon)), `missing ${icon}`);
  }
});

test("every script parses and every referenced asset exists", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
  const files = [
    ...manifest.content_scripts.flatMap((entry) => entry.js),
    manifest.background.service_worker,
    "src/panel.js",
    "src/panel.html",
    "src/panel.css",
  ];

  for (const file of files) {
    const full = path.join(EXT, file);
    assert.ok(fs.existsSync(full), `missing ${file}`);
  }

  for (const file of files.filter((name) => name.endsWith(".js"))) {
    const source = fs.readFileSync(path.join(EXT, file), "utf8");
    assert.doesNotThrow(() => new vm.Script(source, { filename: file }), `${file} has a syntax error`);
  }

  const html = fs.readFileSync(path.join(EXT, "src/panel.html"), "utf8");
  assert.ok(html.includes('src="panel.js"'));
  assert.ok(html.includes('href="panel.css"'));
});

test("the engine never merges on its own and keeps the guard rails", () => {
  const engine = fs.readFileSync(path.join(EXT, "src/page/engine.js"), "utf8");
  assert.ok(engine.includes("AUTO_PAUSE_AFTER_FAILURES"), "auto-pause must stay wired");
  assert.ok(engine.includes("RATE_LIMIT_COOLDOWN_MS"), "throttle handling must stay wired");

  const unsend = fs.readFileSync(path.join(EXT, "src/page/unsend.js"), "utf8");
  assert.ok(!/fetch\s*\(/.test(unsend), "the unsend path must not call the network directly");
  assert.ok(unsend.includes("parseE2eeMessageId"), "encrypted ids must be parsed, not guessed");
});
