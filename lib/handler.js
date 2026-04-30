"use strict";

const fs = require("fs");
const path = require("path");
const { logger } = require("../logger");
const { MemoryCache } = require("./memory-cache");
const { handleAPIError, safeExecute } = require("./error-handler");
const { getMetadata, downloadAndSend } = require("./download-manager");
const msgMgr = require("./message-manager");
const { sendReact, presenceUpdate, truncate, isOwner, withOwnerContext, downloadMediaMessage } = require("./utils");
const { WORK_MODE } = require("../config");
const { getPrefix } = require("./runtime-settings");
const db = require("./db");
const themeMgr = require("./theme-manager");
const roleMenu = require("./role-menu");

/**
 * CHATHU MD - Advanced Message Handler
 * Optimized for Premium Performance & Theme-Aware UI
 */

const chatHistory = new Map();
const aiRateLimits = new Map();

// --- AI Auto-Reply: per-sender burst-shield & light-react cooldown ----------
// Burst-shield buckets messages from a single sender within a short window so
// repeated rapid-fire messages produce one combined reply instead of N replies.
const aiBurstBuckets = new Map();   // key = historyKey, value = { ts: number, count: number }
const aiLightReactCooldown = new Map(); // key = sender, value = expiry ms

/**
 * Build a history key. For private chats this is the chat JID; for groups it
 * combines chat + sender so each user gets their own running context window.
 */
function historyKeyFor(from, sender) {
    return from.endsWith('@g.us') ? `${from}::${sender}` : from;
}

function updateHistory(jid, role, content, depth = 6) {
    const history = chatHistory.get(jid) || [];
    history.push({ role, content });
    const cap = Math.max(2, Math.min(depth * 2, 40));
    while (history.length > cap) history.shift();
    chatHistory.set(jid, history);
}

/**
 * Strip simple prompt-injection patterns from user input before passing to AI.
 * Not bullet-proof, but deters trivial "ignore previous instructions" attacks.
 */
function sanitizeAiUserInput(text) {
    if (!text) return text;
    let s = String(text);
    s = s.replace(/(?:^|\n)\s*(?:system|assistant)\s*:\s*/gi, '\n');
    s = s.replace(/ignore\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions?|prompts?|rules?)/gi, '[filtered]');
    s = s.replace(/disregard\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions?|prompts?|rules?)/gi, '[filtered]');
    s = s.replace(/you\s+are\s+now\s+a\s+/gi, '[filtered] ');
    return s.slice(0, 800);
}

/**
 * Adaptive reply length cap based on user-message length. Short questions get
 * short replies; longer messages may unlock more words (up to userMax).
 */
function adaptiveMaxWords(userText, userMax) {
    const len = (userText || '').trim().length;
    if (len < 12) return Math.min(userMax, 12);
    if (len < 40) return Math.min(userMax, 22);
    if (len < 120) return Math.min(userMax, 40);
    return userMax;
}

// Escape regex metacharacters so user-configurable wake words can't crash the
// RegExp constructor (e.g. a wake word like "c++" would otherwise throw).
function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Match incoming text against bot name + configured wake words. Returns true
 * if this looks like the user is addressing the bot.
 */
function matchesWakeTrigger(cleanText, botName, botNumber, wakeWords) {
    if (!cleanText) return false;
    if (botNumber && cleanText.includes(`@${botNumber}`)) return true;
    const botNameLower = (botName || '').toLowerCase().trim();
    if (botNameLower && cleanText.includes(botNameLower)) return true;
    const firstWord = botNameLower.split(/\s+/)[0];
    if (firstWord && firstWord.length > 2 && new RegExp(`\\b${escapeRegex(firstWord)}\\b`).test(cleanText)) return true;
    for (const w of (wakeWords || [])) {
        const wl = String(w || '').toLowerCase().trim();
        if (!wl) continue;
        if (wl.length <= 3) {
            if (new RegExp(`(?:^|[^a-z0-9])${escapeRegex(wl)}(?:$|[^a-z0-9])`, 'i').test(cleanText)) return true;
        } else if (cleanText.includes(wl)) {
            return true;
        }
    }
    return false;
}

const commands = new Map();
const searchResults = new MemoryCache(600000);
const lastSearch = new MemoryCache(600000);
const qualitySelection = new MemoryCache(300000);
const playSelection = new MemoryCache(300000);
const aiAutoBackoffUntil = new Map();

/**
 * Dynamically load all command modules
 */
