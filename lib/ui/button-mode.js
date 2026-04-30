"use strict";

/**
 * Button Mode — the central UI mode for every menu the bot sends.
 *
 * V4.2: simplified to a binary switch.
 *   on  — Advanced UI Engine (default).
 *         WhatsApp buttons / list / native flow + advanced text fallback.
 *         New menu-state numeric reply, result-menu, quality-menu, dispatcher.
 *   off — Legacy flow.
 *         Skip the advanced UI completely; every menu / search / download /
 *         settings flow runs through the original pre-V4 code paths.
 *
 * Old persisted values still load: `auto`/`button`/`list`/`true`/`1`/`yes`
 * collapse to "on"; `text`/`false`/`0`/`no` collapse to "off".
 *
 * `sendMenu(sock, jid, menu, options, context)` is the central function the
 * rest of the bot calls. It always returns the sent message reference (or
 * null on total failure) and always saves menu state by sent message ID so
 * a subsequent numeric reply can resolve back to the correct items.
 */

const { logger } = require("../../logger");
const builder    = require("./menu-builder");
const menuState  = require("./menu-state");
const roleHelp   = require("./role-menu");
const access     = require("./access-control");

const VALID_MODES = ["on", "off"];
const DEFAULT_MODE = "on";

function cleanText(text = "", max = 40) {
  return String(text || "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

// ---------------------------------------------------------------------------
// Mode detection
// ---------------------------------------------------------------------------

function _normalizeMode(m) {
  if (m == null) return null;
  const v = String(m).toLowerCase().trim();
  if (!v) return null;
  if (["off", "false", "0", "no", "n", "text", "disable", "disabled", "legacy"].includes(v)) return "off";
  if (["on", "true", "1", "yes", "y", "auto", "button", "list", "enable", "enabled", "advanced"].includes(v)) return "on";
  return null;
}

/**
 * Resolve the active button mode for a request, in order of priority:
 *   1. explicit context.buttonMode (per-call override)
 *   2. session.buttonMode          (per-session)
 *   3. global state buttonMode     (db setting)
 *   4. process.env.BUTTON_MODE     (boot default)
 *   5. DEFAULT_MODE                (final fallback)
 *
 * Always returns "on" or "off".
 */
function getButtonMode(context = {}) {
  const direct = _normalizeMode(context.buttonMode);
  if (direct) return direct;

  const sess = context.session && _normalizeMode(context.session.buttonMode);
  if (sess) return sess;

  try {
    const appState = require("../../state");
    if (typeof appState.getButtonMode === "function") {
      const v = _normalizeMode(appState.getButtonMode());
      if (v) return v;
    }
  } catch (_) { /* state may not be available in tests */ }

  try {
    const db = require("../db");
    if (db && typeof db.getSetting === "function") {
      const v = _normalizeMode(db.getSetting("buttonMode"));
      if (v) return v;
    }
  } catch (_) { /* db may not be available */ }

  const env = _normalizeMode(process.env.BUTTON_MODE);
  if (env) return env;

  return DEFAULT_MODE;
}

/**
 * Convenience boolean: should the advanced UI engine handle this request?
 *
 * When this returns false, callers should completely skip the advanced
 * UI pipeline (sendMenu, sendResultMenu, dispatch, menu-state numeric
 * fallback, etc.) and fall through to whatever legacy code path used to
 * handle the same flow before V4.
 */
function isButtonModeOn(context = {}) {
  return getButtonMode(context) === "on";
}

function setButtonMode(mode) {
  const norm = _normalizeMode(mode);
  if (!norm) return false;
  try {
    const appState = require("../../state");
    if (typeof appState.setButtonMode === "function") {
      appState.setButtonMode(norm);
      return true;
    }
  } catch (_) {}
  try {
    const db = require("../db");
    if (db && typeof db.setSetting === "function") {
      db.setSetting("buttonMode", norm);
      return true;
    }
  } catch (_) {}
  return false;
}

// ---------------------------------------------------------------------------
// Action ID extraction (button tap, list pick, native-flow)
// ---------------------------------------------------------------------------

function extractMenuActionId(msg) {
  if (!msg || !msg.message) return "";
  const m = msg.message;
  return (
    m.buttonsResponseMessage?.selectedButtonId ||
    m.templateButtonReplyMessage?.selectedId ||
    m.listResponseMessage?.singleSelectReply?.selectedRowId ||
    extractNativeFlowId(m.interactiveResponseMessage) ||
    ""
  );
}

function extractNativeFlowId(interactive) {
  if (!interactive) return "";
  const nfm = interactive.nativeFlowResponseMessage;
  if (!nfm?.paramsJson) return "";
  try {
    const parsed = JSON.parse(nfm.paramsJson);
    if (!parsed || typeof parsed !== "object") return "";
    const id =
      parsed.id ||
      parsed.button_id ||
      parsed.buttonId ||
      parsed.selectedRowId ||
      parsed.selected_row_id ||
      parsed.rowId ||
      parsed.row_id ||
      parsed.single_select_reply?.selectedRowId ||
      parsed.singleSelectReply?.selectedRowId;
    if (id && typeof id === "string") return id;
  } catch (_) { /* ignore */ }
  return "";
}

/**
 * Best-effort lookup of the *quoted* message ID across every WhatsApp
 * message variant the bot sees (text, image caption, video caption, button
 * response, list response, interactive native-flow response).
 */
function extractQuotedStanzaId(msg) {
  if (!msg || !msg.message) return null;
  const m = msg.message;
  return (
    m.extendedTextMessage?.contextInfo?.stanzaId ||
    m.imageMessage?.contextInfo?.stanzaId ||
    m.videoMessage?.contextInfo?.stanzaId ||
    m.documentMessage?.contextInfo?.stanzaId ||
    m.buttonsResponseMessage?.contextInfo?.stanzaId ||
    m.listResponseMessage?.contextInfo?.stanzaId ||
    m.interactiveResponseMessage?.contextInfo?.stanzaId ||
    null
  );
}

// ---------------------------------------------------------------------------
// Senders
// ---------------------------------------------------------------------------

async function sendTextMenu(sock, jid, text, options = {}) {
  return await sock.sendMessage(jid, { text }, options);
}

async function sendButtonMenu(sock, jid, menu, items, options = {}) {
  const buttons = items.slice(0, 3).map((item, index) => ({
    buttonId: item.action || item.id || `menu:item:${index}`,
    buttonText: {
      displayText: (item.shortLabel || item.label || item.title || `Option ${index + 1}`).slice(0, 30),
    },
    type: 1,
  }));
  if (!buttons.length) throw new Error("no buttons to send");
  const content = {
    text:    menu.text || menu.body || "Please choose one option.",
    footer:  menu.footer || "CHATHU MD",
    buttons,
    headerType: 1,
  };
  return await sock.sendMessage(jid, content, options);
}

async function sendListMenu(sock, jid, menu, items, options = {}) {
  if (!items?.length) throw new Error("no list rows to send");
  const rows = items.slice(0, 10).map((item, index) => ({
    title:       cleanText(item.title || item.label || `Option ${index + 1}`, 35),
    rowId:       String(item.action || item.id || `menu:item:${index}`).slice(0, 80),
    description: cleanText(item.description || item.subtitle || "", 60),
  }));
  const content = {
    text:        menu.text || menu.body || "Please choose one option.",
    footer:      menu.footer || "CHATHU MD",
    title:       menu.title  || "Select Option",
    buttonText:  menu.buttonText || "📋 Open Menu",
    sections: [
      { title: menu.sectionTitle || "Options", rows },
    ],
  };
  return await sock.sendMessage(jid, content, options);
}

async function sendClassicListMenu(sock, jid, menu, items, options = {}) {
  const rows = items.slice(0, 10).map((item, index) => ({
    title:       cleanText(item.title || item.label || `Option ${index + 1}`, 35),
    rowId:       String(item.action || item.id || `menu:item:${index}`).slice(0, 80),
    description: cleanText(item.description || item.subtitle || "", 60),
  }));

  return await sock.sendMessage(jid, {
    text:       menu.text || menu.body || "Please choose one option.",
    footer:     menu.footer || "CHATHU MD",
    title:      menu.title || "Select Option",
    buttonText: menu.buttonText || "📋 Open Menu",
    sections: [
      {
        title: menu.sectionTitle || "Options",
        rows,
      },
    ],
  }, options);
}

// ---------------------------------------------------------------------------
// Central dispatch
// ---------------------------------------------------------------------------

/**
 * sendMenu(sock, jid, menu, options, context)
 *
 * `menu` shape:
 *   {
 *     id, type, level, categoryId, page, totalPages,
 *     title, subtitle, sectionTitle, headerFields[], footer,
 *     text, body, buttonText,
 *     navigation: { back, home, list, previous, next },
 *     items: [{ index, label, title, description, action, payload, ownerOnly, premiumOnly, ... }],
 *     payload, previousMenu,
 *   }
 *
 * `context` shape (suggested):
 *   { sender, chatJid, ownerRefs, prefix, botName, pushName, workMode,
 *     buttonMode (override), session, isOwner, ownerOnly }
 *
 * Returns the sent message reference (the *outer* envelope used to derive
 * the menu-state key) so callers can quote against it later.
 */
async function sendMenu(sock, jid, menu, options = {}, context = {}) {
  if (!sock || !jid || !menu) return null;

  const role  = roleHelp.getUserRole(context);
  // Filter items by role + access flags before rendering / sending.
  const filtered = (Array.isArray(menu.items) ? menu.items : [])
    .filter((it) => access.canAccess(it, { ...context, chatJid: jid }).allowed);

  // Re-number visible items (so the user replies "3" against what they see,
  // not against the original unfiltered indexes).
  const items = filtered.map((it, i) => ({ ...it, index: i + 1 }));

  // Compute navigation slots immediately after the last data item, so the
  // text builder & list rows can include "Back / Home / Menu List".
  const nav = _resolveNavigation(menu, items.length);
  if (nav.items.length) {
    items.push(...nav.items);
  }

  const buttonMode = getButtonMode(context);
  const text = builder.buildMenuText(
    {
      ...menu,
      navigation: nav.indexes,
    },
    items,
    { ...context, role, buttonMode },
  );

  const renderedMenu = {
    ...menu,
    text:        menu.text || menu.body || text,
    body:        menu.body || text,
    footer:      menu.footer || `${context.botName || "CHATHU MD"} • ${builder.MENU_MARKER}`,
    title:       menu.title || (menu.titleShort || "Select Option"),
    buttonText:  menu.buttonText || "📋 Choose One",
    sectionTitle: menu.sectionTitle || "Options",
  };

  let sent = null;
  let attemptedRich = false;

  // Prefer the caller's pre-rendered `menu.text` (e.g. result-menu's query +
  // duration + pagination block) when sending the text fallback, so off /
  // text mode and rich-send failures keep the menu-specific format instead
  // of regenerating a generic numbered list. `text` is always available as a
  // last-resort safety net.
  const fallbackText = renderedMenu.text || text;

  logger(`[UI] buttonMode: ${buttonMode}`);
  logger(`[UI] menu id: ${menu.id}`);
  logger(`[UI] visible items: ${items.length}`);
  logger(`[UI] attempting: ${items.length <= 3 ? "buttons" : "list"}`);

  try {
    if (buttonMode === "off") {
      sent = await sendTextMenu(sock, jid, fallbackText, options);
    } else {
      attemptedRich = true;
      if (items.length <= 3) {
        try {
          sent = await sendButtonMenu(sock, jid, renderedMenu, items, options);
        } catch (buttonErr) {
          logger(`[UI] button send failed: ${buttonErr?.message || buttonErr}`);
          sent = await sendTextMenu(sock, jid, fallbackText, options);
        }
      } else {
        try {
          sent = await sendListMenu(sock, jid, renderedMenu, items, options);
        } catch (nativeErr) {
          logger(`[UI] native/list send failed: ${nativeErr?.message || nativeErr}`);
          logger(`[UI] native/list stack: ${nativeErr?.stack || ""}`);
          logger(`[UI] trying classic list fallback`);
          try {
            sent = await sendClassicListMenu(sock, jid, renderedMenu, items, options);
          } catch (classicErr) {
            logger(`[UI] classic list failed: ${classicErr?.message || classicErr}`);
            logger(`[UI] all interactive sends failed, using text fallback`);
            sent = await sendTextMenu(sock, jid, fallbackText, options);
          }
        }
      }
    }
  } catch (err) {
    logger(`[UI] all senders failed: ${err.message}`);
    try { sent = await sendTextMenu(sock, jid, fallbackText, options); } catch (_) {}
  }

  // Always save state by message ID so numeric reply works even after a
  // fallback path. We save the *full visible items list* (including the nav
  // entries we inserted) so a numeric reply against a nav row resolves.
  const messageId = sent?.key?.id || null;
  menuState.saveMenuState(messageId, {
    type:          menu.type || "menu",
    menuId:        menu.id,
    level:         menu.level || "top",
    categoryId:    menu.categoryId || null,
    chatJid:       jid,
    userJid:       context.sender || null,
    role,
    items,
    payload:       menu.payload || {},
    page:          menu.page || 1,
    totalPages:    menu.totalPages || 1,
    previousMenu:  menu.previousMenu || null,
  });

  return sent;
}

// ---------------------------------------------------------------------------
// Navigation helpers
// ---------------------------------------------------------------------------

function _resolveNavigation(menu, lastDataIndex) {
  const out = { items: [], indexes: {} };
  if (!menu) return out;
  // Auto-add navigation entries unless menu.navigation === false.
  const want = menu.navigation;
  // Per spec: don't auto-pollute results menus with extra rows — those are
  // handled inside `result-menu.js` so the rows come out exactly as the spec
  // shows.
  if (menu.type === "results") return out;

  // Default for menus: include Back (if a previous menu is set), Home, List.
  let want_back = false, want_home = true, want_list = true;
  if (want === false) return out;
  if (want && typeof want === "object") {
    if (want.back === false) want_back = false;
    else if (want.back) want_back = true;
    if (want.home === false) want_home = false;
    if (want.list === false) want_list = false;
  } else if (menu.previousMenu) {
    want_back = true;
  }

  let cursor = lastDataIndex + 1;
  if (want_back) {
    out.items.push({
      index: cursor,
      label: "⬅️ Back",
      title: "Back",
      action: "menu:back",
    });
    out.indexes.back = cursor;
    cursor++;
  }
  if (want_home) {
    out.items.push({
      index: cursor,
      label: "🏠 Home",
      title: "Home",
      action: "menu:home",
    });
    out.indexes.home = cursor;
    cursor++;
  }
  if (want_list) {
    out.items.push({
      index: cursor,
      label: "📋 Menu List",
      title: "Menu List",
      action: "menu:list",
    });
    out.indexes.list = cursor;
    cursor++;
  }
  return out;
}

module.exports = {
  VALID_MODES,
  DEFAULT_MODE,
  cleanText,
  getButtonMode,
  setButtonMode,
  isButtonModeOn,
  sendMenu,
  sendButtonMenu,
  sendListMenu,
  sendClassicListMenu,
  sendTextMenu,
  extractMenuActionId,
  extractQuotedStanzaId,
  extractNativeFlowId,
};
