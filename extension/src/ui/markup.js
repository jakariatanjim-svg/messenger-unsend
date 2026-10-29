/*
 * Floating panel markup.
 *
 * Kept as a template string so the panel lives entirely inside a shadow root:
 * Messenger's stylesheet cannot reach in, and ours cannot leak out.
 */

(function () {
  "use strict";

  globalThis.__MBU_MARKUP__ = `
<section class="panel-root" part="panel">
  <header class="topbar" data-drag>
    <div class="titles">
      <h1>Messenger Bulk Unsend</h1>
      <p class="sub">Runs locally in your browser</p>
    </div>
    <div class="topbar__actions">
      <span id="status" class="pill pill--idle">not connected</span>
      <button id="btn-min" class="iconbtn" title="Minimise" aria-label="Minimise">–</button>
      <button id="btn-close" class="iconbtn" title="Close" aria-label="Close">×</button>
    </div>
  </header>

  <nav class="tabs" role="tablist">
    <button class="tab is-active" data-tab="scan" role="tab">Scan</button>
    <button class="tab" data-tab="messages" role="tab">Messages</button>
    <button class="tab" data-tab="diagnose" role="tab">Diagnose</button>
  </nav>

  <main>
    <section id="tab-scan" class="panel is-active">
      <div class="card">
        <h2>What to remove</h2>
        <div class="grid">
          <label class="field">
            <span>From</span>
            <input id="from" type="datetime-local" />
          </label>
          <label class="field">
            <span>To</span>
            <input id="to" type="datetime-local" />
          </label>
        </div>
        <div class="row row--tight">
          <button class="btn btn--ghost" data-preset="1h">last hour</button>
          <button class="btn btn--ghost" data-preset="12h">last 12h</button>
          <button class="btn btn--ghost" data-preset="24h">last 24h</button>
          <button class="btn btn--ghost" data-preset="7d">last 7 days</button>
        </div>

        <h3>Message types</h3>
        <div id="types" class="chips">
          <label class="chip"><input type="checkbox" value="photo" checked /><span>Photos</span></label>
          <label class="chip"><input type="checkbox" value="video" checked /><span>Video</span></label>
          <label class="chip"><input type="checkbox" value="audio" checked /><span>Voice</span></label>
          <label class="chip"><input type="checkbox" value="file" checked /><span>Files</span></label>
          <label class="chip"><input type="checkbox" value="sticker" checked /><span>Stickers</span></label>
          <label class="chip"><input type="checkbox" value="text" checked /><span>Text</span></label>
          <label class="chip"><input type="checkbox" value="link" checked /><span>Links</span></label>
          <label class="chip"><input type="checkbox" value="other" checked /><span>Other</span></label>
        </div>

        <label class="field">
          <span>Where</span>
          <select id="scope">
            <option value="inbox" selected>Whole inbox — every chat and group</option>
            <option value="open">Only the conversation on screen</option>
          </select>
        </label>

        <label class="check">
          <input id="deep" type="checkbox" checked />
          <span>Load older conversations and history before scanning</span>
        </label>

        <div class="grid">
          <label class="field">
            <span>Parallel requests</span>
            <input id="parallel" type="number" min="1" max="20" value="6" />
          </label>
          <label class="field">
            <span>Max this run (0 = no limit)</span>
            <input id="cap" type="number" min="0" value="0" />
          </label>
        </div>

        <div class="row">
          <button id="btn-scan" class="btn btn--primary">Scan</button>
          <span id="scan-note" class="note"></span>
        </div>
        <p class="hint">
          Scanning only reads. Nothing is removed until you press Start on the Messages tab.
        </p>
      </div>
    </section>

    <section id="tab-messages" class="panel">
      <div class="card">
        <h2>Preview</h2>
        <div id="summary" class="summary">No scan yet.</div>

        <div class="row">
          <button id="btn-start" class="btn btn--danger" disabled>Remove for everyone</button>
          <button id="btn-pause" class="btn" disabled>Pause</button>
          <button id="btn-stop" class="btn" disabled>Stop</button>
          <button id="btn-verify" class="btn" disabled>Verify</button>
          <button id="btn-csv" class="btn" disabled>Export CSV</button>
        </div>

        <div class="progress">
          <div id="bar" class="progress__bar"></div>
        </div>
        <div id="progress-text" class="muted small">Idle.</div>
      </div>

      <div class="card">
        <div class="card__head">
          <h2>Messages</h2>
          <label class="check check--inline">
            <input id="select-all" type="checkbox" checked />
            <span>select all</span>
          </label>
        </div>
        <div id="messages" class="list"></div>
      </div>

      <div class="card">
        <h2>Activity</h2>
        <div id="log" class="log"></div>
      </div>
    </section>

    <section id="tab-diagnose" class="panel">
      <div class="card">
        <h2>Browser state</h2>
        <p class="muted small">
          This is what the extension can see inside this Messenger tab. If scanning fails,
          this report explains why.
        </p>
        <div class="row">
          <button id="btn-caps" class="btn">Check connection</button>
          <button id="btn-diag" class="btn">Full report</button>
          <button id="btn-copy" class="btn">Copy report</button>
        </div>
        <pre id="diag-out" class="out">Not checked yet.</pre>
      </div>
    </section>
  </main>
</section>
`;
})();