function loadCommands() {
  const dir = path.join(__dirname, "commands");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".js"));
  for (const file of files) {
    try {
      const cmdPath = path.join(dir, file);
      delete require.cache[require.resolve(cmdPath)];
      const cmdModule = require(cmdPath);
      const cmds = Array.isArray(cmdModule) ? cmdModule : [cmdModule];
      
      for (const cmd of cmds) {
        if (!cmd.name || typeof cmd.execute !== "function") continue;
        commands.set(cmd.name, cmd);
        (cmd.aliases || []).forEach((a) => commands.set(a, cmd));
      }
    } catch (err) {
      logger(`[Handler] Failed to load ${file}: ${err.message}`);
    }
  }
  logger(`[Handler] Successfully initialized ${commands.size} command hooks.`);
}

/**
 * Cache search results for reply-based downloading
 */
function storeSearchResults(msgId, sender, results) {
  if (!msgId || !sender || !Array.isArray(results)) return;
  searchResults.set(`${sender}:${msgId}`, { results, sender }, 600000);
  lastSearch.set(sender, { results, msgId }, 600000);
}

/**
 * Visual Quality Menu for Media Downloads
 */
async function showQualityMenu(sock, from, meta, sender, ownerRefs = []) {
  if (!sock || !from || !meta) return;

  qualitySelection.set(sender, { meta }, 300000);
  const tCtx = { sender, ownerRefs };
  const sizeStr = meta.filesize ? `${(meta.filesize / (1024 * 1024)).toFixed(1)} MB` : "N/A";

  let menuText = themeMgr.format("header", { title: themeMgr.getKeyword("video_ready") }, tCtx);
  menuText += "\n";
  menuText += themeMgr.format("section", { title: "ᴘʀᴏғɪʟᴇ" }, tCtx);
  menuText += themeMgr.format("item", { bullet: "user", content: `ᴜsᴇʀ : @${sender.split('@')[0]}` }, tCtx);
  menuText += themeMgr.format("footer", {}, tCtx);
  menuText += "\n";
  menuText += themeMgr.format("box_start", { title: "ᴍᴇᴅɪᴀ ᴅᴇᴛᴀɪʟs" }, tCtx);
  menuText += themeMgr.format("box_item", { bullet: "default", content: `Title    : ${truncate(meta.title, 45)}` }, tCtx);
  menuText += themeMgr.format("box_item", { bullet: "default", content: `Duration : ${meta.duration || "?"}` }, tCtx);
  menuText += themeMgr.format("box_item", { bullet: "default", content: `Size     : ${sizeStr}` }, tCtx);
  menuText += themeMgr.format("box_end", {}, tCtx);
  menuText += "\n";
  menuText += themeMgr.format("box_start", { title: "ᴅᴏᴡɴʟᴏᴀᴅ ᴏᴘᴛɪᴏɴs" }, tCtx);
  menuText += themeMgr.format("box_item", { bullet: "default", content: "1️⃣ Reply *1* for HD Video" }, tCtx);
  menuText += themeMgr.format("box_item", { bullet: "default", content: "2️⃣ Reply *2* for SD Video" }, tCtx);
  menuText += themeMgr.format("box_item", { bullet: "default", content: "3️⃣ Reply *3* for Audio Only" }, tCtx);
  menuText += themeMgr.format("box_item", { bullet: "default", content: "4️⃣ Reply *4* for Document" }, tCtx);
  menuText += themeMgr.format("box_end", {}, tCtx);
  menuText += themeMgr.getSignature(sender, ownerRefs);

  const content = meta.thumbnail 
    ? { image: { url: meta.thumbnail }, caption: menuText } 
    : { text: menuText };

  await sock.sendMessage(from, { ...content, mentions: [sender] }, { quoted: meta.msg || null });
}

function storePlaySelection(sender, video) {
  if (sender && video) playSelection.set(sender, { video }, 300000);
}

/**
 * Primary Message Processor
 */
