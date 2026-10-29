/*
 * Core helpers: pure functions, no page globals.
 * Loaded in the page context and mirrored by test/core.test.mjs in Node.
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.MBU_CORE = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // ------------------------------------------------------------------ values

  /** Meta mixes seconds, milliseconds and microseconds; normalise to ms. */
  function normalizeTs(value) {
    const n = typeof value === "string" ? Number(value) : value;
    if (!Number.isFinite(n) || n <= 0) return 0;
    if (n < 1e11) return Math.round(n * 1000); // seconds
    if (n >= 1e14) return Math.round(n / 1000); // microseconds
    return Math.round(n);
  }

  function firstDefined(source, keys) {
    if (!source || typeof source !== "object") return undefined;
    for (const key of keys) {
      const value = key.includes(".")
        ? key.split(".").reduce((acc, part) => (acc == null ? acc : acc[part]), source)
        : source[key];
      if (value !== undefined && value !== null) return value;
    }
    return undefined;
  }

  function asId(value) {
    if (value == null) return null;
    if (typeof value === "string") return value.trim() || null;
    if (typeof value === "number" || typeof value === "bigint") return String(value);
    if (typeof value === "object" && typeof value.toString === "function") {
      const text = String(value);
      return text && text !== "[object Object]" ? text : null;
    }
    return null;
  }

  function toArray(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (typeof value.toArray === "function") {
      try {
        return value.toArray();
      } catch {
        return [];
      }
    }
    if (typeof value === "object") return Object.values(value);
    return [];
  }

  // -------------------------------------------------------------------- rows

  const MESSAGE_ID_KEYS = [
    "messageId",
    "message_id",
    "offline_threading_id",
    "offlineThreadingId",
    "msg_id",
    "id",
  ];
  const MESSAGE_TS_KEYS = [
    "timestampMs",
    "timestamp_ms",
    "timestamp",
    "ts",
    "server_timestamp_ms",
    "sendTime",
  ];
  const SENDER_KEYS = [
    "senderId",
    "sender_id",
    "sender_fbid",
    "senderFbId",
    "authorId",
    "author",
  ];
  const THREAD_KEYS = ["threadKey", "thread_key", "threadFbId", "thread_fbid", "threadId"];
  const TEXT_KEYS = ["text", "body", "message", "messageText", "snippet"];
  const ATTACHMENT_KEYS = [
    "attachments",
    "blobAttachments",
    "blob_attachments",
    "attachmentMeta",
    "media",
    "blobs",
  ];
  const STICKER_KEYS = ["stickerId", "sticker_id", "sticker"];

  /** Classify a message row into one of the filter buckets. */
  function classifyType(row) {
    if (!row || typeof row !== "object") return "other";

    const attachments = toArray(firstDefined(row, ATTACHMENT_KEYS)).filter(Boolean);
    for (const item of attachments) {
      const type = String(
        firstDefined(item, ["type", "mediaType", "attachmentType", "mimeType", "kind"]) || ""
      ).toLowerCase();

      if (/sticker/.test(type)) return "sticker";
      if (/video/.test(type)) return "video";
      if (/audio|voice/.test(type)) return "audio";
      if (/image|photo|picture/.test(type)) return "photo";
      if (/file|document|pdf/.test(type)) return "file";

      // Attachment objects often expose the URL only and put the real type in
      // a nested "playableUrl"/"image" field.
      const url = String(
        firstDefined(item, ["playableUrl", "downloadUrl", "url", "previewUrl", "src"]) || ""
      ).toLowerCase();
      if (/\.(mp4|mov|webm)/.test(url)) return "video";
      if (/\.(mp3|m4a|ogg|opus)/.test(url)) return "audio";
      if (/\.(jpe?g|png|gif|webp|heic)/.test(url)) return "photo";
      if (url) return "file";
    }

    if (asId(firstDefined(row, STICKER_KEYS))) return "sticker";

    const text = String(firstDefined(row, TEXT_KEYS) || "");
    if (/^https?:\/\/\S+$/.test(text.trim())) return "link";
    return "text";
  }

  /** Normalise one raw message row, or return null when it is unusable. */
  function parseMessageRow(row, { fallbackThreadKey = null } = {}) {
    if (!row || typeof row !== "object") return null;

    const id = asId(firstDefined(row, MESSAGE_ID_KEYS));
    if (!id) return null;

    const ts = normalizeTs(firstDefined(row, MESSAGE_TS_KEYS));
    const text = String(firstDefined(row, TEXT_KEYS) || "");
    const preview = text.replace(/\s+/g, " ").trim().slice(0, 80);

    const cannotUnsend = firstDefined(row, ["cannotUnsendReason", "cannot_unsend_reason"]);
    const isUnsentFlag = firstDefined(row, ["isUnsent", "is_unsent", "unsent"]);
    const isAdmin = firstDefined(row, ["isAdminMessage", "is_admin_message"]);

    return {
      id,
      threadKey: asId(firstDefined(row, THREAD_KEYS)) || fallbackThreadKey,
      ts,
      type: classifyType(row),
      senderId: asId(firstDefined(row, SENDER_KEYS)),
      preview,
      isUnsent: isUnsentFlag === true || isUnsentFlag === 1,
      isAdmin: isAdmin === true || isAdmin === 1,
      // 0 or "0" means "no blocking reason"; anything else means not unsendable.
      cannotUnsend: cannotUnsend == null ? false : String(cannotUnsend) !== "0",
      expired: firstDefined(row, ["isExpired", "is_expired"]) === true,
    };
  }

  function parseThreadRow(row) {
    if (!row || typeof row !== "object") return null;
    const key = asId(firstDefined(row, THREAD_KEYS));
    if (!key) return null;

    const protocol = String(
      firstDefined(row, ["protocolKind", "protocol", "transport", "threadType"]) || ""
    ).toLowerCase();
    const isE2ee =
      firstDefined(row, ["isE2ee", "is_e2ee", "e2ee", "isEncrypted"]) === true ||
      /e2ee|encrypted|mawak|whatsapp/.test(protocol);

    return {
      threadKey: key,
      name: String(firstDefined(row, ["name", "threadName", "thread_name", "title"]) || ""),
      isE2ee,
      chatJid: asId(firstDefined(row, ["chatJid", "chat_jid", "jid"])),
      lastTs: normalizeTs(
        firstDefined(row, ["lastActivityTimestampMs", "last_activity_timestamp_ms", "timestamp"])
      ),
      participantCount: toArray(firstDefined(row, ["participants", "participantIds"])).length,
    };
  }

  /**
   * Encrypted message ids look like "<jid>.<externalId>" where the jid contains
   * an "@" (e.g. "12345@msgr"). Plain ids start with "mid.".
   */
  function parseE2eeMessageId(id) {
    if (typeof id !== "string" || !id.includes("@")) return null;
    if (id.startsWith("mid.")) return null;
    const cut = id.lastIndexOf(".");
    if (cut <= 0 || cut === id.length - 1) return null;
    const chatJid = id.slice(0, cut);
    if (!chatJid.includes("@")) return null;
    return { chatJid, externalId: id.slice(cut + 1) };
  }

  function isPlainMessageId(id) {
    return typeof id === "string" && id.startsWith("mid.");
  }

  // ----------------------------------------------------------------- filters

  function matchesFilters(message, filters, myUserId) {
    if (!message) return false;
    const f = filters || {};

    if (f.types && f.types.length && !f.types.includes(message.type)) return false;
    if (f.from != null && message.ts && message.ts < f.from) return false;
    if (f.to != null && message.ts && message.ts > f.to) return false;
    if (f.keyword && !message.preview.toLowerCase().includes(String(f.keyword).toLowerCase())) {
      return false;
    }
    if (f.onlyMine !== false && message.senderId && myUserId && message.senderId !== myUserId) {
      return false;
    }
    if (f.skipUnsendable !== false && (message.cannotUnsend || message.expired)) return false;
    return true;
  }

  // -------------------------------------------------------------------- misc

  function formatCsv(rows) {
    const header = ["thread", "type", "sent_at", "status", "message_id", "preview"];
    const escape = (value) => {
      const text = value == null ? "" : String(value);
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const lines = [header.join(",")];
    for (const row of rows || []) {
      lines.push(
        [
          row.threadKey,
          row.type,
          row.ts ? new Date(row.ts).toISOString() : "",
          row.status || "",
          row.id,
          row.preview,
        ]
          .map(escape)
          .join(",")
      );
    }
    return lines.join("\n");
  }

  function chunk(items, size) {
    const out = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
  }

  function shortId(id, keep = 8) {
    if (!id) return "?";
    const text = String(id);
    return text.length <= keep * 2 ? text : `${text.slice(0, keep)}…${text.slice(-keep)}`;
  }

  return {
    normalizeTs,
    firstDefined,
    asId,
    toArray,
    classifyType,
    parseMessageRow,
    parseThreadRow,
    parseE2eeMessageId,
    isPlainMessageId,
    matchesFilters,
    formatCsv,
    chunk,
    shortId,
  };
});
