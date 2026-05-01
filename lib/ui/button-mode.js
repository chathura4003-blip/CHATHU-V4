"use strict";

/**
 * Button Mode — central UI sender.
 *
 * Final behavior (mirrors the wabase-button reference repo, which now works
 * out of the box because we run on `atexovi-baileys` — see package.json):
 *   on  — Advanced UI Engine.
 *         1-5 visible items: WhatsApp interactiveButtons quick_reply card.
 *         6+ visible items: WhatsApp interactiveButtons single_select list.
 *         If interactiveButtons throws: send advanced text fallback.
 *   off — Legacy text flow only.
 *
 * Numeric reply fallback is preserved via menuState.saveMenuState in every
 * branch so quoting any sent menu and replying with a number still works.
 */

const { logger } = require("../../logger");
const builder = require("./menu-builder");
const menuState = require("./menu-state");
const roleHelp = require("./role-menu");
const access = require("./access-control");

const VALID_MODES = ["on", "off"];
const DEFAULT_MODE = "on";
const QUICK_REPLY_LIMIT = 5;
const LIST_ROW_LIMIT = 10;

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
  } catch (_) {}

  try {
    const db = require("../db");
    if (db && typeof db.getSetting === "function") {
      const v = _normalizeMode(db.getSetting("buttonMode"));
      if (v) return v;
    }
  } catch (_) {}

  const env = _normalizeMode(process.env.BUTTON_MODE);
  if (env) return env;

  return DEFAULT_MODE;
}

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
// Action ID extraction
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

    return typeof id === "string" ? id : "";
  } catch (_) {
    return "";
  }
}

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
// Senders: wabase-button-style interactiveButtons
// ---------------------------------------------------------------------------

async function sendTextMenu(sock, jid, text, options = {}) {
  return await sock.sendMessage(jid, { text }, options);
}

async function sendButtonMenu(sock, jid, menu, items, options = {}) {
  const buttons = items.slice(0, QUICK_REPLY_LIMIT).map((item, index) => ({
    name: "quick_reply",
    buttonParamsJson: JSON.stringify({
      display_text: cleanText(
        item.shortLabel || item.label || item.title || `Option ${index + 1}`,
        20,
      ),
      id: String(item.action || item.id || `menu:item:${index}`).slice(0, 80),
    }),
  }));

  if (!buttons.length) throw new Error("no buttons to send");

  return await sock.sendMessage(jid, {
    text: menu.text || menu.body || "Choose an option from below",
    title: cleanText(menu.title || "CHATHU MD V4", 60),
    footer: cleanText(menu.footer || "CHATHU MD", 60),
    interactiveButtons: buttons,
  }, options);
}

async function sendListMenu(sock, jid, menu, items, options = {}) {
  if (!items?.length) throw new Error("no list rows to send");

  const rows = items.slice(0, LIST_ROW_LIMIT).map((item, index) => ({
    title: cleanText(item.title || item.label || `Option ${index + 1}`, 35),
    description: cleanText(item.description || item.subtitle || "", 60),
    id: String(item.action || item.id || `menu:item:${index}`).slice(0, 80),
  }));

  return await sock.sendMessage(jid, {
    text: menu.text || menu.body || "Choose an option from below",
    subtitle: menu.subtitle || "Choose an option",
    footer: cleanText(menu.footer || "CHATHU MD", 60),
    interactiveButtons: [
      {
        name: "single_select",
        buttonParamsJson: JSON.stringify({
          title: cleanText(menu.buttonText || "📋 Open Menu", 20),
          sections: [
            {
              title: cleanText(menu.sectionTitle || "Options", 24),
              rows,
            },
          ],
        }),
      },
    ],
  }, options);
}

// ---------------------------------------------------------------------------
// Central dispatch
// ---------------------------------------------------------------------------