async function handleCommand(sock, msg, from, text, disabledModules = [], context = {}) {
  if (!msg?.key || !from || from === "status@broadcast") return false;

  try {
    const ownerRefs = context.owner ? [context.owner] : [];
    let sender = msg.key.participant || msg.key.remoteJid;
    if (sender?.includes(":")) sender = sender.split(":")[0] + "@s.whatsapp.net";

    const cmdText = (msg.message?.conversation || 
                    msg.message?.extendedTextMessage?.text || 
                    msg.message?.imageMessage?.caption || 
                    msg.message?.videoMessage?.caption || "").trim();

    // --- Early Role-Menu Interactive Dispatch ---
    // Buttons / list / native-flow responses can arrive with no plain text
    // body (only the proto-level selection ids), so we must intercept these
    // *before* the empty-cmdText guard below. Numeric replies and prefixed
    // commands continue to flow through the normal pipeline below.
    {
      const earlySel = roleMenu.resolveInteractiveSelection(msg);
      if (earlySel) {
        if (!global.processedMsgIds) global.processedMsgIds = new Set();
        if (msg.key?.id && !global.processedMsgIds.has(msg.key.id)) {
          global.processedMsgIds.add(msg.key.id);
          setTimeout(() => global.processedMsgIds.delete(msg.key.id), 30000);
        }
        return await dispatchRoleMenuCommand(sock, msg, from, sender, earlySel.cmd, context, ownerRefs);
      }
    }

    if (!cmdText) return false;
    // The owner can run commands from the linked WhatsApp device — bot.js
    // already filters self-messages to commands / numeric replies before
    // calling us, so we only reject fromMe messages that *aren't* commands.
    const earlyPrefix = (context.prefix || getPrefix());
    const isNumericReply = /^\d+$/.test(cmdText);
    if (msg.key.fromMe && !cmdText.startsWith(earlyPrefix) && !isNumericReply) return false;

    // --- Deduplication Cache ---
    if (!global.processedMsgIds) global.processedMsgIds = new Set();
    const msgId = msg.key.id;
    if (global.processedMsgIds.has(msgId)) return false;
    global.processedMsgIds.add(msgId);
    setTimeout(() => global.processedMsgIds.delete(msgId), 30000);

    // --- ANTI-BOT-LOOP: Watermark, Signature & Self-Reply ---
    // Only apply the signature heuristic to messages from *other* devices —
    // a fromMe message that already passed the prefix/numeric gate above is
    // an explicit owner command from the linked phone and should never be
    // dropped just because the body happens to mention "chathu md".
    const botSignatures = ["chathu md", "generated by", "auto reply", "power by"];
    const hasSignature = !msg.key.fromMe && botSignatures.some(sig => cmdText.toLowerCase().includes(sig));
    // ZWSP / ZWNJ are commonly inserted by Sinhala keyboards during normal text
    // input, so we only treat them as "this is the bot echoing itself" when the
    // message did NOT originate from one of our linked devices.
    const hasZeroWidth = !msg.key.fromMe && (cmdText.includes("\u200B") || cmdText.includes("\u200C"));
    if (hasZeroWidth || hasSignature) return false;

    logger(`[Incoming] from: ${from}, sender: ${sender.split('@')[0]}, text: "${truncate(cmdText, 50)}"`);

    const lower = cmdText.trim().toLowerCase();
    const botNumber = sock.user?.id?.split(':')[0];
    const botName = context.botName || db.getSetting("botName") || db.getSetting("bot_name") || "CHATHU MD";
    const isGroup = from.endsWith("@g.us");

    // --- Interactive Component Handlers ---
    // (Role-menu interactive selections are dispatched earlier — see the
    //  "Early Role-Menu Interactive Dispatch" block above.)
    const rowId = msg.message?.listResponseMessage?.singleSelectReply?.selectedRowId;
    if (rowId?.startsWith("pick:")) {
      const idx = parseInt(rowId.split(":")[1]);
      const entry = lastSearch.get(sender);
      if (entry?.results?.[idx]) {
        const meta = await safeExecute(() => getMetadata(entry.results[idx].url), "GetMeta");
        await showQualityMenu(sock, from, meta || entry.results[idx], sender, ownerRefs);
        return true;
      }
    }

    // --- Numeric Reply Handler (Quality/Search/Settings) ---
    if (/^\d+$/.test(lower)) {
      const num = parseInt(lower);
      const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
      const quotedText = quotedMsg?.conversation || quotedMsg?.extendedTextMessage?.text || quotedMsg?.imageMessage?.caption || "";

      // Role-menu numeric reply: works whenever the user quoted our advanced
      // menu (identified by MENU_MARKER) and we still have a cached mapping
      // for this sender. This runs ahead of the legacy gate so it can never
      // be misrouted to quality/search numeric handlers.
      if (quotedText.includes(roleMenu.MENU_MARKER)) {
        const rmItem = roleMenu.resolveNumeric(sender, num);
        if (rmItem) {
          return await dispatchRoleMenuCommand(sock, msg, from, sender, rmItem.cmd, context, ownerRefs);
        }
      }

      if (quotedText.includes('Reply') || quotedText.includes('PRO PANEL') || quotedText.includes('AI CENTER') || quotedText.includes(roleMenu.MENU_MARKER)) {
        // 1. Video Quality Selection
        const videoKW = themeMgr.getAllKeywords("video_ready");
        if (videoKW.some(kw => quotedText.includes(kw))) {
          const qEntry = qualitySelection.get(sender);
          if (qEntry && num >= 1 && num <= 4) {
            sendReact(sock, from, msg, "⏳");
            const quality = num === 1 ? "hd" : "sd";
            const isAudio = num === 3;
            const isDoc = num === 4;
            await downloadAndSend(sock, from, qEntry.meta.url, "Media", quality, isAudio, false, isDoc);
            await sendReact(sock, from, msg, "✅");
            qualitySelection.delete(sender);
            return true;
          }
        }

        // 2. Play Selection
        const musicKW = themeMgr.getAllKeywords("music_player");
        if (musicKW.some(kw => quotedText.includes(kw))) {
          const pEntry = playSelection.get(sender);
          if (pEntry && num >= 1 && num <= 4) {
            sendReact(sock, from, msg, "⏳");
            await downloadAndSend(sock, from, pEntry.video.url, "YouTube", "sd", num !== 4, num === 2, num === 3);
            await sendReact(sock, from, msg, "✅");
            playSelection.delete(sender);
            return true;
          }
        }

        // 3. Search Result Selection
        const actionKW = themeMgr.getAllKeywords("action");
        if (actionKW.some(kw => quotedText.includes(kw))) {
          const entry = lastSearch.get(sender);
          if (entry && num >= 1 && num <= entry.results.length) {
            sendReact(sock, from, msg, "🎬");
            const meta = await safeExecute(() => getMetadata(entry.results[num - 1].url), "GetMeta");
            await showQualityMenu(sock, from, meta || entry.results[num - 1], sender, ownerRefs);
            return true;
          }
        }

        // 4. Settings Numeric Control
        const quotedId = msg.message?.extendedTextMessage?.contextInfo?.stanzaId;
        const hasSettingsHint = quotedText.includes("PRO PANEL") || quotedText.includes("AI CENTER") || quotedText.includes("CONFIGURATION");
        
        if (quotedId && (global.settingsCache?.has(quotedId) || hasSettingsHint)) {
          const settingsManager = require('./commands/settings-manager');
          const handler = settingsManager.find(c => c.name === 'handle_numeric_setting');
          if (handler) {
            const res = await handler.execute(sock, msg, from, num, quotedId, context);
            if (res) return true;
          }
        }
      }
    }

    // --- Work Mode & Permissions ---
    const workMode = context.workMode || db.getSetting("work_mode") || WORK_MODE;
    const isOwnerUser = isOwner(sender, ownerRefs);
    context.isOwner = isOwnerUser;

    const prefix = context.prefix || getPrefix();
    if (!cmdText.startsWith(prefix)) {
      // --- AI Auto Reply Logic ---
      const appState = require("../state");
      const botNumber = context.botNumber || appState.getNumber() || sock.user?.id?.split(':')[0];

      const groupData = from.endsWith("@g.us") ? db.getGroup(from) : null;
      const isAiAuto = (context.aiAutoReply !== undefined ? context.aiAutoReply : appState.getAiAutoReply()) && (!groupData || groupData.ai_auto !== false) && !disabledModules.includes('ai');
      const isStdAuto = (context.autoReply !== undefined ? context.autoReply : appState.getAutoReply()) && (!groupData || groupData.auto_reply !== false) && !disabledModules.includes('automation');

      if (isAiAuto || isStdAuto) {
        const now = Date.now();
        const histKey = historyKeyFor(from, sender);
        const lastReplyTime = aiRateLimits.get(sender + ":last") || 0;
        const cooldown = isGroup ? 3000 : 8000;
        
        if (now - lastReplyTime < cooldown && !isOwnerUser) {
           return false;
        }

        const cleanText = cmdText.toLowerCase();
        const wakeWords = appState.getAiAutoWakeWords ? appState.getAiAutoWakeWords() : [];
        const isMentioned = matchesWakeTrigger(cleanText, botName, botNumber, wakeWords);
        const isReplyToMe = msg.message?.extendedTextMessage?.contextInfo?.participant?.startsWith(botNumber);
        const aiGroupMode = context.aiGroupMode || appState.getAiGroupMode() || 'mention';

        if (isGroup && aiGroupMode === 'silent') {
            return false;
        }
        if (isGroup && aiGroupMode === 'mention' && !isMentioned && !isReplyToMe) {
            return false;
        }


        // mentionReply (canned reply when the bot is mentioned) is sent
        // upstream in bot.js before this handler runs and `continue`s the
        // message loop, so we don't short-circuit AI here on mention. If
        // bot.js's mention detection happens to miss something handler.js
        // catches, falling through to AI auto-reply is still a useful
        // response rather than silent suppression.
        if (!isAiAuto) return false;

        const aiCmd = commands.get("ai");
        logger(`[AI-Auto] Checking trigger for ${sender}. AI Status: ${isAiAuto}, Group Mode: ${aiGroupMode}, Mentioned: ${isMentioned}`);


        if (aiCmd && typeof aiCmd.generateAIResponse === "function") {
          // --- Burst-spam shield: bucket rapid-fire messages from one sender.
          // If this sender already has an in-flight or very-recent message
          // (within 4s) we skip processing for this message and let the
          // earlier reply represent the burst.
          const burstShieldOn = appState.getAiAutoBurstShield ? appState.getAiAutoBurstShield() : true;
          if (burstShieldOn && !isOwnerUser) {
            const bucket = aiBurstBuckets.get(histKey);
            if (bucket && now - bucket.ts < 4000) {
              bucket.count = (bucket.count || 1) + 1;
              bucket.ts = now;
              aiBurstBuckets.set(histKey, bucket);
              logger(`[AI-Auto] Burst shield collapsed message #${bucket.count} for ${sender.split('@')[0]}`);
              return false;
            }
            aiBurstBuckets.set(histKey, { ts: now, count: 1 });
          }

          (async () => {
            try {
              const now = Date.now();
              const backoffUntil = aiAutoBackoffUntil.get(from) || 0;
              if (backoffUntil > now) {
                // Don't leak the burst-shield bucket — otherwise this sender's
                // next message within 4s would be silently eaten instead of
                // hitting the rate-limit / backoff check on its own.
                aiBurstBuckets.delete(histKey);
                return;
              }

              // Rate Limit Check (Max 5 msgs per minute) - Exempt Owner & Premium
              const isPrem = db.getUser(sender)?.premium === true;
              if (!isOwnerUser && !isPrem) {
                const userLimit = aiRateLimits.get(sender) || [];
                const validLimits = userLimit.filter(t => now - t < 60000);
                
                if (validLimits.length >= 5) {
                  aiBurstBuckets.delete(histKey);
                  return logger(`[AI-Limit] Rate limit hit for ${sender.split('@')[0]}`);
                }
                validLimits.push(now);
                aiRateLimits.set(sender, validLimits);
              }

              // --- Light auto-react: subtle "I saw you" reaction. Disabled by
              // config or for owner/self. Cools down per-sender so it stays
              // human-looking rather than feeling automated.
              const lightReactOn = appState.getAiAutoLightReact ? appState.getAiAutoLightReact() : true;
              if (lightReactOn && !isOwnerUser) {
                const cdUntil = aiLightReactCooldown.get(sender) || 0;
                if (now > cdUntil && Math.random() < 0.18) {
                  aiLightReactCooldown.set(sender, now + 90_000);
                  const lightEmojis = ['👀', '🤔', '😄', '✨', '👌', '🙌'];
                  const e = lightEmojis[Math.floor(Math.random() * lightEmojis.length)];
                  sendReact(sock, from, msg, e).catch(() => {});
                }
              }

              // --- Quick Reply Mapping (Humanized) ---
              const qText = cmdText.toLowerCase().trim();
              let quickReply = null;
              if (/^(kewada|kewda|kewd|kෑවද|කෑවද)\??$/i.test(qText)) quickReply = Math.random() > 0.5 ? "Ow, kawa 😄" : "Thama na bn";
              else if (/^(kohomada|kohomd|කොහොමද)\??$/i.test(qText)) quickReply = "Hondai 😄 thopita kohomada?";
              else if (/^(mokada karanne|mokad krnne|mokad krne|මොකද කරන්නේ)\??$/i.test(qText)) quickReply = "Nikn innawa, oyata?";
              else if (/^(hi|hii+|hello|hey|aaa+|ow|owww+)\b\.?\!?$/i.test(qText)) quickReply = "Hii 👋";
              else if (/^(thanks|thank you|sthuthi|ස්තූති)\b\.?\!?$/i.test(qText)) quickReply = "Welcome 😄";
              else if (/^(ok|k|okay|okk+|hmm+|aw+a)\.?\!?$/i.test(qText)) quickReply = "👍";
              else if (/^(bye|byee+|gtg|cya)\b\.?\!?$/i.test(qText)) quickReply = "Bye! 🙋";

              if (quickReply) {
                const readDelay = 500 + Math.random() * 1000;
                const typingDelay = 500 + Math.random() * 1000;
                await new Promise(res => setTimeout(res, readDelay));
                await presenceUpdate(sock, from, "composing");
                await new Promise(res => setTimeout(res, typingDelay));
                await sock.sendMessage(from, { text: quickReply + "\u200B" }, { quoted: msg });
                const memDepth = appState.getAiAutoMemoryDepth ? appState.getAiAutoMemoryDepth() : 6;
                updateHistory(histKey, 'user', cmdText, memDepth);
                updateHistory(histKey, 'assistant', quickReply, memDepth);
                aiBurstBuckets.delete(histKey);
                return;
              }

              // 1. Reading Delay (Simulate reading the message)
              await new Promise(res => setTimeout(res, 1000 + Math.random() * 2000));
              aiRateLimits.set(sender + ":last", now);
              logger(`[AI-Auto] Processing for ${sender} in ${from} (Session: ${context.sessionId || 'main'})`);
              await presenceUpdate(sock, from, "composing");
              
              const persona = context.aiAutoPersona || appState.getAiAutoPersona() || "friendly";
              const lang = context.aiAutoLang || appState.getAiAutoLang() || "mixed";
              const useVoice = context.aiAutoVoice !== undefined ? context.aiAutoVoice : appState.getAiAutoVoice();
              
              const mixedStyle = " Respond in a natural, friendly WhatsApp chat style using a mix of Sinhala and English (Singlish). Use common Sri Lankan slang and informal grammar. Avoid formal or pure Sinhala. Sound like a close friend.";
              const strictRules = " RULES: 1. Match the user's message length (short → short, long → fuller). 2. NO unnecessary questions. 3. Be concise. 4. No overacting.";

              const personas = {
                'friendly': 'You are a helpful and chill friend named CHATHU MD.' + mixedStyle + strictRules,
                'funny': 'You are a funny friend named CHATHU MD. Use humor and emojis.' + mixedStyle + strictRules,
                'savage': 'You are a savage friend named CHATHU MD. Give sharp, short comebacks.' + mixedStyle + strictRules,
                'romantic': 'You are a sweet friend named CHATHU MD. Use heart emojis.' + mixedStyle + strictRules,
                'professional': 'You are a helpful assistant named CHATHU MD. Be concise.',
                'robot': 'You are a logical AI named CHATHU MD.'
              };
              
              const langInfo = lang === 'si' ? 'Reply mostly in Singlish.' : 
                               lang === 'en' ? 'Reply in English only.' : 
                               'Reply naturally based on the user\'s language.';
              
              const customInstr = context.aiSystemInstruction !== undefined ? context.aiSystemInstruction : appState.getAiSystemInstruction();
              const userMaxWords = context.aiMaxWords || appState.getAiMaxWords() || 30;
              const maxWords = adaptiveMaxWords(cmdText, userMaxWords);
              
              const sysInstr = `${personas[persona] || personas.friendly} ${langInfo} ${customInstr} Keep it natural for WhatsApp. LIMIT: Max ${maxWords} words.`;

              // Get History (per-user in groups, per-chat in DMs)
              const memDepth = appState.getAiAutoMemoryDepth ? appState.getAiAutoMemoryDepth() : 6;
              const fullHistory = chatHistory.get(histKey) || [];
              const trimmedHistory = fullHistory.slice(-memDepth * 2);
              const historyText = trimmedHistory.map(h => `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.content}`).join('\n');
              const safeUserMsg = sanitizeAiUserInput(cmdText);
              const finalPrompt = historyText ? `Previous Conversation:\n${historyText}\n\nCurrent User Message: ${safeUserMsg}` : safeUserMsg;

              let result = await aiCmd.generateAIResponse(finalPrompt, null, "image/jpeg", sysInstr, {
                quietFailures: true,
              });
              
              if (result?.text) {
                let cleanText = result.text;
                
                // If no custom instruction, be very strict (1 sentence only)
                if (!customInstr) {
                  cleanText = result.text.split(/[.?!](\s|$)/)[0].trim();
                  const firstPunct = result.text.match(/[.?!]/);
                  if (firstPunct && !cleanText.endsWith(firstPunct[0])) {
                    cleanText += firstPunct[0];
                  }
                  
                  // If it's too chatty with questions, cut it
                  if (cleanText.includes('?') && cleanText.indexOf('?') !== cleanText.lastIndexOf('?')) {
                     cleanText = cleanText.split('?')[0].trim() + '?';
                  }
                }

                // Final safety truncate to maxWords
                const words = cleanText.split(/\s+/);
                if (words.length > maxWords) {
                  cleanText = words.slice(0, maxWords).join(" ") + (customInstr ? "..." : "");
                }

                // 2. Typing Delay (Simulate typing time based on length)
                const typingTime = Math.min(cleanText.length * 40, 5000); 
                await new Promise(res => setTimeout(res, typingTime));

                aiAutoBackoffUntil.delete(from);
                updateHistory(histKey, 'user', cmdText, memDepth);
                updateHistory(histKey, 'assistant', cleanText, memDepth);
                aiBurstBuckets.delete(histKey);

                if (useVoice) {
                  const googleTTS = require("google-tts-api");
                  const ttsUrl = googleTTS.getAudioUrl(cleanText.slice(0, 200), { lang: lang === 'si' ? 'si' : 'en', slow: false, host: 'https://translate.google.com' });
                  await sock.sendMessage(from, { audio: { url: ttsUrl }, mimetype: 'audio/mp4', ptt: true }, { quoted: msg });
                } else {
                  await sock.sendMessage(from, { text: cleanText + "\u200B" }, { quoted: msg });
                }
              } else {
                aiAutoBackoffUntil.set(from, Date.now() + 60000);
                aiBurstBuckets.delete(histKey);
              }
            } catch (e) {
              aiAutoBackoffUntil.set(from, Date.now() + 60000);
              aiBurstBuckets.delete(histKey);
              logger(`[AI-Auto] Error: ${e.message}`);
            }
          })();
        }
      }
      return false;
    }

    const isSelf = msg.key.fromMe || isOwnerUser;
    if (!isSelf) {
      if (workMode === "self") return false;
      if (workMode === "private" && from.endsWith("@g.us")) return false;
      if (workMode === "group" && !from.endsWith("@g.us")) return false;
    }

    const args = cmdText.slice(prefix.length).trim().split(/\s+/);
    const name = args.shift()?.toLowerCase();
    if (!name) return false;

    const cmd = commands.get(name);
    if (!cmd) return false;

    // --- Safety Checks (Disabled Modules / Dashboard Blocks) ---
    // Map command categories to dashboard module keys so toggles in the
    // Bot Settings → Modules tab actually gate the right commands.
    const CATEGORY_TO_MODULE = {
        creative: 'ai',
        ai: 'ai',
        automation: 'automation',
        download: 'downloaders',
        downloads: 'downloaders',
        search: 'search',
        group: 'group',
        profile: 'user',
        user: 'user',
        system: 'system',
        sticker: 'system',
        settings: 'system',
        owner: 'owner',
        economy: 'economy',
        fun: 'fun',
        games: 'fun',
        status: 'status',
        nsfw: 'nsfw',
    };
    if (cmd.category) {
        const cat = cmd.category.toLowerCase();
        const mod = CATEGORY_TO_MODULE[cat] || cat;
        if (disabledModules.includes(cat) || disabledModules.includes(mod)) {
            await msgMgr.sendTemp(sock, from, `⚠️ Module *${cmd.category}* is restricted in this session.`, 4000);
            return true;
        }
    }

    if (db.get("commandSettings", cmd.name)?.enabled === false) {
      await msgMgr.sendTemp(sock, from, `⚠️ Command *${cmd.name}* is currently disabled.`, 4000);
      return true;
    }

    // --- Execution ---
    logger(`[Handler] Executing: ${name} | Sender: ${sender.split('@')[0]} | Chat: ${from}`);
    try {
      await withOwnerContext(ownerRefs, () => cmd.execute(sock, msg, from, args, name, context));
    } catch (err) {
      logger(`[Command Error/${name}] ${err.stack || err.message}`);
      await msgMgr.sendTemp(sock, from, "❌ An internal error occurred while executing the command.", 5000);
    }
    return true;
  } catch (err) {
    logger(`[Handler Error] ${err.message}`);
    return false;
  }
}

