// ─── discord.js ───────────────────────────────────────────────────────────────
// Discord bot entry point — mirrors telegram.js but uses discord.js v14.
//
// Required env (in .env or process.env):
//   DISCORD_BOT_TOKEN         — bot token from https://discord.com/developers
//
// Optional env:
//   DISCORD_ALLOWED_USER_IDS  — comma-separated whitelist of Discord user IDs.
//                                If unset, ANY user who can DM the bot (or @mention
//                                it in a channel it can read) can talk to it. Set
//                                this in production!
//   DISCORD_ALLOWED_GUILD_IDS — comma-separated whitelist of server IDs. If unset,
//                                the bot will respond in every server it's in.
//   DISCORD_PREFIX            — optional command prefix for non-mention triggers.
//                                Defaults to none (only @mentions and DMs trigger).
//
// Run with:  npm run discord     (after adding the script to package.json)
//            or:  node discord.js

import {
    Client,
    GatewayIntentBits,
    Partials,
    Events,
    EmbedBuilder,
} from 'discord.js';
import { buildAgent } from './agent.js';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __agentDir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__agentDir, ".env") });

// ─── Config ──────────────────────────────────────────────────────────────────
const BOT_TOKEN         = process.env.DISCORD_BOT_TOKEN;
const ALLOWED_USER_IDS  = (process.env.DISCORD_ALLOWED_USER_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
const ALLOWED_GUILD_IDS = (process.env.DISCORD_ALLOWED_GUILD_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
const PREFIX            = process.env.DISCORD_PREFIX || null;

if (!BOT_TOKEN) {
    console.error('DISCORD_BOT_TOKEN not found in .env');
    console.error('Get one at: https://discord.com/developers/applications');
    process.exit(1);
}

// ─── Shared execution log (writes to the same file as Telegram + scheduler) ─
const EXECUTION_LOGS_FILE = path.join(__agentDir, 'scheduler_logs.json');

function logExecution(data) {
    try {
        let logs = [];
        if (fs.existsSync(EXECUTION_LOGS_FILE)) {
            logs = JSON.parse(fs.readFileSync(EXECUTION_LOGS_FILE, 'utf8'));
        }
        logs.push({ timestamp: new Date().toISOString(), ...data });
        if (logs.length > 100) logs.shift();
        fs.writeFileSync(EXECUTION_LOGS_FILE, JSON.stringify(logs, null, 2));
    } catch (err) {
        console.error('Error writing execution log:', err);
    }
}

// ─── State ───────────────────────────────────────────────────────────────────
let agent;
const chatHistories = new Map();   // channelId -> HumanMessage/AIMessage[]
const MAX_HISTORY   = 20;
const MAX_MSG_LEN   = 1900;        // Discord hard cap is 2000 — leave room for code fences
const userRateLimits = new Map();  // userId -> lastSeen timestamp

// ─── Helpers ─────────────────────────────────────────────────────────────────
function isAuthorized(message) {
    // 1. User whitelist (if set)
    if (ALLOWED_USER_IDS.length > 0) {
        if (!ALLOWED_USER_IDS.includes(message.author.id)) {
            return { ok: false, reason: 'user' };
        }
    }
    // 2. Guild whitelist (if set and message is from a guild)
    if (ALLOWED_GUILD_IDS.length > 0 && message.guild) {
        if (!ALLOWED_GUILD_IDS.includes(message.guild.id)) {
            return { ok: false, reason: 'guild' };
        }
    }
    return { ok: true };
}

function shouldRespond(message) {
    // Never reply to bots (including ourselves)
    if (message.author.bot) return false;

    // Always respond in DMs
    if (!message.guild) return true;

    // Respond if directly @mentioned
    if (message.mentions.has(message.client.user.id)) return true;

    // Respond if a prefix is configured and the message starts with it
    if (PREFIX && message.content.trim().toLowerCase().startsWith(PREFIX.toLowerCase())) {
        return true;
    }

    return false;
}

function cleanContent(message) {
    let text = message.content;
    // Strip the bot @mention from the text
    text = text.replace(new RegExp(`<@!?${message.client.user.id}>`, 'g'), '').trim();
    // Strip the prefix if present
    if (PREFIX && text.toLowerCase().startsWith(PREFIX.toLowerCase())) {
        text = text.slice(PREFIX.length).trim();
    }
    return text;
}

function chunkText(text, maxLen = MAX_MSG_LEN) {
    if (typeof text !== 'string') text = String(text ?? '');
    if (text.length <= maxLen) return [text];

    const chunks = [];
    // Try to split on double newlines first (paragraph boundaries)
    const paragraphs = text.split(/\n\n+/);
    let current = '';
    for (const p of paragraphs) {
        if (current.length + p.length + 2 <= maxLen) {
            current = current ? current + '\n\n' + p : p;
        } else {
            if (current) chunks.push(current);
            if (p.length <= maxLen) {
                current = p;
            } else {
                // Hard-split long paragraph on single newlines, then on words
                const lines = p.split('\n');
                current = '';
                for (const line of lines) {
                    if (current.length + line.length + 1 <= maxLen) {
                        current = current ? current + '\n' + line : line;
                    } else {
                        if (current) chunks.push(current);
                        if (line.length <= maxLen) {
                            current = line;
                        } else {
                            // Word-level hard split
                            const words = line.split(' ');
                            current = '';
                            for (const w of words) {
                                if (current.length + w.length + 1 <= maxLen) {
                                    current = current ? current + ' ' + w : w;
                                } else {
                                    if (current) chunks.push(current);
                                    current = w;
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    if (current) chunks.push(current);
    return chunks;
}

async function sendChunked(channel, text) {
    const chunks = chunkText(text);
    for (const chunk of chunks) {
        await channel.send(chunk);
    }
}

// ─── Bot setup ───────────────────────────────────────────────────────────────
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.DirectMessageReactions,
        GatewayIntentBits.MessageContent,   // privileged — must be enabled in the Developer Portal
    ],
    partials: [
        Partials.Channel,   // required for DMs to fire reliably
        Partials.Message,
    ],
});

client.once(Events.ClientReady, (c) => {
    console.log(`Discord bot is running as @${c.user.tag} (id: ${c.user.id})`);
    if (ALLOWED_USER_IDS.length > 0) {
        console.log(`  Whitelisted users: ${ALLOWED_USER_IDS.join(', ')}`);
    } else {
        console.log('  ⚠️  No user whitelist set — ANYONE who can reach the bot can talk to it.');
        console.log('     Set DISCORD_ALLOWED_USER_IDS in .env to restrict access.');
    }
    if (ALLOWED_GUILD_IDS.length > 0) {
        console.log(`  Whitelisted guilds: ${ALLOWED_GUILD_IDS.join(', ')}`);
    }
});

client.on(Events.MessageCreate, async (message) => {
    if (!shouldRespond(message)) return;

    // Authorization
    const auth = isAuthorized(message);
    if (!auth.ok) {
        if (auth.reason === 'user') {
            console.log(`[Security] Denied user: ${message.author.tag} (${message.author.id})`);
            return message.reply('🚫 No tienes permiso para usar este bot.');
        }
        if (auth.reason === 'guild') {
            return; // silently ignore messages from non-whitelisted guilds
        }
    }

    // Rate limiting (1 message / 2 seconds per user)
    const now = Date.now();
    const lastSeen = userRateLimits.get(message.author.id) || 0;
    if (now - lastSeen < 2000) {
        return message.reply('⚠️ Vas muy rápido. Espera un momento.');
    }
    userRateLimits.set(message.author.id, now);

    const text = cleanContent(message);
    if (!text) return;

    // Show typing indicator while the agent works
    await message.channel.sendTyping().catch(() => {});

    try {
        if (!agent) {
            // Security: exclude run_shell on Discord by default (mirror Telegram)
            agent = await buildAgent({ excludedTools: ['run_shell'] });
        }

        const channelId = message.channel.id;
        if (!chatHistories.has(channelId)) {
            chatHistories.set(channelId, []);
        }
        const history = chatHistories.get(channelId);

        history.push(new HumanMessage(text));
        if (history.length > MAX_HISTORY) {
            history.splice(0, history.length - MAX_HISTORY);
        }

        const result = await agent.invoke(
            { messages: history },
            { recursionLimit: 50 }   // avoid GraphRecursionError on multi-tool turns
        );

        // Persist new messages from this turn
        const newMessages = result.messages.slice(history.length);
        history.push(...newMessages);
        if (history.length > MAX_HISTORY) {
            history.splice(0, history.length - MAX_HISTORY);
        }

        const lastMsg = result.messages[result.messages.length - 1];
        const replyText = lastMsg?.content ?? '(sin respuesta)';

        logExecution({
            source: 'discord',
            channelId,
            user: `${message.author.tag} (${message.author.id})`,
            input: text,
            output: replyText,
            toolCalls: newMessages.filter(m => m.tool_calls?.length > 0).map(m => m.tool_calls),
        });

        // Keep typing indicator alive for long-running responses
        const typingInterval = setInterval(() => {
            message.channel.sendTyping().catch(() => {});
        }, 8000);

        try {
            await sendChunked(message.channel, replyText);
        } finally {
            clearInterval(typingInterval);
        }

    } catch (error) {
        console.error('Error in Discord bot:', error);

        // GraphRecursionError: agent got stuck in a tool loop — give a helpful hint
        const isRecursion = error?.lc_error_code === 'GRAPH_RECURSION_LIMIT' ||
                           error?.name === 'GraphRecursionError' ||
                           /recursion limit/i.test(error?.message || '');

        const userMsg = isRecursion
            ? '❌ El agente superó el límite de iteraciones (probablemente un bucle de herramientas). Intenta con `/clear` para reiniciar el contexto o reformula tu solicitud de forma más específica.'
            : '❌ Ocurrió un error al procesar tu solicitud.';

        try {
            await message.reply(userMsg);
        } catch {}

        // On recursion errors, clear the channel history to prevent the loop from persisting
        if (isRecursion) {
            chatHistories.set(message.channel.id, []);
        }

        logExecution({
            source: 'discord',
            channelId: message.channel.id,
            user: `${message.author.tag} (${message.author.id})`,
            input: text,
            error: error.message,
            errorType: error?.name || error?.lc_error_code || 'Unknown',
        });
    }
});

// ─── Slash commands (optional niceties) ──────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'ping') {
        await interaction.reply(`🏓 Pong! Latencia: ${client.ws.ping}ms`);
        return;
    }

    if (interaction.commandName === 'clear') {
        const channelId = interaction.channel.id;
        if (chatHistories.has(channelId)) {
            chatHistories.set(channelId, []);
            await interaction.reply('🧹 Historial de conversación borrado.');
        } else {
            await interaction.reply('ℹ️ No hay historial para este canal.');
        }
        return;
    }
});

// Graceful shutdown
process.once('SIGINT',  () => { client.destroy(); process.exit(0); });
process.once('SIGTERM', () => { client.destroy(); process.exit(0); });

client.login(BOT_TOKEN).catch((err) => {
    console.error('Failed to log in to Discord:', err.message);
    if (err.code === 'TokenInvalid') {
        console.error(' → DISCORD_BOT_TOKEN is invalid. Get a real token from https://discord.com/developers/applications');
    }
    process.exit(1);
});
