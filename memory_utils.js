import fs from 'fs';
import path from 'path';
import os from 'os';

const DEFAULT_MEMORY_FILE = path.join(os.homedir(), '.agentlag', 'memory.json');
const MEMORY_VERSION = 2;

export function memoryFilePath(options = {}) {
    return options.memoryFile || process.env.AGENTLAG_MEMORY_FILE || DEFAULT_MEMORY_FILE;
}

function nowIso() {
    return new Date().toISOString();
}

function normalizeEntry(key, value) {
    const now = nowIso();
    if (value && typeof value === 'object' && 'value' in value) {
        return {
            value: value.value,
            project: value.project || 'global',
            context: value.context || '',
            createdAt: value.createdAt || now,
            updatedAt: value.updatedAt || value.createdAt || now,
            expiresAt: value.expiresAt || null,
        };
    }
    return {
        value,
        project: 'legacy',
        context: '',
        createdAt: now,
        updatedAt: now,
        expiresAt: null,
    };
}

function normalizeMemory(raw) {
    const entries = raw?.version === MEMORY_VERSION && raw.entries && typeof raw.entries === 'object'
        ? raw.entries
        : raw && typeof raw === 'object'
            ? raw
            : {};

    return {
        version: MEMORY_VERSION,
        entries: Object.fromEntries(
            Object.entries(entries).map(([key, value]) => [key, normalizeEntry(key, value)])
        ),
    };
}

function isExpired(entry, now = Date.now()) {
    return Boolean(entry?.expiresAt && Date.parse(entry.expiresAt) <= now);
}

export function loadMemory(options = {}) {
    const filePath = memoryFilePath(options);
    try {
        if (!fs.existsSync(filePath)) return { version: MEMORY_VERSION, entries: {} };
        return normalizeMemory(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    } catch {
        return { version: MEMORY_VERSION, entries: {} };
    }
}

export function saveMemory(memory, options = {}) {
    const filePath = memoryFilePath(options);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(normalizeMemory(memory), null, 2));
}

export function addToMemory(key, value, options = {}) {
    const memory = loadMemory(options);
    const existing = memory.entries[key];
    const now = nowIso();
    const ttlDays = Number(options.ttlDays);
    memory.entries[key] = {
        value,
        project: options.project || existing?.project || path.basename(process.cwd()) || 'global',
        context: options.context || existing?.context || '',
        createdAt: existing?.createdAt || now,
        updatedAt: now,
        expiresAt: Number.isFinite(ttlDays) && ttlDays > 0
            ? new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString()
            : existing?.expiresAt || null,
    };
    saveMemory(memory, options);
}

export function getFromMemory(key, options = {}) {
    const memory = loadMemory(options);
    const entry = memory.entries[key];
    if (!entry || isExpired(entry)) return undefined;
    return entry.value;
}

export function listMemory(options = {}) {
    const { includeExpired = false } = options;
    const memory = loadMemory(options);
    return Object.entries(memory.entries)
        .filter(([, entry]) => includeExpired || !isExpired(entry))
        .map(([k, entry]) => {
            const parts = [
                `project=${entry.project || 'global'}`,
                `updated=${entry.updatedAt || entry.createdAt || 'unknown'}`,
            ];
            if (entry.context) parts.push(`context=${entry.context}`);
            if (entry.expiresAt) parts.push(`expires=${entry.expiresAt}`);
            return `- ${k}: ${entry.value} (${parts.join(', ')})`;
        })
        .join('\n');
}
