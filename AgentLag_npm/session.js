// ─── session.js ───────────────────────────────────────────────────────────────
// Persistencia de conversaciones en ~/.agentlag/ y .agentlag/conversations/
import fs   from 'fs';
import path from 'path';
import os   from 'os';

export const CONFIG_DIR          = path.join(os.homedir(), '.agentlag');
export const CONFIG_FILE         = path.join(CONFIG_DIR, 'config.json');
export const MEMORY_FILE         = path.join(CONFIG_DIR, 'memory.md');
export const HOOKS_FILE          = path.join(CONFIG_DIR, 'hooks.json');
export const MCP_FILE            = path.join(CONFIG_DIR, 'mcp.json');
export const AGENTS_DIR          = path.join(CONFIG_DIR, 'agents');
export const PROJECT_SESSION_DIR = path.join(process.cwd(), '.agentlag', 'conversations');
export const LEGACY_SESSION_FILE = path.join(process.cwd(), '.agentlag_history.json');

// ── Config global ─────────────────────────────────────────────────────────────
export function ensureDir() {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
}
export function loadConfig() {
    try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}
export function saveConfig(data) {
    ensureDir();
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));
}

// ── Conversaciones por proyecto ───────────────────────────────────────────────
export function ensureProjectSessionDir() {
    if (!fs.existsSync(PROJECT_SESSION_DIR))
        fs.mkdirSync(PROJECT_SESSION_DIR, { recursive: true });
}

export function normalizeConversationName(name) {
    return (name || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase() .slice(0, 100);
}

export function conversationFile(name) {
    const normalized = normalizeConversationName(name);
    return normalized ? path.join(PROJECT_SESSION_DIR, `${normalized}.json`) : null;
}

export function listConversations() {
    try {
        return fs.readdirSync(PROJECT_SESSION_DIR)
            .filter(f => f.endsWith('.json') && f !== 'latest.json')
            .map(f => path.basename(f, '.json'))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    } catch { return []; }
}

export function nextConversationName() {
    const nums = listConversations()
        .map(n => n.match(/^conversacion(\d+)$/)?.[1])
        .filter(Boolean)
        .map(Number);
    return `conversacion${nums.length ? Math.max(...nums) + 1 : 1}`;
}

function legacySession() {
    try {
        const data = JSON.parse(fs.readFileSync(LEGACY_SESSION_FILE, 'utf8'));
        return data.history?.length ? { name: 'legacy', history: data.history } : null;
    } catch { return null; }
}

export function loadSession(name) {
    const requested  = normalizeConversationName(name);
    const candidates = [];

    if (requested) candidates.push(conversationFile(requested));
    else           candidates.push(conversationFile('latest'), LEGACY_SESSION_FILE);

    for (const file of candidates.filter(Boolean)) {
        try {
            const data = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (data.history?.length)
                return { name: data.name || requested || 'latest', history: data.history };
        } catch {}
    }

    if (requested) return null;
    return legacySession() || { history: [] };
}

export function saveSession(history, currentName) {
    const toSave = history.filter(
        m => (m.type === 'user' || m.type === 'assistant') && !m.ephemeral
    );
    if (!toSave.length) return null;

    ensureProjectSessionDir();
    const name    = normalizeConversationName(currentName) || nextConversationName();
    const payload = {
        name,
        cwd:     process.cwd(),
        savedAt: new Date().toISOString(),
        history: toSave,
    };

    fs.writeFileSync(conversationFile(name),     JSON.stringify(payload, null, 2));
    fs.writeFileSync(conversationFile('latest'), JSON.stringify(payload, null, 2));
    try { fs.writeFileSync(LEGACY_SESSION_FILE, JSON.stringify({ history: toSave }, null, 2)); } catch {}
    return payload;
}

export function clearLatestSession() {
    ensureProjectSessionDir();
    const payload = {
        name: 'latest', cwd: process.cwd(),
        savedAt: new Date().toISOString(), history: [],
    };
    fs.writeFileSync(conversationFile('latest'), JSON.stringify(payload, null, 2));
    try { fs.writeFileSync(LEGACY_SESSION_FILE, JSON.stringify({ history: [] }, null, 2)); } catch {}
}
