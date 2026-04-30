"use strict";

/**
 * .button — bot-wide Button Mode control.
 *
 * Usage:
 *   .button                  → show status
 *   .button status           → show status
 *   .button on               → buttons + list (auto-pick by item count)
 *   .button off              → text only (no buttons / no list, menu still active)
 *   .button auto             → smart: 1-3 buttons, 4+ list, fail → text
 *   .button button           → prefer buttons (1-3) / list (4+) / text fallback
 *   .button list             → always WhatsApp list message (text fallback)
 *   .button text             → numbered text only
 */

const { isOwner, sendReact } = require("../utils");
const msgMgr   = require("../message-manager");
const ui       = require("../ui");

const VALID = new Set(["on", "off", "auto", "button", "list", "text", "status"]);

function describeMode(mode) {
  switch (String(mode || "").toLowerCase()) {
    case "on":     return { ui: "Buttons + List", fallback: "Text", numbers: "Enabled" };
    case "off":    return { ui: "Disabled (text only)", fallback: "Text", numbers: "Enabled" };
    case "auto":   return { ui: "Smart (1-3 → buttons, 4+ → list)", fallback: "Text Menu", numbers: "Enabled" };
    case "button": return { ui: "Prefer Buttons", fallback: "List → Text", numbers: "Enabled" };
    case "list":   return { ui: "WhatsApp List", fallback: "Text", numbers: "Enabled" };
    case "text":   return { ui: "Text Only", fallback: "Text", numbers: "Enabled" };
    default:       return { ui: String(mode), fallback: "Text", numbers: "Enabled" };
  }
}

module.exports = {
  name: "button",
  aliases: ["btn", "buttonmode", "uimode"],
  description: "Toggle bot-wide Button Mode (on/off/auto/button/list/text/status)",
  category: "system",

  async execute(sock, msg, from, args, name, context = {}) {
    const sender = msg.key.participant || msg.key.remoteJid;
    const ownerRefs = context.owner ? [context.owner] : [];
    const isOwn = msg.key.fromMe || isOwner(sender, ownerRefs);

    const sub = (args[0] || "").toLowerCase().trim();
    const current = ui.getButtonMode(context);

    // Anyone can call `.button status`. Only owner can change.
    if (!sub || sub === "status") {
      const d = describeMode(current);
      const text = [
        "🔘 *Button Mode Status*",
        "",
        `*Current Mode:* ${current.toUpperCase()}`,
        `*Menu UI:*     ${d.ui}`,
        `*Fallback:*    ${d.fallback}`,
        `*Number Reply:* ${d.numbers}`,
        "",
        "Modes:",
        "• `on`     — buttons + list (auto pick)",
        "• `off`    — text only (menu still active)",
        "• `auto`   — smart: 1-3 buttons, 4+ list",
        "• `button` — prefer buttons / list",
        "• `list`   — always WhatsApp list",
        "• `text`   — numbered text only",
        "",
        `Set with: \`${context.prefix || "."}button <mode>\``,
      ].join("\n");
      await sock.sendMessage(from, { text }, { quoted: msg });
      return;
    }

    if (!VALID.has(sub) || sub === "status") {
      return msgMgr.sendTemp(
        sock,
        from,
        `⚠️ Unknown mode: *${sub}*. Use one of: on, off, auto, button, list, text, status.`,
        6000,
      );
    }

    if (!isOwn) {
      return msgMgr.sendTemp(sock, from, "🔒 Only the bot owner can change Button Mode.", 4000);
    }

    const ok = ui.setButtonMode(sub);
    if (!ok) {
      return msgMgr.sendTemp(sock, from, `❌ Failed to set Button Mode to *${sub}*.`, 4000);
    }
    await sendReact(sock, from, msg, "✅");
    const d = describeMode(sub);
    await sock.sendMessage(
      from,
      { text: `✨ Button Mode set to *${sub.toUpperCase()}*\n*UI:* ${d.ui}\n*Fallback:* ${d.fallback}` },
      { quoted: msg },
    );
  },
};