/**
 * Group Event Handler (Welcome/Goodbye)
 */
async function onGroupUpdate(sock, { id, participants, action }) {
  if (!sock || !id || !participants) return;
  const groupData = db.get("groups", id) || {};
  if (!groupData.welcome && !groupData.goodbye) return;

  for (const participant of participants) {
    try {
      const groupMeta = await sock.groupMetadata(id);
      const userJid = participant;
      let ppUrl;
      try { ppUrl = await sock.profilePictureUrl(userJid, "image"); } catch { ppUrl = "https://i.ibb.co/6R0D0kP/user.jpg"; }

      const tCtx = { sender: userJid };
      
      if (action === "add" && groupData.welcome) {
        let msg = themeMgr.format("header", { title: "𝐖𝐄𝐋𝐂𝐎𝐌𝐄" }, tCtx);
        msg += "\n";
        msg += themeMgr.format("section", { title: "ᴘʀᴏғɪʟᴇ" }, tCtx);
        msg += themeMgr.format("item", { bullet: "user", content: `ᴜsᴇʀ  : @${userJid.split("@")[0]}` }, tCtx);
        msg += themeMgr.format("item", { bullet: "group", content: `ɢʀᴏᴜᴘ : ${groupMeta.subject}` }, tCtx);
        msg += themeMgr.format("footer", {}, tCtx);
        msg += "\n";
        msg += themeMgr.format("box_start", { title: "ɴᴏᴛɪᴄᴇ" }, tCtx);
        msg += themeMgr.format("box_item", { bullet: "default", content: "Welcome to our community! Please follow the rules." }, tCtx);
        msg += themeMgr.format("box_end", {}, tCtx);
        msg += themeMgr.getSignature(userJid);

        await sock.sendMessage(id, { image: { url: ppUrl }, caption: msg, mentions: [userJid] });
      } else if (action === "remove" && groupData.goodbye) {
        let msg = themeMgr.format("header", { title: "𝐆𝐎𝐎𝐃𝐁𝐘𝐄" }, tCtx);
        msg += "\n";
        msg += themeMgr.format("section", { title: "ᴘʀᴏғɪʟᴇ" }, tCtx);
        msg += themeMgr.format("item", { bullet: "user", content: `ᴜsᴇʀ  : @${userJid.split("@")[0]}` }, tCtx);
        msg += themeMgr.format("footer", {}, tCtx);
        msg += "\n";
        msg += themeMgr.format("box_start", { title: "ғᴀʀᴇᴡᴇʟʟ" }, tCtx);
        msg += themeMgr.format("box_item", { bullet: "default", content: "We hope to see you again soon. Good luck!" }, tCtx);
        msg += themeMgr.format("box_end", {}, tCtx);
        msg += themeMgr.getSignature(userJid);

        await sock.sendMessage(id, { image: { url: ppUrl }, caption: msg, mentions: [userJid] });
      }
    } catch (err) {
      logger(`[GroupUpdate Error] ${err.message}`);
    }
  }
}

