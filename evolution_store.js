import fs from 'fs';
import path from 'path';
import os from 'os';

const CONFIG_DIR = path.join(os.homedir(), '.agentlag');
const EVOLUTIONS_FILE = path.join(CONFIG_DIR, 'pending_evolutions.json');
const MAX_EVOLUTIONS = 20;

function ensureDir() {
    if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
}

export function getEvolutions() {
    try {
        if (!fs.existsSync(EVOLUTIONS_FILE)) return [];
        return JSON.parse(fs.readFileSync(EVOLUTIONS_FILE, 'utf8'));
    } catch (error) {
        console.error("Error reading evolutions:", error);
        return [];
    }
}

export function saveEvolutions(evolutions) {
    try {
        ensureDir();
        fs.writeFileSync(EVOLUTIONS_FILE, JSON.stringify(evolutions, null, 2));
    } catch (error) {
        console.error("Error saving evolutions:", error);
    }
}

export function addEvolution(evolution) {
    const evolutions = getEvolutions();
    const newEvolution = {
        id: `ev_${Date.now()}`,
        ...evolution,
        createdAt: new Date().toISOString()
    };

    // Add to the beginning (most recent first)
    evolutions.unshift(newEvolution);

    // Keep only the latest MAX_EVOLUTIONS
    if (evolutions.length > MAX_EVOLUTIONS) {
        evolutions.length = MAX_EVOLUTIONS;
    }

    saveEvolutions(evolutions);
    return newEvolution;
}

export function removeEvolution(id) {
    const evolutions = getEvolutions();
    const filtered = evolutions.filter(ev => ev.id !== id);
    saveEvolutions(filtered);
}

export function getLatestEvolution() {
    const evolutions = getEvolutions();
    return evolutions.length > 0 ? evolutions[0] : null;
}
