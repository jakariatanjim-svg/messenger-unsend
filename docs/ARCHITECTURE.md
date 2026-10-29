# Architecture

## Components

| File | World | Role |
| --- | --- | --- |
| `extension/src/hook.js` | `MAIN` (`document_start`) | Wraps `fetch` + `XMLHttpRequest`, records GraphQL operations, replays them |
| `extension/src/bridge.js` | `ISOLATED` | Relays `postMessage` ↔ `chrome.runtime` messages |
| `extension/src/background.js` | service worker | Persists captured operations and the log in `chrome.storage.local` |
| `extension/src/panel.*` | side panel | Capture browser, replay console, (future) job controls |

`MAIN` world is required because `fetch` must be wrapped before the page's own
scripts capture a reference to it. `ISOLATED` is required because only extension
scripts get `chrome.*` APIs.

## Message protocol

Page → hook (postMessage, `dir: "to-hook"`):

| `kind` | payload | reply |
| --- | --- | --- |
| `ping` | — | `{ alive, ops, href }` |
| `list-ops` | — | array of recipes |
| `replay` | `{ opName, variables, keepTemplate, url?, method? }` | `{ status, ok, ms, body, sentVariables }` |

Hook → page (`dir: "from-hook"`):

| `kind` | meaning |
| --- | --- |
| `ready` | hook installed |
| `op` | a new/updated operation recipe |
| `resp` | the response to an observed request, with a coarse ok/fail flag |
| `reply` | response to a panel command, keyed by request id |

The bridge adds a 15 s timeout to every command so a broken page never hangs the
UI. `chrome.tabs.sendMessage` requires the active tab to be on
`messenger.com` / `facebook.com/messages`; the panel checks this and reports it
instead of failing silently.

## Recipe shape

```jsonc
{
  "name": "useMessageUnsendMutation",
  "docId": "1234567890123456",
  "method": "POST",
  "url": "/api/graphql/",
  "variableKeys": ["message_id", "thread_fbid"],
  "variables": { "message_id": "mid.$…", "thread_fbid": "…" },  // replay template
  "tokens": { "fb_dtsg": "…", "lsd": "…", "jazoest": "…", "av": "…", "__user": "…" },
  "extras": { "__hs": "…", "__comet_req": "29" },
  "hits": 3,
  "lastResponse": "{\"data\":{\"message_unsend\":true}}"
}
```

`tokens` are refreshed from the live DOM at replay time
(`DTSGInitialData` / `LSD` / `USER_ID` patterns) because `fb_dtsg` rotates.
`jazoest` is derived: `"2" + sum of char codes of fb_dtsg`.

## Replay request

`POST {captured url}` with `application/x-www-form-urlencoded`, `credentials:
"include"`, headers `x-fb-friendly-name` and `x-fb-lsd`, body:

```
av, __user, __a, __ccg, __rev, __req, __hs, dpr, __comet_req,
fb_dtsg, jazoest, lsd, fb_api_caller_class=RelayModern,
fb_api_req_friendly_name, variables=<merged JSON>, doc_id, server_timestamps=true
```

Variables are merged with the template when `keepTemplate` is set, so a caller
only has to supply the identifiers that change per message.

## Stage 2 plan (scanner)

1. Enumerate threads. Prefer replaying the captured thread-list query with
   cursors; fall back to the DOM inbox list if no query was captured.
2. For each thread, paginate messages with the captured message-list query until
   the cursor passes `from` (oldest bound of the range).
3. Normalise each message to `{ id, threadId, ts, type, senderId, preview }`.
4. Filter: `senderId === myUserId && ts in range && type in selected types`.
5. Render a preview table (thread, time, type, preview) with counts.
6. Persist the job in `chrome.storage.session` so a panel close or page reload
   does not lose progress.

## Stage 3 plan (engine)

- Bounded worker pool, size from the panel (1–20).
- No fixed sleeps. Adaptive limiter: start at the configured concurrency, halve
  it on the first rate-limit/checkpoint signal, recover slowly on success.
- Per-message state machine: `pending → sending → done | failed | skipped`, with
  the failure reason recorded.
- Auto-pause after N consecutive failures; everything resumable.
- Single `location.reload()` after the queue drains, plus CSV export of the run.