function getCategories() {
  const cats = new Set();
  commands.forEach(cmd => { if (cmd.category) cats.add(cmd.category.toLowerCase()); });
  return Array.from(cats).sort();
}

/**
 * Run a command resolved from a role-menu interaction (button tap, list
 * selection, native-flow response, or numeric reply). Reuses the same
 * disabled-module / per-command toggles as the normal prefix path so a
 * disabled command stays disabled even when invoked via the menu.
 */
async function dispatchRoleMenuCommand(sock, msg, from, sender, cmdName, context = {}, ownerRefs = []) {
  if (!cmdName) return false;
  const cmd = commands.get(String(cmdName).toLowerCase());
  if (!cmd) {
    await msgMgr.sendTemp(sock, from, `⚠️ Unknown command: *${cmdName}*`, 4000);
    return true;
  }

  // Reuse the same category → module mapping the regular path uses.
  const CATEGORY_TO_MODULE = {
    creative: 'ai', ai: 'ai', automation: 'automation',
    download: 'downloaders', downloads: 'downloaders',
    search: 'search', group: 'group', profile: 'user', user: 'user',
    system: 'system', sticker: 'system', settings: 'system',
    owner: 'owner', economy: 'economy', fun: 'fun', games: 'fun',
    status: 'status', nsfw: 'nsfw',
  };

  const disabledModules = Array.isArray(context.disabledModules) ? context.disabledModules : [];
  if (cmd.category) {
    const cat = cmd.category.toLowerCase();
    const mod = CATEGORY_TO_MODULE[cat] || cat;
    if (disabledModules.includes(cat) || disabledModules.includes(mod)) {
      await msgMgr.sendTemp(sock, from, `⚠️ Module *${cmd.category}* is restricted in this session.`, 4000);
      return true;
    }
  }
  if (db.get("commandSettings", cmd.name)?.enabled === false) {
    await msgMgr.sendTemp(sock, from, `⚠️ Command *${cmd.name}* is currently disabled.`, 4000);
    return true;
  }

  const ctx = { ...context, isOwner: isOwner(sender, ownerRefs), viaRoleMenu: true };
  logger(`[RoleMenu] Dispatching: ${cmd.name} | Sender: ${String(sender).split('@')[0]} | Chat: ${from}`);
  try {
    await withOwnerContext(ownerRefs, () => cmd.execute(sock, msg, from, [], cmd.name, ctx));
  } catch (err) {
    logger(`[RoleMenu Dispatch Error/${cmd.name}] ${err.stack || err.message}`);
    await msgMgr.sendTemp(sock, from, "❌ Failed to run that command.", 5000);
  }
  return true;
}

module.exports = {
  loadCommands,
  handleCommand,
  storeSearchResults,
  showQualityMenu,
  storePlaySelection,
  onGroupUpdate,
  getCategories,
};
