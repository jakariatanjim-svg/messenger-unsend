/*
 * Messenger Bulk Unsend - MAIN world hook
 * ---------------------------------------
 * Runs in the page context (world: MAIN) at document_start.
 *
 * Responsibilities (stage 1: recon / auto-learn):
 *   1. Observe every Facebook GraphQL request the page makes and record the
 *      operation "recipe": doc_id, variables shape, and the auth tokens that
 *      came with it (fb_dtsg / lsd / jazoest / av / __user).
 *   2. Replay a captured operation programmatically with new variables.
 *      This is what lets us unsend hundreds of messages without clicking the
 *      UI, and without hardcoding any doc_id that Meta can rotate at will.
 *
 * Nothing is sent to any server. Tokens stay in page memory only.
 */

(function () {
  "use strict";

  const CHANNEL = "__mbu_channel__";
  const MAX_OPS = 300;
  const OPS = Object.create(null); // name -> recipe
  let seq = 0;

  // ---------------------------------------------------------------- utilities

  function uid() {
    seq += 1;
    return `${Date.now().toString(36)}-${seq}`;
  }

  function toText(body) {
    if (!body) return null;
    if (typeof body === "string") return body;
    if (body instanceof URLSearchParams) return body.toString();
    if (typeof FormData !== "undefined" && body instanceof FormData) {
      const p = new URLSearchParams();
      body.forEach((v, k) => p.append(k, typeof v === "string" ? v : "[file]"));
      return p.toString();
    }
    if (typeof body === "object") {
      try {
        return new URLSearchParams(body).toString();
      } catch {
        return null;
      }
    }
    return null;
  }

  function isGraphql(url) {
    return typeof url === "string" && /\/api\/graphql(\/|\?|$)/.test(url);
  }

  function safeJson(text, fallback) {
    try {
      return JSON.parse(text);
    } catch {
      return fallback;
    }
  }

  /**
   * Read the session tokens straight out of the page markup. Used as a
   * fallback when the captured recipe is older than a token rotation.
   */
  function freshTokens() {
    const out = {};
    try {
      const html = document.documentElement ? document.documentElement.innerHTML : "";
      const dtsg = /"DTSGInitialData",\[\],\{"token":"([^"]+)"/.exec(html);
      const dtsg2 = /name="fb_dtsg"\s+value="([^"]+)"/.exec(html);
      const lsd = /"LSD",\[\],\{"token":"([^"]+)"/.exec(html);
      const userId = /"USER_ID":"(\d+)"/.exec(html) || /"actorID":"(\d+)"/.exec(html);
      if (dtsg) out.fb_dtsg = dtsg[1];
      else if (dtsg2) out.fb_dtsg = dtsg2[1];
      if (lsd) out.lsd = lsd[1];
      if (userId) out.__user = userId[1];
      if (out.fb_dtsg) out.jazoest = jazoest(out.fb_dtsg);
    } catch {
      /* page markup not readable - keep whatever we learned */
    }
    return out;
  }

  /** Meta's jazoest = "2" + sum of char codes of fb_dtsg. */
  function jazoest(token) {
    let sum = 0;
    for (let i = 0; i < token.length; i += 1) sum += token.charCodeAt(i);
    return "2" + sum;
  }

  // ------------------------------------------------------------- op recording

  function record(rawUrl, bodyText, method) {
    if (!bodyText) return null;
    let params;
    try {
      params = new URLSearchParams(bodyText);
    } catch {
      return null;
    }

    const docId = params.get("doc_id");
    if (!docId) return null;

    const name =
      params.get("fb_api_req_friendly_name") ||
      params.get("friendly_name") ||
      `doc_${docId}`;

    const variables = safeJson(params.get("variables") || "{}", {});
    const prev = OPS[name];

    const recipe = {
      name,
      docId,
      method: method || "POST",
      url: String(rawUrl).replace(/^https?:\/\/[^/]+/, ""),
      variableKeys: Object.keys(variables),
      variables, // last seen sample - used as replay template
      tokens: {
        fb_dtsg: params.get("fb_dtsg") || undefined,
        lsd: params.get("lsd") || undefined,
        jazoest: params.get("jazoest") || undefined,
        av: params.get("av") || undefined,
        __user: params.get("__user") || undefined,
        __rev: params.get("__rev") || undefined,
        __ccg: params.get("__ccg") || undefined,
        fb_api_caller_class: params.get("fb_api_caller_class") || "RelayModern",
        fb_api_req_friendly_name: name,
      },
      // everything else the page sent that we do not want to lose on replay
      extras: Object.fromEntries(
        [...params].filter(
          ([k]) =>
            ![
              "doc_id",
              "variables",
              "fb_dtsg",
              "lsd",
              "jazoest",
              "av",
              "__user",
              "__rev",
              "__ccg",
              "fb_api_caller_class",
              "fb_api_req_friendly_name",
            ].includes(k)
        )
      ),
      hits: prev ? prev.hits + 1 : 1,
      lastSeen: Date.now(),
      lastResponse: prev ? prev.lastResponse : null,
    };

    OPS[name] = recipe;
    pruneOps();
    emit({ kind: "op", recipe: serialize(recipe) });
    return recipe;
  }

  function pruneOps() {
    const names = Object.keys(OPS);
    if (names.length <= MAX_OPS) return;
    names
      .sort((a, b) => OPS[a].lastSeen - OPS[b].lastSeen)
      .slice(0, names.length - MAX_OPS)
      .forEach((n) => delete OPS[n]);
  }

  /** Strip the bulky bits before posting to the isolated world. */
  function serialize(r) {
    const clone = { ...r };
    if (clone.lastResponse && String(clone.lastResponse).length > 2000) {
      clone.lastResponse = String(clone.lastResponse).slice(0, 2000);
    }
    return clone;
  }

  function attachResponse(name, text) {
    const r = OPS[name];
    if (!r || typeof text !== "string") return;
    r.lastResponse = text.length > 4000 ? text.slice(0, 4000) : text;
    const ok =
      /"data"\s*:\s*\{/.test(text) &&
      !/"errors"\s*:\s*\[(?!\s*\])/.test(text) &&
      !/"error"\s*:\s*[1-9]/.test(text);
    emit({
      kind: "resp",
      name,
      ok,
      status: text.slice(0, 4000),
    });
  }

  // ------------------------------------------------------------------ channel

  function emit(payload) {
    window.postMessage(
      Object.assign({ channel: CHANNEL, dir: "from-hook" }, payload),
      window.location.origin
    );
  }

  // --------------------------------------------------------------- fetch hook

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === "function") {
    window.fetch = function (input, init) {
      const url = typeof input === "string" ? input : input && input.url;
      let recipe = null;
      let bodyText = null;

      if (isGraphql(url)) {
        bodyText = toText(init && init.body);
        if (!bodyText && input && typeof input !== "string" && typeof input.text === "function") {
          // Request objects are rare here, but do not break them.
          recipe = null;
        }
        if (bodyText) recipe = record(url, bodyText, (init && init.method) || "POST");
      }

      const promise = nativeFetch.apply(this, arguments);
      if (recipe) {
        promise
          .then((res) => {
            try {
              res
                .clone()
                .text()
                .then((t) => attachResponse(recipe.name, t))
                .catch(() => {});
            } catch {
              /* ignore */
            }
            return res;
          })
          .catch(() => {});
      }
      return promise;
    };
  }

  // ---------------------------------------------------------------- XHR hook

  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const nativeOpen = XHR.prototype.open;
    const nativeSend = XHR.prototype.send;

    XHR.prototype.open = function (method, url) {
      this.__mbu = { method, url: String(url) };
      return nativeOpen.apply(this, arguments);
    };

    XHR.prototype.send = function (body) {
      try {
        const meta = this.__mbu;
        if (meta && isGraphql(meta.url)) {
          const text = toText(body);
          const recipe = text ? record(meta.url, text, meta.method) : null;
          if (recipe) {
            this.addEventListener("load", () => {
              try {
                attachResponse(recipe.name, String(this.responseText || "").slice(0, 4000));
              } catch {
                /* ignore */
              }
            });
          }
        }
      } catch {
        /* never break the page */
      }
      return nativeSend.apply(this, arguments);
    };
  }

  // ------------------------------------------------------------- replay engine

  async function replay({ opName, variables, url, keepTemplate, method }) {
    const recipe = OPS[opName];
    if (!recipe) throw new Error(`Unknown operation: ${opName}`);

    const tokens = Object.assign({}, recipe.tokens, freshTokens());
    if (tokens.fb_dtsg && !tokens.jazoest) tokens.jazoest = jazoest(tokens.fb_dtsg);

    const mergedVars = keepTemplate
      ? Object.assign({}, recipe.variables, variables || {})
      : Object.assign({}, variables || {});

    const params = new URLSearchParams();
    params.set("av", tokens.av || recipe.tokens.av || "");
    if (tokens.__user) params.set("__user", tokens.__user);
    if (tokens.__a) params.set("__a", "1");
    params.set("__ccg", tokens.__ccg || "EXCELLENT");
    params.set("__rev", tokens.__rev || "");
    params.set("__req", (seq++ ).toString(36));
    params.set("__hs", recipe.extras.__hs || "");
    params.set("dpr", "1");
    params.set("__comet_req", recipe.extras.__comet_req || "29");
    params.set("fb_dtsg", tokens.fb_dtsg || "");
    if (tokens.jazoest) params.set("jazoest", tokens.jazoest);
    if (tokens.lsd) params.set("lsd", tokens.lsd);
    params.set("fb_api_caller_class", "RelayModern");
    params.set("fb_api_req_friendly_name", recipe.name);
    params.set("variables", JSON.stringify(mergedVars));
    params.set("doc_id", recipe.docId);
    params.set("server_timestamps", "true");

    Object.entries(recipe.extras || {}).forEach(([k, v]) => {
      if (["__req", "__a", "av", "dpr", "variables", "doc_id"].includes(k)) return;
      if (!params.has(k)) params.set(k, v);
    });

    const target = url || recipe.url || "/api/graphql/";
    const started = Date.now();
    const res = await nativeFetch.call(window, target, {
      method: method || recipe.method || "POST",
      credentials: "include",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-fb-friendly-name": recipe.name,
        ...(tokens.lsd ? { "x-fb-lsd": tokens.lsd } : {}),
      },
      body: params.toString(),
    });

    const text = await res.text();
    return {
      status: res.status,
      ok: res.ok,
      ms: Date.now() - started,
      body: text.slice(0, 6000),
      sentVariables: mergedVars,
    };
  }

  // ----------------------------------------------------------- message channel

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.channel !== CHANNEL || data.dir !== "to-hook") return;

    const reply = (payload) =>
      window.postMessage(
        Object.assign(
          { channel: CHANNEL, dir: "from-hook", id: data.id, kind: "reply" },
          payload
        ),
        window.location.origin
      );

    if (data.kind === "ping") {
      reply({ result: { alive: true, ops: Object.keys(OPS).length, href: location.href } });
      return;
    }

    if (data.kind === "list-ops") {
      reply({ result: Object.values(OPS).map(serialize) });
      return;
    }

    if (data.kind === "replay") {
      replay(data.payload || {})
        .then((r) => reply({ result: r }))
        .catch((e) => reply({ error: String((e && e.message) || e) }));
      return;
    }
  });

  emit({ kind: "ready", href: location.href });
})();
