/*
 * Smoke test for the MAIN-world hook.
 * Runs hook.js inside a fake page (no browser, no network) and checks that:
 *   1. a GraphQL request is captured as a replayable recipe;
 *   2. the replay engine rebuilds a valid request from that recipe.
 *
 * Run: node test/hook.smoke.mjs
 */

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";

const hookPath = path.join(import.meta.dirname, "..", "extension", "src", "hook.js");
const hookSource = fs.readFileSync(hookPath, "utf8");

const posted = [];
const fetched = [];

const listeners = [];
const token = '"DTSGInitialData",[],{"token":"AQHdtsg123"}"LSD",[],{"token":"LSD-abc"}';

const fakeResponse = (body) => ({
  ok: true,
  status: 200,
  clone() {
    return { text: async () => body };
  },
  text: async () => body,
});

const windowStub = {
  location: { origin: "https://www.messenger.com", href: "https://www.messenger.com/t/123" },
  addEventListener(type, fn) {
    if (type === "message") listeners.push(fn);
  },
  postMessage(msg) {
    posted.push(msg);
    // emulate a real browser: postMessage is dispatched asynchronously to listeners
    setTimeout(() => listeners.forEach((fn) => fn({ source: windowStub, data: msg })), 0);
  },
  fetch: async (url) => {
    fetched.push(url);
    return fakeResponse('{"data":{"message_unsend":true}}');
  },
  XMLHttpRequest: function XMLHttpRequest() {},
};

function XMLHttpRequest() {}
XMLHttpRequest.prototype.open = function () {};
XMLHttpRequest.prototype.send = function () {};
windowStub.XMLHttpRequest = XMLHttpRequest;

const documentStub = {
  documentElement: { innerHTML: token },
};

const context = vm.createContext({
  location: windowStub.location,
  window: windowStub,
  document: documentStub,
  console,
  setTimeout,
  clearTimeout,
  URLSearchParams,
  JSON,
  Date,
  Object,
  Array,
  String,
  Number,
  RegExp,
  Math,
  Promise,
  Error,
});

vm.runInContext(hookSource, context, { filename: "hook.js" });

// ---------------------------------------------------------------- 1. capture
const params = new URLSearchParams({
  av: "100000000000000",
  __user: "100000000000000",
  __a: "1",
  __ccg: "EXCELLENT",
  __rev: "1000000000",
  __req: "1a",
  lsd: "LSD-abc",
  fb_dtsg: "AQHdtsg123",
  jazoest: "2119",
  fb_api_caller_class: "RelayModern",
  fb_api_req_friendly_name: "useMessageUnsendMutation",
  variables: JSON.stringify({ message_id: "mid.$abc123", thread_fbid: "123" }),
  doc_id: "9876543210123456",
  server_timestamps: "true",
});

await windowStub.fetch("/api/graphql/", { method: "POST", body: params.toString() });

// let the cloned-response .text() promise settle
await new Promise((r) => setTimeout(r, 20));

const opMsg = posted.find((m) => m.kind === "op");
assert.ok(opMsg, "a GraphQL operation should be captured");
assert.equal(opMsg.recipe.docId, "9876543210123456");
assert.equal(opMsg.recipe.name, "useMessageUnsendMutation");
assert.ok(opMsg.recipe.variableKeys.includes("message_id"));
assert.equal(opMsg.recipe.tokens.fb_dtsg, "AQHdtsg123");
console.log("capture ............ ok");

// ----------------------------------------------------------------- 2. replay
const reply = new Promise((resolve) => {
  const hookListener = (event) => {
    if (event.data && event.data.kind === "reply" && event.data.id === "test-1") {
      listeners.splice(listeners.indexOf(hookListener), 1);
      resolve(event.data);
    }
  };
  windowStub.addEventListener("message", hookListener);
});

listeners.forEach((fn) =>
  fn({
    source: windowStub,
    data: {
      channel: "__mbu_channel__",
      dir: "to-hook",
      id: "test-1",
      kind: "replay",
      payload: {
        opName: "useMessageUnsendMutation",
        variables: { message_id: "mid.$old_message_11h" },
        keepTemplate: true,
      },
    },
  })
);

const result = await reply;
assert.ok(!result.error, `replay should not error: ${result.error}`);
assert.equal(result.result.status, 200);
assert.equal(result.result.ok, true);
assert.equal(result.result.sentVariables.message_id, "mid.$old_message_11h");
assert.equal(result.result.sentVariables.thread_fbid, "123", "template keys must be preserved");
assert.match(result.result.body, /message_unsend/, "response body is returned to the panel");
assert.equal(fetched.at(-1), "/api/graphql/", "replay reuses the captured endpoint");
console.log("replay ............ ok");

// ------------------------------------------------------------ 3. no doc_id
await windowStub.fetch("/api/graphql/", { method: "POST", body: "av=1&__a=1" });
assert.equal(posted.filter((m) => m.kind === "op").length, 1, "requests without doc_id are ignored");
console.log("filtering ......... ok");

console.log("\nAll hook smoke tests passed.");
