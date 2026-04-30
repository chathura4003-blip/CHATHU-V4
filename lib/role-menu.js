"use strict";

/**
 * Role-Aware Advanced Menu System
 *
 * Provides:
 *   - Role detection: normal / premium / owner / premium-owner
 *   - Per-role menu definitions (sections + commands)
 *   - Rich text rendering (theme-aware, always-renderable fallback)
 *   - Interactive payloads: native-flow buttons + single-select list
 *   - Numeric-reply mapping cache so a plain "1", "2", … reply also works
 *
 * Activation IDs follow the pattern `rolemenu:cmd:<command>` so the handler
 * can detect them in `buttonsResponseMessage`, `templateButtonReplyMessage`,
 * `listResponseMessage`, and `interactiveResponseMessage` payloads.
 */

const { MemoryCache } = require("./memory-cache");

// Marker embedded in every rendered menu so quoted-text numeric replies can
// be unambiguously routed to this subsystem.
const MENU_MARKER = "ADVANCED MENU";

// Action ID prefix used by interactive component selections.
const ACTION_PREFIX = "rolemenu:";

// Cache: numeric-reply mappings, keyed by sender JID. Each entry contains the
// ordered list of items shown to that user along with the role used to build
// the menu. TTL ~ 10 minutes.
const numericCache = new MemoryCache(600000);

/**
 * Determine the role for a given sender.
 * Roles:
 *   - "owner"          : sender is an owner but NOT premium
 *   - "premium-owner"  : sender is an owner AND premium
 *   - "premium"        : sender is premium but NOT an owner
 *   - "normal"         : everyone else
 *
 * @param {string} sender JID of the message sender (e.g. "94...@s.whatsapp.net").
 * @param {Object} deps  Lazy-injected helpers (`isOwner`, `db`) so this module
 *                       can stay free of circular requires when imported by
 *                       the handler. Both default to the project's own
 *                       implementations when omitted.
 * @returns {"normal"|"premium"|"owner"|"premium-owner"}
 */
function detectRole(sender, { ownerRefs = [], isOwner, db } = {}) {
  if (!isOwner) isOwner = require("./utils").isOwner;
  if (!db) db = require("./db");

  const isOwnerUser = isOwner(sender, ownerRefs);
  const userData = db.getUser(sender) || {};
  const isPremium = Boolean(userData.premium);

  if (isOwnerUser && isPremium) return "premium-owner";
  if (isOwnerUser) return "owner";
  if (isPremium) return "premium";
  return "normal";
}

/**
 * Returns a human-readable role label used in headers / buttons.
 */
function roleLabel(role) {
  switch (role) {
    case "premium-owner": return "𝙿𝚁𝙴𝙼𝙸𝚄𝙼 𝙾𝚆𝙽𝙴𝚁";
    case "owner":         return "𝙾𝚆𝙽𝙴𝚁";
    case "premium":       return "𝙿𝚁𝙴𝙼𝙸𝚄𝙼";
    default:              return "𝙼𝙴𝙼𝙱𝙴𝚁";
  }
}

/**
 * Section definitions. Every section lists the commands relevant to it and
 * the minimum role required to see the section. Each command entry is the
 * canonical command name (without prefix). Aliases are preserved by keeping
 * the names identical to those registered in `lib/commands/*.js`.
 *
 * The `roles` array of each section enumerates which roles may see it.
 */
