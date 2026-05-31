import { Telegraf } from 'telegraf';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __agentDir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__agentDir, ".env") });

const botToken = process.env.TELEGRAM_BOT_TOKEN;
const allowedUserId = process.env.TELEGRAM_ALLOWED_USER_ID;

if (!botToken) {
    console.error('TELEGRAM_BOT_TOKEN not found in .env');
    process.exit(1);
}

const bot = new Telegraf(botToken);

// --- Seguridad y Logging ---
const userRateLimits = new Map();
const EXECUTION_LOGS_FILE = path.join(__agentDir, 'scheduler_logs.json');

// Helper to log executions
export function logExecution(data) {
    try {
        let logs = [];
        if (fs.existsSync(EXECUTION_LOGS_FILE)) {
            logs = JSON.parse(fs.readFileSync(EXECUTION_LOGS_FILE, 'utf8'));
        }
        logs.push({
            timestamp: new Date().toISOString(),
            ...data
        });
        // Keep last 100 logs
        if (logs.length > 100) logs.shift();
        fs.writeFileSync(EXECUTION_LOGS_FILE, JSON.stringify(logs, null, 2));
    } catch (err) {
        console.error('Error writing execution log:', err);
    }
}

export function getExecutionLogs() {
    try {
        if (fs.existsSync(EXECUTION_LOGS_FILE)) {
            return JSON.parse(fs.readFileSync(EXECUTION_LOGS_FILE, 'utf8'));
        }
    } catch (err) {}
    return [];
}

// Middleware de seguridad y rate limit
bot.use(async (ctx, next) => {
    // 1. Whitelist de usuario
    if (allowedUserId && ctx.from && ctx.from.id.toString() !== allowedUserId.toString()) {
        console.log(`[Security] Intento de acceso denegado de: ${ctx.from.id}`);
        return ctx.reply('No tienes permiso para usar este bot.');
    }

    // 2. Rate Limiting (máx 1 mensaje cada 2 segundos por usuario)
    if (ctx.from) {
        const now = Date.now();
        const lastSeen = userRateLimits.get(ctx.from.id) || 0;
        if (now - lastSeen < 2000) {
            return ctx.reply('⚠️ Vas muy rápido. Espera un momento.');
        }
        userRateLimits.set(ctx.from.id, now);
    }

    return next();
});

export { bot, allowedUserId };
