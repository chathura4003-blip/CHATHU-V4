"use strict";

/**
 * Result / Quality menus — central WhatsApp List Message + text fallback for
 * any "choose one" UI in the bot:
 *
 *   • sendResultMenu()   — search/video/song result list
 *   • sendQualityMenu()  — quality/action select after a result is picked
 *
 * Both delegate to ui/button-mode.sendMenu() so they automatically respect
 * the active button mode (on / off / auto / button / list / text) and
 * always save menu state by sent message ID for numeric reply.
 */

const buttonMode = require("./button-mode");
const builder    = require("./menu-builder");

const RESULT_PAGE_SIZE = Number(process.env.RESULT_PAGE_SIZE || 5);

function _truncate(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/**
 * Send a search-result list to the user. Returns the sent reference and the
 * full saved item list (so callers can inspect / log).
 *
 *   results: array of search-result objects (must have at least .title)
 */
async function sendResultMenu(sock, jid, query, results, options = {}, context = {}) {
  const page  = Math.max(1, parseInt(options.page) || 1);
  const total = Math.max(1, Math.ceil((results?.length || 0) / RESULT_PAGE_SIZE));
  const start = (page - 1) * RESULT_PAGE_SIZE;
  const slice = (results || []).slice(start, start + RESULT_PAGE_SIZE);

  const items = slice.map((r, i) => ({
    index:  i + 1,
    label:  _truncate(r.title || r.label || `Result ${i + 1}`, 60),
    title:  _truncate(r.title || r.label || `Result ${i + 1}`, 60),
    description: [r.duration, r.channel || r.author]
      .filter(Boolean).map(String).map((s) => s.slice(0, 30)).join(" • "),
    action: `result:select:${start + i}`,
    payload: r,
  }));

  // Pagination rows are appended *inside* the result list (not via the
  // button-mode auto-nav), to match the spec's "11. Previous / 12. Next /
  // 13. Home" layout exactly.
  const navIdx = {};
  let cursor = items.length + 1;
  if (page > 1) {
    items.push({ index: cursor, label: "⬅️ Previous", title: "Previous Page", description: `Page ${page - 1}`, action: `result:page:${page - 1}` });
    navIdx.previous = cursor; cursor++;
  }
  if (page < total) {
    items.push({ index: cursor, label: "➡️ Next", title: "Next Page", description: `Page ${page + 1}`, action: `result:page:${page + 1}` });
    navIdx.next = cursor; cursor++;
  }
  items.push({ index: cursor, label: "🏠 Home", title: "Home", action: "menu:home" });
  navIdx.home = cursor;

  // Build the boxed text body up-front (so it overrides the generic menu
  // builder and matches the spec's "RESULTS" header exactly).
  const text = builder.buildResultText(query, items.filter(it => !String(it.action).startsWith("menu:") && !String(it.action).startsWith("result:page:")), {
    title: options.title || "🔎 SEARCH RESULTS",
    page, totalPages: total,
    navigation: navIdx,
  });

  const menu = {
    id:           options.id || "search-results",
    type:         "results",
    level:        "results",
    title:        options.title || "🔎 SEARCH RESULTS",
    titleShort:   "Results",
    sectionTitle: options.sectionTitle || "Search Results",
    buttonText:   options.buttonText || "📋 Choose Result",
    items,
    payload:      { query, results, page, totalPages: total, ...(options.payload || {}) },
    previousMenu: options.previousMenu || null,
    page,
    totalPages:   total,
    text,
    body:         text,
    footer:       options.footer || `${context.botName || "CHATHU MD"} • Results`,
    navigation:   false, // we already added our own nav rows
  };

  return await buttonMode.sendMenu(sock, jid, menu, options.send || {}, context);
}

/**
 * Send a quality / action menu for a chosen result. The default options
 * are: HD video, audio, document, link.
 *
 *   payload: the original result/meta object so the dispatcher can use its
 *            `.url` (and any sibling fields) when the user picks an option.
 */
async function sendQualityMenu(sock, jid, payload, options = {}, context = {}) {
  const items = options.items || [
    { label: "🎬 HD Video",   title: "HD Video",   action: "quality:select:hd",       payload },
    { label: "📺 SD Video",   title: "SD Video",   action: "quality:select:sd",       payload },
    { label: "🎵 Audio Only", title: "Audio Only", action: "quality:select:audio",    payload },
    { label: "📄 Document",   title: "Document",   action: "quality:select:document", payload },
    { label: "🔗 Get Link",   title: "Get Link",   action: "quality:select:link",     payload },
  ];

  // Re-index 1-based to match the saved-state contract.
  const indexed = items.map((it, i) => ({ ...it, index: i + 1, payload }));

  const menu = {
    id:           options.id || "quality-select",
    type:         "quality",
    level:        "quality",
    title:        options.title || "🎚 SELECT ACTION",
    sectionTitle: "Options",
    buttonText:   "📋 Choose Action",
    headerFields: payload?.title
      ? [{ label: "Title", value: _truncate(payload.title, 40) }]
      : [],
    items:        indexed,
    payload:      { result: payload, ...(options.payload || {}) },
    previousMenu: options.previousMenu || null,
    footer:       options.footer || `${context.botName || "CHATHU MD"} • Quality`,
    navigation:   { back: true, home: true, list: false },
  };

  return await buttonMode.sendMenu(sock, jid, menu, options.send || {}, context);
}

module.exports = {
  RESULT_PAGE_SIZE,
  sendResultMenu,
  sendQualityMenu,
};
