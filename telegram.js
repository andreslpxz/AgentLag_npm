import { Telegraf } from 'telegraf';
import { buildAgent } from './agent.js';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __agentDir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__agentDir, ".env") });

const botToken = process.env.TELEGRAM_BOT_TOKEN;
const allowedUserId = process.env.TELEGRAM_ALLOWED_USER_ID;

if (!botToken) {
    console.error('TELEGRAM_BOT_TOKEN not found in .env');
    process.exit(1);
}

const bot = new Telegraf(botToken);
let agent;

bot.use(async (ctx, next) => {
    if (allowedUserId && ctx.from.id.toString() !== allowedUserId.toString()) {
        return ctx.reply('No tienes permiso para usar este bot.');
    }
    return next();
});

bot.start((ctx) => ctx.reply('¡Hola! Soy AgentLag. ¿En qué puedo ayudarte hoy?'));

bot.on('text', async (ctx) => {
    const text = ctx.message.text;
    try {
        if (!agent) {
            ctx.reply('Iniciando agente...');
            agent = await buildAgent();
        }

        // We could manage history per user/chat here
        const result = await agent.invoke({
            messages: [new HumanMessage(text)]
        });

        const lastMsg = result.messages[result.messages.length - 1];
        await ctx.reply(lastMsg.content);
    } catch (error) {
        console.error('Error in Telegram bot:', error);
        ctx.reply('Lo siento, ocurrió un error al procesar tu solicitud.');
    }
});

bot.launch().then(() => {
    console.log('Telegram bot is running');
});

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
