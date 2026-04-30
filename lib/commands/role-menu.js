"use strict";

/**
 * Role-Aware Advanced Menu Command
 *
 * Always sends:
 *   1. A rich text fallback that renders on every WhatsApp client (also
 *      doubles as the quoted message for numeric-reply detection).
 *   2. A native-flow interactive message (buttons + single-select list)
 *      whose option IDs carry `rolemenu:cmd:<command>` so the handler can
 *      run the chosen command. If interactive sending fails (older client,
 *      proto incompatibility), the text menu is still usable.
 *
 * The original `.menu` command in `lib/commands/menu.js` is intentionally
 * left untouched so existing users keep their familiar experience. This new
 * command lives alongside it as `.menupro` (with several aliases).
 */

const { logger } = require("../../logger");
const { getPrefix, getBotName } = require("../runtime-settings");
const { sendReact } = require("../utils");
const roleMenu = require("../role-menu");

module.exports = {
  name: "menupro",
  aliases: ["rmenu", "advmenu", "fullmenu", "rolemenu", "promenu"],
  description: "Advanced role-aware menu (button + list + number reply)",
  category: "system",

  async execute(sock, msg, from, args, name, context = {}) {
    const sender = msg.key.participant || msg.key.remoteJid || from;
    const ownerRefs = context.owner ? [context.owner] : [];
    const prefix = context.prefix || getPrefix();
    const botName = context.botName || getBotName();

    await sendReact(sock, from, msg, "📜");

    const role = roleMenu.detectRole(sender, { ownerRefs });
    const items = roleMenu.buildItems(role);
    roleMenu.rememberNumericMapping(sender, role, items);

    const text = roleMenu.renderText({ role, prefix, botName, sender, ownerRefs, items });

    // Step 1: Always send the rich text menu first.
    let quotedRef = null;
    try {
      quotedRef = await sock.sendMessage(
        from,
        { text, mentions: [sender] },
        { quoted: msg }
      );
    } catch (err) {
      logger(`[RoleMenu] Failed to send text menu: ${err.message}`);
    }

    // Step 2: Best-effort attempt to send the interactive enhancement. This
    // is wrapped in try/catch so any rendering / proto issue can never break
    // the main menu flow.
    try {
      await sendInteractive({ sock, from, msg, role, prefix, botName, items, quotedRef });
    } catch (err) {
      logger(`[RoleMenu] Interactive send skipped: ${err.message}`);
    }

    await sendReact(sock, from, msg, "✅");
  },
};

async function sendInteractive({ sock, from, msg, role, prefix, botName, items, quotedRef }) {
  const baileys = require("@whiskeysockets/baileys");
  const generateWAMessageFromContent = baileys.generateWAMessageFromContent;
  if (typeof generateWAMessageFromContent !== "function") return;
  if (typeof sock?.relayMessage !== "function") return;

  const bodyText =
    `Choose an action below.\n\n` +
    `Role: ${roleMenu.roleLabel(role)}\n` +
    `Prefix: ${prefix}\n` +
    `Tip: you can also reply with the option number (e.g. 1).`;
  const footerText = `${botName} • ${roleMenu.MENU_MARKER}`;

  const interactiveContent = roleMenu.buildInteractiveContent({
    role, prefix, botName, items, bodyText, footerText,
  });

  const userJid = sock?.user?.id || undefined;
  const wam = generateWAMessageFromContent(
    from,
    { viewOnceMessage: { message: interactiveContent } },
    {
      userJid,
      // Quote the rich text menu we just sent so clients that DO render the
      // interactive payload also reference the same context.
      quoted: quotedRef || msg,
    }
  );

  await sock.relayMessage(from, wam.message, { messageId: wam.key.id });
}