const SECTIONS = [
  {
    id: "downloads",
    title: "📥 Downloads",
    icon: "📥",
    roles: ["normal", "premium", "owner", "premium-owner"],
    commands: [
      { cmd: "yt",    desc: "YouTube video" },
      { cmd: "song",  desc: "Music search & download" },
      { cmd: "play",  desc: "Quick play (with quality menu)" },
      { cmd: "tt",    desc: "TikTok video" },
      { cmd: "ig",    desc: "Instagram media" },
      { cmd: "fb",    desc: "Facebook video" },
    ],
  },
  {
    id: "search",
    title: "🔍 Search & Info",
    icon: "🔍",
    roles: ["normal", "premium", "owner", "premium-owner"],
    commands: [
      { cmd: "yts",     desc: "YouTube search" },
      { cmd: "google",  desc: "Google search" },
      { cmd: "wiki",    desc: "Wikipedia summary" },
      { cmd: "weather", desc: "Weather forecast" },
      { cmd: "lyrics",  desc: "Song lyrics" },
    ],
  },
  {
    id: "fun",
    title: "🎈 Fun & Games",
    icon: "🎈",
    roles: ["normal", "premium", "owner", "premium-owner"],
    commands: [
      { cmd: "joke",     desc: "Random joke" },
      { cmd: "meme",     desc: "Random meme" },
      { cmd: "fact",     desc: "Random fact" },
      { cmd: "8ball",    desc: "Magic 8-ball" },
      { cmd: "ship",     desc: "Ship two users" },
      { cmd: "lovecalc", desc: "Love calculator" },
    ],
  },
  {
    id: "profile",
    title: "👤 Profile & User",
    icon: "👤",
    roles: ["normal", "premium", "owner", "premium-owner"],
    commands: [
      { cmd: "profile", desc: "Show your profile" },
      { cmd: "pp",      desc: "Profile picture" },
      { cmd: "myinfo",  desc: "Account info" },
      { cmd: "sticker", desc: "Image → sticker" },
    ],
  },
  {
    id: "system",
    title: "⚙️ System",
    icon: "⚙️",
    roles: ["normal", "premium", "owner", "premium-owner"],
    commands: [
      { cmd: "ping",  desc: "Bot latency" },
      { cmd: "alive", desc: "Bot status card" },
      { cmd: "menu",  desc: "Classic full menu" },
    ],
  },
  {
    id: "ai",
    title: "🤖 AI Center",
    icon: "🤖",
    roles: ["premium", "premium-owner", "owner"],
    commands: [
      { cmd: "ai",        desc: "Ask the AI" },
      { cmd: "chat",      desc: "Conversational chat" },
      { cmd: "tts",       desc: "Text-to-speech" },
      { cmd: "translate", desc: "Translate text" },
      { cmd: "img",       desc: "AI image generation" },
    ],
  },
  {
    id: "premium",
    title: "💎 Premium Tools",
    icon: "💎",
    roles: ["premium", "premium-owner"],
    commands: [
      { cmd: "viewonce", desc: "View-once gallery" },
      { cmd: "antivo",   desc: "Anti-view-once toggle" },
      { cmd: "daily",    desc: "Daily reward" },
      { cmd: "shop",     desc: "Premium shop" },
    ],
  },
  {
    id: "group",
    title: "🛡️ Group Admin",
    icon: "🛡️",
    roles: ["owner", "premium-owner"],
    commands: [
      { cmd: "kick",     desc: "Kick member" },
      { cmd: "promote",  desc: "Promote to admin" },
      { cmd: "demote",   desc: "Demote from admin" },
      { cmd: "antilink", desc: "Anti-link toggle" },
      { cmd: "welcome",  desc: "Welcome message" },
    ],
  },
  {
    id: "owner",
    title: "👑 Owner Panel",
    icon: "👑",
    roles: ["owner", "premium-owner"],
    commands: [
      { cmd: "broadcast", desc: "Broadcast message" },
      { cmd: "ban",       desc: "Ban a user" },
      { cmd: "unban",     desc: "Unban a user" },
      { cmd: "addowner",  desc: "Add an owner" },
      { cmd: "listowner", desc: "List owners" },
      { cmd: "settings",  desc: "Bot settings" },
      { cmd: "reload",    desc: "Reload commands" },
    ],
  },
];

/**
 * Returns the sections visible to a given role.
 */
function sectionsForRole(role) {
  return SECTIONS.filter((s) => s.roles.includes(role));
}

/**
 * Build the ordered, numbered list of selectable items for a role.
 * Each item links a numeric index (1-based) to a command name, and carries a
 * label suitable for buttons / list rows / numeric mapping.
 */
function buildItems(role) {
  const items = [];
  for (const section of sectionsForRole(role)) {
    for (const c of section.commands) {
      items.push({
        index: items.length + 1,
        sectionId: section.id,
        sectionTitle: section.title,
        cmd: c.cmd,
        desc: c.desc,
      });
    }
  }
  return items;
}

