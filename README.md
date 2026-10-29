# Messenger Bulk Unsend

Remove **your own** Facebook Messenger messages for everyone — in bulk, inside a
date and time range, across every chat and group in your inbox.

No account, no sign-up, no server. Everything happens inside your own browser,
with your own logged-in session.

> "Remove for everyone" replaces the message with *This message was deleted* for
> the other person as well. That note cannot be avoided — Messenger always shows
> it after a message is removed for everyone.

---

## What it does

- **Bulk remove for everyone.** Pick a time window, review the list, press once.
  Hundreds of messages go in a few minutes instead of one every twenty seconds.
- **Only your messages.** Messages other people sent are never touched.
- **Date and time range.** From/to, down to the minute — so you keep the
  conversations that still matter.
- **Message types.** Remove only photos and video, only text, only voice notes,
  or any combination.
- **Whole inbox or one chat.** Clean every conversation and group at once, or
  just the one you have open.
- **Preview before anything happens.** Scanning only reads. Nothing is removed
  until you confirm the list.
- **Stop anytime.** Pause, resume or stop mid-run; the activity log records what
  happened to each message.
- **Export.** Save the run as a CSV file.

## Install

1. Download and unzip this repository.
2. Open `chrome://extensions` in Chrome, Edge, Brave or another Chromium browser.
3. Turn on **Developer mode** (top-right corner).
4. Click **Load unpacked** and choose the `extension` folder.
5. Pin the extension so you can reach it easily.

## Use

1. Sign in at <https://www.messenger.com> and leave the tab open.
2. Click the extension icon, or the red **MBU** bubble in the bottom-right corner.
   The panel opens floating over the page — drag it by its title bar, or press
   **–** to minimise it out of the way.
3. On the **Scan** tab choose the time window and message types, then press
   **Scan**.
4. On the **Messages** tab check the list. Untick anything you want to keep.
5. Press **Remove for everyone**, then confirm.

If scanning reports that it cannot read your messages, open the **Diagnose**
tab, press **Full report** and keep that text: it says exactly which part of
Messenger changed.

## Privacy

- No server, no account, no telemetry, no analytics.
- Nothing is uploaded. The message list stays in your browser's memory.
- Your session is never read, stored or sent anywhere.
- The extension only has access to `messenger.com` and `facebook.com/messages`.

## Requirements

- A Chromium-based browser (Chrome 116 or newer recommended).
- A logged-in Messenger session in that browser.

## Limits worth knowing

- Scanning reads what Messenger has cached locally and can ask the app to fetch
  older pages. A conversation that has never been opened may still need one
  visit before its history is complete.
- Encrypted conversations use a different internal path from ordinary ones. Both
  are handled, but a Messenger update can break either, so check the first run
  with a small window.
- A recipient who already took a screenshot keeps it.
- Removing messages in a group is visible as *You removed a message*.
- This tool drives Messenger's own client internals, which Meta can change
  without notice. Use it on your own account, at your own risk.

## License

MIT.
