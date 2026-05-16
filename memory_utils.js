import fs from 'fs';
import path from 'path';
import os from 'os';

const MEMORY_FILE = path.join(os.homedir(), '.agentlag', 'memory.json');

export function loadMemory() {
    try {
        if (!fs.existsSync(MEMORY_FILE)) return {};
        return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
    } catch {
        return {};
    }
}

export function saveMemory(memory) {
    const dir = path.dirname(MEMORY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
}

export function addToMemory(key, value) {
    const memory = loadMemory();
    memory[key] = value;
    saveMemory(memory);
}

export function getFromMemory(key) {
    const memory = loadMemory();
    return memory[key];
}

export function listMemory() {
    const memory = loadMemory();
    return Object.entries(memory)
        .map(([k, v]) => `- ${k}: ${v}`)
        .join('\n');
}