/**
 * Render the rich text version of the menu. This always renders on every
 * client and acts as the fallback when interactive components are not
 * supported.
 *
 * @param {Object} opts
 * @param {string} opts.role
 * @param {string} opts.prefix
 * @param {string} opts.botName
 * @param {string} opts.sender
 * @param {Array}  opts.ownerRefs
 * @param {Array}  opts.items     output of `buildItems`
 * @returns {string}
 */
function renderText({ role, prefix, botName, sender, ownerRefs, items }) {
  const themeMgr = require("./theme-manager");
  const tCtx = { sender, ownerRefs };
  const label = roleLabel(role);

  let out = themeMgr.format("header", { title: `${botName.toUpperCase()} • ${MENU_MARKER}` }, tCtx);
  out += "\n";
  out += themeMgr.format("section", { title: "ᴘʀᴏғɪʟᴇ" }, tCtx);
  out += themeMgr.format("item", { bullet: "user",    content: `ᴜsᴇʀ : @${String(sender).split("@")[0]}` }, tCtx);
  out += themeMgr.format("item", { bullet: "default", content: `ʀᴏʟᴇ : ${label}` }, tCtx);
  out += themeMgr.format("item", { bullet: "default", content: `ᴘʀᴇғɪx : 「 ${prefix} 」` }, tCtx);
  out += themeMgr.format("footer", {}, tCtx);
  out += "\n";

  let i = 0;
  for (const section of sectionsForRole(role)) {
    out += themeMgr.format("box_start", { title: section.title }, tCtx);
    for (const c of section.commands) {
      i += 1;
      out += themeMgr.format("box_item", {
        bullet: "default",
        content: `${pad2(i)}. ${prefix}${c.cmd}  —  ${c.desc}`,
      }, tCtx);
    }
    out += themeMgr.format("box_end", {}, tCtx);
    out += "\n";
  }

  out += themeMgr.format("box_start", { title: "💡 ʜᴏᴡ ᴛᴏ ᴜsᴇ" }, tCtx);
  out += themeMgr.format("box_item", { bullet: "default", content: "• Tap any button below" }, tCtx);
  out += themeMgr.format("box_item", { bullet: "default", content: "• Or open the list and pick a row" }, tCtx);
  out += themeMgr.format("box_item", { bullet: "default", content: `• Or reply with the number (e.g. *1*) to run the command` }, tCtx);
  out += themeMgr.format("box_end", {}, tCtx);
  out += themeMgr.getSignature(sender, ownerRefs);

  // Hidden marker tag duplicated at the very end so quoted-reply detection
  // never misses it even if the visible header gets trimmed by clients.
  if (!out.includes(MENU_MARKER)) out += `\n${MENU_MARKER}`;
  // Avoid bot-loop suppression: the handler drops messages containing zero
  // width spaces from *other* devices, but our outbound text is unaffected.
  return out;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

/**
 * Cache the numeric mapping for a sender so plain "1", "2", … replies can be
 * resolved to the right command later.
 */
function rememberNumericMapping(sender, role, items) {
  if (!sender) return;
  numericCache.set(sender, { role, items, ts: Date.now() }, 600000);
}

/**
 * Resolve a numeric reply for a sender to a command, if any.
 */
function resolveNumeric(sender, num) {
  if (!sender || !Number.isFinite(num)) return null;
  const entry = numericCache.get(sender);
  if (!entry) return null;
  const item = entry.items.find((it) => it.index === num);
  return item || null;
}

/**
 * Resolve an interactive component selection. Accepts the raw inbound message
 * proto and returns the matched item if one of the supported response types
 * carries our `rolemenu:cmd:*` action ID.
 */
function resolveInteractiveSelection(msg) {
  if (!msg || !msg.message) return null;
  const ids = collectSelectionIds(msg.message);
  for (const id of ids) {
    if (typeof id !== "string") continue;
    if (!id.startsWith(ACTION_PREFIX)) continue;
    // Format: rolemenu:cmd:<command>
    const parts = id.slice(ACTION_PREFIX.length).split(":");
    if (parts[0] !== "cmd" || !parts[1]) continue;
    return { cmd: parts[1], rawId: id };
  }
  return null;
}

function collectSelectionIds(message) {
  const out = [];
  const list = message.listResponseMessage?.singleSelectReply?.selectedRowId;
  if (list) out.push(list);

  const btn = message.buttonsResponseMessage?.selectedButtonId;
  if (btn) out.push(btn);

  const tpl = message.templateButtonReplyMessage?.selectedId;
  if (tpl) out.push(tpl);

  // Native flow / interactive responses (modern WA clients).
  const nfm = message.interactiveResponseMessage?.nativeFlowResponseMessage;
  if (nfm?.paramsJson) {
    try {
      const parsed = JSON.parse(nfm.paramsJson);
      if (parsed?.id) out.push(parsed.id);
    } catch (_) { /* ignore malformed params */ }
  }
  return out;
}

/**
 * Build the native-flow `interactiveMessage` content for a role.
 * This produces a body+footer with up to 3 quick-action buttons and a
 * single-select list ("Open Menu") whose rows enumerate every available
 * command for the role.
 *
 * Returns an object suitable for `generateWAMessageFromContent`.
 */
function buildInteractiveContent({ role, prefix, botName, items, bodyText, footerText }) {
  const { proto } = require("@whiskeysockets/baileys");

  // Group items by section to produce list sections.
  const sections = [];
  const grouped = new Map();
  for (const it of items) {
    if (!grouped.has(it.sectionId)) {
      grouped.set(it.sectionId, { title: it.sectionTitle, rows: [] });
    }
    grouped.get(it.sectionId).rows.push({
      header: "",
      title: `${pad2(it.index)}. ${prefix}${it.cmd}`,
      description: it.desc,
      id: `${ACTION_PREFIX}cmd:${it.cmd}`,
    });
  }
  for (const sec of grouped.values()) sections.push(sec);

  // Prefer the most "premium" entries as quick buttons.
  const quickPicks = pickQuickButtons(items, role).map((it) => ({
    name: "quick_reply",
    buttonParamsJson: JSON.stringify({
      display_text: `${pad2(it.index)}. ${it.cmd}`,
      id: `${ACTION_PREFIX}cmd:${it.cmd}`,
    }),
  }));

  const listButton = {
    name: "single_select",
    buttonParamsJson: JSON.stringify({
      title: "📋 Open Full Menu",
      sections,
    }),
  };

  const interactive = proto.Message.InteractiveMessage.fromObject({
    body:   { text: bodyText },
    footer: { text: footerText },
    header: {
      title: `${botName} • ${roleLabel(role)}`,
      subtitle: "Pick an action",
      hasMediaAttachment: false,
    },
    nativeFlowMessage: {
      buttons: [listButton, ...quickPicks],
      messageParamsJson: "",
    },
  });

  return { interactiveMessage: interactive };
}

function pickQuickButtons(items, role) {
  // Surface the first 3 items from the highest-tier sections available to
  // this role so quick buttons feel relevant.
  const priorityBySection = {
    "premium-owner": ["owner", "ai", "premium", "downloads"],
    "owner":         ["owner", "downloads", "system"],
    "premium":       ["ai", "premium", "downloads"],
    "normal":        ["downloads", "search", "system"],
  };
  const order = priorityBySection[role] || priorityBySection.normal;
  const out = [];
  for (const sid of order) {
    for (const it of items) {
      if (it.sectionId === sid && !out.find((x) => x.cmd === it.cmd)) {
        out.push(it);
        if (out.length >= 3) return out;
      }
    }
  }
  // Fallback: just take the first three items.
  for (const it of items) {
    if (!out.find((x) => x.cmd === it.cmd)) {
      out.push(it);
      if (out.length >= 3) return out;
    }
  }
  return out;
}

module.exports = {
  MENU_MARKER,
  ACTION_PREFIX,
  detectRole,
  roleLabel,
  sectionsForRole,
  buildItems,
  renderText,
  rememberNumericMapping,
  resolveNumeric,
  resolveInteractiveSelection,
  buildInteractiveContent,
};