async function sendMenu(sock, jid, menu, options = {}, context = {}) {
  if (!sock || !jid || !menu) return null;

  const role = roleHelp.getUserRole(context);

  const filtered = (Array.isArray(menu.items) ? menu.items : [])
    .filter((it) => access.canAccess(it, { ...context, chatJid: jid }).allowed);

  const items = filtered.map((it, i) => ({ ...it, index: i + 1 }));

  const nav = _resolveNavigation(menu, items.length);
  if (nav.items.length) items.push(...nav.items);

  const buttonMode = getButtonMode(context);
  const builtText = builder.buildMenuText(
    {
      ...menu,
      navigation: nav.indexes,
    },
    items,
    { ...context, role, buttonMode },
  );

  const renderedMenu = {
    ...menu,
    text: menu.text || menu.body || builtText,
    body: menu.body || builtText,
    footer: menu.footer || `${context.botName || "CHATHU MD"} • ${builder.MENU_MARKER}`,
    title: menu.title || menu.titleShort || "CHATHU MD V4",
    buttonText: menu.buttonText || "📋 Open Menu",
    sectionTitle: menu.sectionTitle || "Options",
  };

  const fallbackText = renderedMenu.text || builtText || "Please choose an option.";
  let sent = null;

  if (buttonMode === "off") {
    sent = await sendTextMenu(sock, jid, fallbackText, options);
  } else {
    try {
      logger(`[UI] buttonMode: ${buttonMode}`);
      logger(`[UI] menu id: ${menu.id}`);
      logger(`[UI] visible items: ${items.length}`);
      logger(`[UI] attempting: ${items.length <= QUICK_REPLY_LIMIT ? "quick_reply_buttons" : "single_select_list"}`);

      if (items.length <= QUICK_REPLY_LIMIT) {
        sent = await sendButtonMenu(sock, jid, renderedMenu, items, options);
      } else {
        sent = await sendListMenu(sock, jid, renderedMenu, items, options);
      }
    } catch (err) {
      logger(`[UI] interactiveButtons send failed: ${err?.message || err}`);
      logger(`[UI] interactiveButtons stack: ${err?.stack || ""}`);
      logger("[UI] fallback: advanced text");
      sent = await sendTextMenu(sock, jid, fallbackText, options);
    }
  }

  const messageId = sent?.key?.id || null;
  menuState.saveMenuState(messageId, {
    type: menu.type || "menu",
    menuId: menu.id,
    level: menu.level || "top",
    categoryId: menu.categoryId || null,
    chatJid: jid,
    userJid: context.sender || null,
    role,
    items,
    payload: menu.payload || {},
    page: menu.page || 1,
    totalPages: menu.totalPages || 1,
    previousMenu: menu.previousMenu || null,
  });

  return sent;
}

// ---------------------------------------------------------------------------
// Navigation helpers
// ---------------------------------------------------------------------------

function _resolveNavigation(menu, lastDataIndex) {
  const out = { items: [], indexes: {} };
  if (!menu) return out;

  const want = menu.navigation;
  if (menu.type === "results") return out;

  let wantBack = false;
  let wantHome = true;
  let wantList = true;

  if (want === false) return out;

  if (want && typeof want === "object") {
    if (want.back === false) wantBack = false;
    else if (want.back) wantBack = true;
    if (want.home === false) wantHome = false;
    if (want.list === false) wantList = false;
  } else if (menu.previousMenu) {
    wantBack = true;
  }

  let cursor = lastDataIndex + 1;

  if (wantBack) {
    out.items.push({ index: cursor, label: "⬅️ Back", title: "Back", action: "menu:back" });
    out.indexes.back = cursor;
    cursor++;
  }

  if (wantHome) {
    out.items.push({ index: cursor, label: "🏠 Home", title: "Home", action: "menu:home" });
    out.indexes.home = cursor;
    cursor++;
  }

  if (wantList) {
    out.items.push({ index: cursor, label: "📋 Menu List", title: "Menu List", action: "menu:list" });
    out.indexes.list = cursor;
  }

  return out;
}

module.exports = {
  VALID_MODES,
  DEFAULT_MODE,
  QUICK_REPLY_LIMIT,
  LIST_ROW_LIMIT,
  cleanText,
  getButtonMode,
  setButtonMode,
  isButtonModeOn,
  sendMenu,
  sendButtonMenu,
  sendListMenu,
  sendTextMenu,
  extractMenuActionId,
  extractQuotedStanzaId,
  extractNativeFlowId,
};
