# Messenger Bulk Unsend

A local-only Chrome extension (Manifest V3) that bulk-unsends **your own**
Facebook Messenger messages inside a chosen date/time range — "remove for
everyone", across one-to-one chats and groups, without clicking through the UI
message by message.

No server. No analytics. No account. Tokens never leave the page.

> **Status: stage 1 of 3.** The request-capture and replay engine works; the
> inbox scanner and the parallel bulk engine are next. See [Roadmap](#roadmap).

---

## Why this exists

The native Messenger UI only exposes "Remove for everyone" one message at a
time, and hosted "cleaner" services meter it (e.g. 30 actions/day on free tiers,
$12–$72/month above that) and push your session through their backend.

This extension does the same job locally: it observes the GraphQL call the web
client already makes when *you* unsend a message, learns that request shape, and
replays it in bulk — from your own logged-in tab, with your own cookies.

## How it works

```
page (MAIN world)                  extension
┌────────────────────┐   postMessage   ┌──────────────┐   chrome.*   ┌────────────┐
│ hook.js            │ ──────────────▶ │ bridge.js    │ ───────────▶ │ background │
│ • wraps fetch/XHR  │                 │ isolated     │              │ • op store │
│ • records doc_id,  │ ◀────────────── │ world relay  │ ◀─────────── │ • log      │
│   variables, tokens│   replay cmd    └──────────────┘              └────────────┘
│ • replays requests │                                                     ▲
└────────────────────┘                                                     │
                                                              side panel ───┘
```

1. **Capture.** You unsend one message by hand. `hook.js` records the GraphQL
   operation (`doc_id`, `variables` shape, `fb_dtsg` / `lsd` / `jazoest` /
   `av` / `__user`) and stores it locally.
2. **Replay.** The panel resends that operation with new variables
   (`message_id`, `thread_fbid`, …) from the page context, `credentials:
   "include"`. Same path Meta's own client uses.
3. **Bulk (next).** Enumerate threads with cursor pagination, page each thread's
   messages, keep only `sender = me` inside the date window, filter by type, then
   fan out unsend calls through a bounded parallel pool with adaptive backoff and
   a single reload at the end.

Nothing is hardcoded: `doc_id` values rotate, so they are learned from the live
page, never baked into the source.

## Install (unpacked)

1. Download or clone this repository.
2. Open `chrome://extensions`.
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select the `extension/` folder.
5. Pin the extension, open <https://www.messenger.com>, then click the icon to
   open the side panel.

Updates: press the reload (↻) button on the extension card, then reload the
Messenger tab.

## Usage (stage 1)

1. In Messenger, open any chat.
2. Hover one of **your own** messages → **⋯** → **Remove** → **Remove for
   everyone** → confirm. (Pick a throwaway message.)
3. In the side panel, **Capture** tab → **Refresh captures**. A blue-highlighted
   entry whose variables contain `message_id` / `mid.$` is the unsend mutation.
4. **Replay** tab → pick that operation → edit `variables` (put a real
   `message_id` and matching thread id) → **Send request**. The raw GraphQL
   response is shown.

This is the recon step: it verifies, on your own account, whether the server
accepts an unsend for an older message and how fast it responds. The bulk engine
reuses exactly this path.

## Safety model

- Only messages where `sender == me` are ever considered (hard guard).
- Dry run first: scan produces a table, nothing is deleted until you confirm.
- Stop / Pause / Resume at any point; `max per run` cap; auto-pause after
  repeated failures.
- Bounded concurrency (1–20) with explicit backoff on rate limiting — no fixed
  sleeps, but no hammering either.
- Requests are made from your own tab with your own cookies. Nothing is proxied.
- Tokens are kept in page memory; only the operation *recipe* (doc ids, variable
  names, an anonymised sample) is persisted locally via `chrome.storage.local`.
- Host permissions are limited to `www.messenger.com` and
  `www.facebook.com/messages`.

## Limitations

- Meta's internal API is undocumented and changes without notice. If a response
  shape changes, re-capture the recipe (step 2 above) and it usually recovers.
- End-to-end-encrypted threads may use a different unsend path than legacy
  threads. This is verified during recon, not assumed.
- Screenshots already taken by recipients cannot be recalled.
- Nothing here touches posts, stories, comments or Marketplace listings.
- Automating the internal API is against Meta's Terms of Service. Use it on your
  own account, at your own risk.

## Roadmap

| Stage | Contents | State |
| --- | --- | --- |
| 1 | Hook, recipe capture, replay console, panel shell | **done** |
| 2 | Thread enumeration, message pagination, date/time + type filters, preview table, sender guard | next |
| 3 | Parallel unsend engine, adaptive backoff, pause/resume, CSV export, single reload | planned |

## Development

```
node test/hook.smoke.mjs     # or: npm test
```

The smoke test runs `hook.js` inside a fake page (Node `vm`) and asserts that a
GraphQL request is captured as a replayable recipe and that replay rebuilds a
valid request.

```
extension/
  manifest.json
  src/hook.js        MAIN world: capture + replay
  src/bridge.js      ISOLATED world: message relay
  src/background.js  service worker: op store, log
  src/panel.html/.css/.js  side panel UI
test/hook.smoke.mjs
docs/ARCHITECTURE.md
```

## License

MIT. Provided as-is, for cleaning up your own account.
