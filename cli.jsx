#!/usr/bin/env node
import React, { useState, useCallback, useRef, useEffect } from 'react';
import { render, Text, Box, useInput, Static, Newline, useStdout } from 'ink';
import { buildAgent, stripMarkdown, trySalvageToolCall } from './agent.js';
import { fetchOllamaModels, isOllamaRunning } from './ollama_utils.js';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { clearSkillsCache, formatSkillsIndex, readSkill } from './skills.js';
import pkg from './package.json' with { type: 'json' };

// ─── Persistencia ~/.agentlag/ ────────────────────────────────────────────────
const CONFIG_DIR  = path.join(os.homedir(), '.agentlag');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const PROJECT_SESSION_DIR = path.join(process.cwd(), '.agentlag', 'conversations');
const LEGACY_SESSION_FILE = path.join(process.cwd(), '.agentlag_history.json');

function ensureDir() {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
}
function loadConfig() {
    try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}
function saveConfig(data) {
    ensureDir();
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));
}

function ensureProjectSessionDir() {
    if (!fs.existsSync(PROJECT_SESSION_DIR)) fs.mkdirSync(PROJECT_SESSION_DIR, { recursive: true });
}

function normalizeConversationName(name) {
    return (name || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase();
}

function conversationFile(name) {
    const normalized = normalizeConversationName(name);
    return normalized ? path.join(PROJECT_SESSION_DIR, `${normalized}.json`) : null;
}

function listConversations() {
    try {
        return fs.readdirSync(PROJECT_SESSION_DIR)
            .filter(f => f.endsWith('.json') && f !== 'latest.json')
            .map(f => path.basename(f, '.json'))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    } catch {
        return [];
    }
}

function nextConversationName() {
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
    } catch {
        return null;
    }
}

function loadSession(name) {
    const requested = normalizeConversationName(name);
    const candidates = [];

    if (requested) candidates.push(conversationFile(requested));
    else candidates.push(conversationFile('latest'), LEGACY_SESSION_FILE);

    for (const file of candidates.filter(Boolean)) {
        try {
            const data = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (data.history?.length) return { name: data.name || requested || 'latest', history: data.history };
        } catch {}
    }

    if (requested) return null;
    return legacySession() || { history: [] };
}

function saveSession(history, currentName) {
    const toSave = history.filter(m => (m.type === 'user' || m.type === 'assistant') && !m.ephemeral);
    if (!toSave.length) return null;

    ensureProjectSessionDir();
    const name = normalizeConversationName(currentName) || nextConversationName();
    const payload = {
        name,
        cwd: process.cwd(),
        savedAt: new Date().toISOString(),
        history: toSave,
    };

    fs.writeFileSync(conversationFile(name), JSON.stringify(payload, null, 2));
    fs.writeFileSync(conversationFile('latest'), JSON.stringify(payload, null, 2));
    try { fs.writeFileSync(LEGACY_SESSION_FILE, JSON.stringify({ history: toSave }, null, 2)); } catch {}
    return payload;
}

function clearLatestSession() {
    ensureProjectSessionDir();
    const payload = { name: 'latest', cwd: process.cwd(), savedAt: new Date().toISOString(), history: [] };
    fs.writeFileSync(conversationFile('latest'), JSON.stringify(payload, null, 2));
    try { fs.writeFileSync(LEGACY_SESSION_FILE, JSON.stringify({ history: [] }, null, 2)); } catch {}
}

// ─── Utilidades para slash commands ───────────────────────────────────────────
function copyToClipboard(text) {
    return new Promise((resolve) => {
        const candidates = [
            ['termux-clipboard-set', []],
            ['xclip', ['-selection', 'clipboard']],
            ['xsel', ['--clipboard', '--input']],
            ['pbcopy', []],
            ['wl-copy', []],
        ];
        let i = 0;
        const tryNext = () => {
            if (i >= candidates.length) return resolve(false);
            const [bin, args] = candidates[i++];
            let proc;
            try { proc = spawn(bin, args, { stdio: ['pipe', 'ignore', 'ignore'] }); }
            catch { return tryNext(); }
            proc.on('error', tryNext);
            proc.on('close', code => { code === 0 ? resolve(true) : tryNext(); });
            try { proc.stdin.write(text); proc.stdin.end(); } catch { tryNext(); }
        };
        tryNext();
    });
}

function splitCommandArgs(text) {
    return Array.from(text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g), match => match[1] ?? match[2] ?? match[3]);
}

function runCommand(bin, args = [], opts = {}) {
    return new Promise((resolve) => {
        let proc;
        try { proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts }); }
        catch (e) { return resolve({ ok:false, output:`${bin} no encontrado: ${e.message}`, code:127 }); }
        let out = '', err = '';
        proc.stdout?.on('data', d => out += d.toString());
        proc.stderr?.on('data', d => err += d.toString());
        proc.on('error', (e) => resolve({ ok:false, output:`${bin} no encontrado: ${e.message}`, code:127 }));
        proc.on('close', code => {
            const text = (out + (err ? `\n${err}` : '')).trim();
            resolve({ ok: code === 0, output: text || `(exit ${code})`, code });
        });
    });
}

const MEMORY_FILE  = path.join(CONFIG_DIR, 'memory.md');
const HOOKS_FILE   = path.join(CONFIG_DIR, 'hooks.json');
const MCP_FILE     = path.join(CONFIG_DIR, 'mcp.json');
const AGENTS_DIR   = path.join(CONFIG_DIR, 'agents');

// Junta todas las posibles ubicaciones de mensaje en un objeto de error para
// poder hacer matching case-insensitive sin reventar por shapes inesperados.
function flattenErrorText(err) {
    const parts = [
        err?.message,
        err?.error?.message,
        err?.cause?.message,
        err?.response?.data?.error?.message,
        typeof err === 'string' ? err : '',
    ].filter(Boolean);
    return parts.join(' ');
}

// Detecta los varios formatos de error que indican que el modelo/proveedor no
// soporta tool / function calling correctamente. Cubre:
//   - OpenAI / Anthropic / Mistral (literal "does not support tools")
//   - OpenRouter (404 "No endpoints found that support tool use",
//     "Try disabling create_file")
//   - Groq (400 invalid_request_error code:"tool_use_failed",
//     "Failed to call a function. Please adjust your prompt"). Pasa muy
//     seguido con llama-4-scout y derivados que emiten texto en vez de un
//     JSON de tool call. La respuesta SI suele estar en `failed_generation`.
function isToolUnsupportedError(err) {
    const text = flattenErrorText(err).toLowerCase();
    if (!text) return false;
    return (
        text.includes('does not support tools') ||
        text.includes('does not support tool') ||
        text.includes('tools are not supported') ||
        text.includes('tool use is not supported') ||
        text.includes('tool calling is not supported') ||
        text.includes('function calling is not supported') ||
        text.includes('no endpoints found that support tool use') ||
        text.includes('no endpoints found that support tools') ||
        (text.includes('try disabling') && text.includes('tool')) ||
        text.includes('try disabling "create_file"') ||
        (text.includes('model_not_found') && text.includes('tool')) ||
        // Groq tool_use_failed
        text.includes('tool_use_failed') ||
        text.includes('failed to call a function') ||
        text.includes('please adjust your prompt')
    );
}

// Cuando Groq devuelve `tool_use_failed`, el cuerpo de la respuesta que el
// modelo intentó emitir va en `failed_generation`. Lo intentamos parsear para
// mostrarle al usuario el contenido (suele ser la respuesta real) en vez de
// dejarle solo "❌ Error".
function extractFailedGeneration(err) {
    const raw = flattenErrorText(err);
    if (!raw) return null;
    // 1. Intento directo: si err.error.failed_generation existe.
    const direct =
        err?.error?.failed_generation ??
        err?.response?.data?.error?.failed_generation ??
        null;
    if (typeof direct === 'string' && direct.trim()) return direct;
    // 2. Buscar el primer JSON dentro del texto y parsearlo.
    const start = raw.indexOf('{');
    if (start === -1) return null;
    const candidate = raw.slice(start);
    try {
        const parsed = JSON.parse(candidate);
        const fg = parsed?.error?.failed_generation;
        return typeof fg === 'string' && fg.trim() ? fg : null;
    } catch {
        // 3. Fallback regex (cuando el JSON está truncado / no es válido).
        const m = raw.match(/"failed_generation"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        if (m && m[1]) {
            try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; }
        }
        return null;
    }
}

// ─── Constantes ───────────────────────────────────────────────────────────────
const SPINNERS       = ['✻', '✼', '✽', '✾', '✿'];
const THINKING_WORDS = ['Thinking','Reasoning','Analyzing','Computing','Marinating','Levitating','Pondering','Brewing'];
const TOOL_ICONS     = { create_file:'●', read_file:'●', edit_file:'●', list_directory:'●', search_in_files:'●', show_diff:'●', apply_patch:'●', run_shell:'●', web_search:'●', list_skills:'●', read_skill:'●', find_skills:'●', add_skill:'●' };
const NEEDS_CONFIRM  = new Set(['run_shell', 'create_file', 'edit_file', 'apply_patch', 'add_skill']);

const toolLabel = (n) => n?.replace(/_/g, ' ') ?? 'tool';
const randWord  = () => THINKING_WORDS[Math.floor(Math.random() * THINKING_WORDS.length)];

// ─── Proveedores ──────────────────────────────────────────────────────────────
const PROVIDERS = [
    { id:'groq',       label:'Groq',           desc:'Ultra-fast inference (LPU)' },
    { id:'openai',     label:'OpenAI',          desc:'GPT-4o, o1, o3…' },
    { id:'anthropic',  label:'Anthropic',       desc:'Claude Sonnet / Opus' },
    { id:'openrouter', label:'OpenRouter',      desc:'Multi-model gateway' },
    { id:'lightning',  label:'Lightning AI',    desc:'OpenAI-compatible gateway' },
    { id:'nvidia',     label:'NVIDIA NIM',      desc:'NVIDIA hosted models' },
    { id:'deepseek',   label:'DeepSeek',        desc:'DeepSeek-V3 / R1' },
    { id:'mistral',    label:'Mistral AI',      desc:'Mixtral, Mistral-Large' },
    { id:'meta',       label:'Meta (Llama)',    desc:'Llama 3.x via API' },
    { id:'ollama',     label:'Ollama (local)',  desc:'Local models, no API key' },
    { id:'huggingface', label:'HuggingFace',     desc:'Download & run HF models via Ollama' },
];

const PROVIDER_MODELS = {
    groq:       ['qwen/qwen3-32b','llama-3.3-70b-versatile','mixtral-8x7b-32768','gemma2-9b-it'],
    openai:     ['gpt-4o','gpt-4o-mini','o1','o3-mini'],
    anthropic:  ['claude-sonnet-4-5','claude-opus-4','claude-haiku-4-5'],
    openrouter: ['openai/gpt-4o','anthropic/claude-3-opus','meta-llama/llama-3-70b'],
    lightning:  ['openai/gpt-5','openai/gpt-5-mini','openai/o3','anthropic/claude-sonnet-4-5-20250929','lightning-ai/DeepSeek-V3.1','lightning-ai/llama-3.3-70b','google/gemini-2.5-pro'],
    nvidia:     ['meta/llama-3.1-70b-instruct','mistralai/mixtral-8x7b-instruct'],
    deepseek:   ['deepseek-chat','deepseek-reasoner'],
    mistral:    ['mistral-large-latest','mistral-medium','codestral-latest'],
    meta:       ['llama-3.3-70b','llama-3.1-405b'],
    ollama:     ['llama3','mistral','qwen2','gemma2','phi3','codellama'],
    huggingface: [],
};

// ─── Componentes base ─────────────────────────────────────────────────────────
const HR = ({ char='─', width=72 }) => <Text color="gray">{char.repeat(width)}</Text>;

const AgentLogo = () => (
    <Box flexDirection="column">
        <Text color="#00FF87"> ▄▀▄ █▀▀ █▀▀ █▄ █ ▀█▀ █   ▄▀▄ █▀▀ </Text>
        <Text color="#00FF87"> █▀█ █ █ █▀▀ █ ▀█  █  █   █▀█ █ █ </Text>
        <Text color="#00FF87"> ▀ ▀ ▀▀▀ ▀▀▀ ▀  ▀  ▀  ▀▀▀ ▀ ▀ ▀▀▀ </Text>
        <Box><Text color="white" bold>  AGENTLAG</Text><Text color="gray">  v{AGENTLAG_VERSION}</Text></Box>
    </Box>
);

const WelcomeBox = ({ provider, model }) => (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={2} paddingY={1} marginBottom={1}>
        <Text bold>Welcome back <Text color="white" bold>Alonso</Text>!</Text>
        <Newline />
        <AgentLogo />
        <Newline />
        <Text bold>AgentLag</Text>
        <Text color="gray">{model || 'model'} · {provider || 'provider'}</Text>
        <Text color="cyan">{process.cwd()}</Text>
    </Box>
);

const ToolLine = ({ name, input, output, running }) => {
    let detail = '';
    if (input) {
        try {
            const p = typeof input === 'string' ? JSON.parse(input) : input;
            detail = p.path || p.command || p.query || p.filename || Object.values(p)[0] || '';
            if (typeof detail !== 'string') detail = JSON.stringify(detail);
            if (detail.length > 55) detail = detail.slice(0, 55) + '…';
        } catch { detail = String(input).slice(0, 55); }
    }
    let outPreview = '';
    if (output) {
        const lines = String(output).trim().split('\n').filter(Boolean);
        outPreview = lines.slice(0, 2).join(' · ');
        if (outPreview.length > 70) outPreview = outPreview.slice(0, 70) + '…';
        if (lines.length > 2) outPreview += ` (+${lines.length - 2} lines)`;
    }
    return (
        <Box flexDirection="column">
            <Box>
                <Text color={running ? 'yellow' : 'green'}>● </Text>
                <Text color={running ? 'yellow' : 'white'} bold>{toolLabel(name)}</Text>
                {detail ? <Text color="gray">({detail})</Text> : null}
                {running ? <Text color="gray"> Running…</Text> : null}
            </Box>
            {outPreview && !running && <Box marginLeft={2}><Text color="gray">⎿  {outPreview}</Text></Box>}
        </Box>
    );
};

const UserMessage    = ({ text }) => (
    <Box flexDirection="column" marginTop={1}>
        <HR />
        <Box><Text color="cyan">❯ </Text><Text wrap="wrap">{text}</Text></Box>
    </Box>
);
const AssistantMessage = ({ text }) => {
    const cleaned = stripMarkdown(text || '');
    const lines = cleaned.split('\n');
    return (
        <Box flexDirection="column" marginTop={1}>
            {lines.map((line, i) => (
                <Box key={i}>
                    {i === 0 ? <Text color="green" bold>● </Text> : <Text>  </Text>}
                    <Text wrap="wrap">{line}</Text>
                </Box>
            ))}
        </Box>
    );
};

const ConfirmDialog = ({ toolName, detail, options, selectedIndex }) => (
    <Box flexDirection="column" marginTop={1} borderStyle="single" borderColor="yellow" paddingX={1}>
        <Text color="yellow" bold>⚠  {toolLabel(toolName)}</Text>
        {detail ? <Text color="gray">   {detail.slice(0, 78)}</Text> : null}
        <Newline />
        <Text color="gray"> Do you want to proceed?</Text>
        {options.map((opt, i) => (
            <Box key={i}>
                {i === selectedIndex
                    ? <Text color="cyan"> ❯ <Text color="white" bold>{(i+1)+'. '+opt}</Text></Text>
                    : <Text color="gray">   {(i+1)+'. '+opt}</Text>}
            </Box>
        ))}
        <Text color="gray" dimColor> Esc to cancel</Text>
    </Box>
);

// ─── Pantallas de setup ───────────────────────────────────────────────────────
const ColorScreen = ({ menuIndex }) => {
    const opts = ['Auto (match terminal)','Dark mode','Light mode','ANSI colors only'];
    return (
        <Box flexDirection="column" paddingX={1} paddingY={1}>
            <Text color="gray">Welcome to AgentLag v{AGENTLAG_VERSION}</Text>
            <Text color="gray">{'…'.repeat(69)}</Text><Newline />
            <AgentLogo />
            <Text color="gray">{'─'.repeat(69)}</Text><Newline />
            <Text>{"Let's get started."}</Text><Newline />
            <Text color="gray"> Choose the text style that looks best with your terminal</Text><Newline />
            {opts.map((o,i) => (
                <Box key={i}>
                    {i===menuIndex
                        ? <Text color="cyan">❯ <Text color="white" bold>{(i+1)+'. '+o}</Text></Text>
                        : <Text color="gray">  {(i+1)+'. '+o}</Text>}
                </Box>
            ))}
            <Newline /><Text color="gray">{'╌'.repeat(69)}</Text>
        </Box>
    );
};

const TrustScreen = ({ menuIndex }) => (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
        <HR /><Newline />
        <Text color="gray"> Accessing workspace:</Text>
        <Text color="cyan"> {process.cwd()}</Text><Newline />
        <Text color="white"> Quick safety check: Is this a project you created or one you trust?</Text>
        <Text color="gray"> (Like your own code, a well-known open source project, or work from your team).</Text>
        <Text color="gray"> If not, take a moment to review what's in this folder first.</Text><Newline />
        <Text color="gray"> AgentLag will be able to read, edit, and execute files here.</Text>
        <Text color="cyan"> Security guide</Text><Newline />
        {['Yes, I trust this folder','No, exit'].map((o,i) => (
            <Box key={i}>
                {i===menuIndex
                    ? <Text color="cyan">❯ <Text color="white" bold>{(i+1)+'. '+o}</Text></Text>
                    : <Text color="gray">  {(i+1)+'. '+o}</Text>}
            </Box>
        ))}
        <Newline /><Text color="gray"> Enter to confirm · Esc to cancel</Text><HR />
    </Box>
);

const ProviderScreen = ({ menuIndex }) => (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
        <AgentLogo /><Newline />
        <Text color="gray">{'─'.repeat(69)}</Text>
        <Text bold> Choose your LLM Provider</Text><Newline />
        {PROVIDERS.map((p,i) => (
            <Box key={p.id}>
                {i===menuIndex
                    ? <Box><Text color="cyan">❯ </Text><Text color="white" bold>{p.label.padEnd(16)}</Text><Text color="gray">{p.desc}</Text></Box>
                    : <Box><Text>  </Text><Text color="gray">{p.label.padEnd(16)}</Text><Text color="gray" dimColor>{p.desc}</Text></Box>}
            </Box>
        ))}
        <Newline /><Text color="gray"> Enter to select · Esc to go back</Text>
        <Text color="gray">{'╌'.repeat(69)}</Text>
    </Box>
);

const ApiKeyScreen = ({ provider, inputText, showError }) => {
    const noKey = provider?.id === 'ollama' || provider?.id === 'huggingface';
    return (
        <Box flexDirection="column" paddingX={1} paddingY={1}>
            <AgentLogo /><Newline />
            <Text color="gray">{'─'.repeat(69)}</Text>
            <Text bold> Enter API Key for <Text color="#00FF87">{provider?.label}</Text></Text><Newline />
            <Text color="gray"> {noKey ? 'No necesita API key — se ejecuta localmente' : 'Your key is stored locally in ~/.agentlag/config.json'}</Text>
            <Newline />
            <Box borderStyle="single" borderColor={showError ? 'red' : 'cyan'} paddingX={1}>
                <Text color="gray">Key: </Text>
                <Text>{noKey ? 'Local' : '*'.repeat(inputText.length)}</Text>
                <Text color="white">█</Text>
            </Box>
            {showError && <Text color="red"> ⚠ API key es requerida para {provider?.label}</Text>}
            <Newline />
            <Text color="gray"> Enter to confirm · Esc to go back</Text>
            <Text color="gray">{'╌'.repeat(69)}</Text>
        </Box>
    );
};

const DownloadScreen = ({ modelName, progress, statusText }) => (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
        <AgentLogo /><Newline />
        <Text color="gray">{'─'.repeat(69)}</Text>
        <Text bold> Descargando modelo de HuggingFace</Text><Newline />
        <Text color="cyan"> {modelName}</Text>
        <Newline />
        <Box>
            <Text color="gray"> [</Text>
            <Text color="green">{'█'.repeat(Math.floor(progress / 2))}</Text>
            <Text color="gray">{'░'.repeat(50 - Math.floor(progress / 2))}</Text>
            <Text color="gray">] </Text>
            <Text color="white">{progress}%</Text>
        </Box>
        <Newline />
        <Text color="gray"> {statusText || 'Descargando...'}</Text>
        <Text color="gray">{'╌'.repeat(69)}</Text>
    </Box>
);

const ModelScreen = ({ provider, menuIndex, inputText, ollamaModels, ollamaStatus }) => {
    const isOllama = provider?.id === 'ollama';
    const isHF = provider?.id === 'huggingface';
    let suggestions;
    if (isOllama) {
        suggestions = ollamaStatus === 'running' ? ollamaModels : [];
    } else {
        suggestions = PROVIDER_MODELS[provider?.id] || [];
    }
    const listLabel = isOllama && ollamaStatus === 'running' ? 'Modelos instalados' : 'Suggestions';
    return (
        <Box flexDirection="column" paddingX={1} paddingY={1}>
            <AgentLogo /><Newline />
            <Text color="gray">{'─'.repeat(69)}</Text>
            <Text bold> {isHF ? 'Escribe el modelo de HuggingFace' : 'Select or type model for'} <Text color="#00FF87">{provider?.label}</Text></Text><Newline />
            {isHF && (
                <Box flexDirection="column">
                    <Text color="gray"> Formato: org/modelo (ej: inclusionai/ling-2.6-1t)</Text>
                    <Text color="gray"> Se descargará via Ollama y se usará localmente.</Text>
                    <Newline />
                </Box>
            )}
            <Box borderStyle="single" borderColor="cyan" paddingX={1}>
                <Text color="gray">Model: </Text><Text>{inputText}</Text><Text color="white">█</Text>
            </Box>
            <Newline />
            {isOllama && ollamaStatus === 'checking' && (
                <Text color="yellow"> ⏳ Verificando conexión con Ollama...</Text>
            )}
            {isOllama && ollamaStatus === 'not_running' && (
                <Box flexDirection="column">
                    <Text color="red"> ⚠ Ollama no está corriendo.</Text>
                    <Text color="gray"> Inicia el servidor con: </Text>
                    <Text color="cyan">   ollama serve</Text>
                    <Newline />
                    <Text color="gray"> Puedes escribir el nombre del modelo manualmente.</Text>
                </Box>
            )}
            {isOllama && ollamaStatus === 'running' && ollamaModels.length === 0 && (
                <Box flexDirection="column">
                    <Text color="yellow"> ⚠ Ollama está corriendo pero no hay modelos descargados.</Text>
                    <Text color="gray"> Descarga uno con: </Text>
                    <Text color="cyan">   ollama pull llama3</Text>
                </Box>
            )}
            {suggestions.length > 0 && (
                <Box flexDirection="column">
                    <Text color="gray"> {listLabel} (↑↓ pick · Enter confirm):</Text>
                    {suggestions.map((m,i) => (
                        <Box key={m}>
                            {i===menuIndex
                                ? <Text color="cyan">  ❯ {m}</Text>
                                : <Text color="gray">    {m}</Text>}
                        </Box>
                    ))}
                </Box>
            )}
            <Newline />
            <Text color="gray"> Enter to confirm · Esc to go back</Text>
            <Text color="gray">{'╌'.repeat(69)}</Text>
        </Box>
    );
};

// ─── Comandos slash ───────────────────────────────────────────────────────────
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const AGENTLAG_VERSION = pkg.version;

const SLASH_COMMANDS = [
    { cmd:'/add-dir',     desc:['Añadir un directorio al workspace de confianza'] },
    { cmd:'/advisor',     desc:['Activar/desactivar modelo asesor para decisiones complejas'] },
    { cmd:'/agents',      desc:['Listar subagentes definidos por el usuario'] },
    { cmd:'/branch',      desc:['Guardar la conversación actual con un nuevo nombre'] },
    { cmd:'/btw',         desc:['Lanzar una pregunta paralela sin romper el flujo'] },
    { cmd:'/clear',       desc:['Limpiar el historial de la conversación'] },
    { cmd:'/color',       desc:['Volver a abrir el selector de tema/color'] },
    { cmd:'/compact',     desc:['Resumir el historial para liberar contexto'] },
    { cmd:'/config',      desc:['Reiniciar y volver a correr el wizard completo'] },
    { cmd:'/context',     desc:['Mostrar uso estimado de contexto/tokens'] },
    { cmd:'/copy',        desc:['Copiar la última respuesta del asistente al portapapeles'] },
    { cmd:'/cwd',         desc:['Mostrar el directorio de trabajo actual'] },
    { cmd:'/diff',        desc:['Mostrar git diff de cambios sin confirmar'] },
    { cmd:'/doctor',      desc:['Ejecutar diagnóstico de la instalación y proveedores'] },
    { cmd:'/download',    desc:['Descargar un modelo de HuggingFace e importar a Ollama'] },
    { cmd:'/effort',      desc:['Ajustar el nivel de esfuerzo del modelo (low|medium|high|xhigh|max)'] },
    { cmd:'/exit',        desc:['Guardar la sesión y salir'] },
    { cmd:'/export',      desc:['Exportar la conversación a un archivo markdown'] },
    { cmd:'/feedback',    desc:['Abrir la página de issues de GitHub para enviar feedback'] },
    { cmd:'/focus',       desc:['Toggle modo focus (oculta tool spam)'] },
    { cmd:'/help',        desc:['Mostrar todos los comandos disponibles'] },
    { cmd:'/hooks',       desc:['Listar hooks configurados (~/.agentlag/hooks.json)'] },
    { cmd:'/ide',         desc:['Mostrar estado de la integración con IDE'] },
    { cmd:'/import',      desc:['Importar una conversación por nombre'] },
    { cmd:'/keybindings', desc:['Mostrar los atajos de teclado disponibles'] },
    { cmd:'/logout',      desc:['Borrar la API key del proveedor activo'] },
    { cmd:'/mcp',         desc:['Listar servidores MCP configurados'] },
    { cmd:'/memory',      desc:['Ver/editar ~/.agentlag/memory.md (notas del proyecto)'] },
    { cmd:'/model',       desc:['Cambiar el modelo activo'] },
    { cmd:'/provider',    desc:['Cambiar el proveedor de LLM activo'] },
    { cmd:'/quit',        desc:['Guardar la sesión y salir'] },
    { cmd:'/react',       desc:['Toggle modo ReAct (forzar fallback sin tools nativas)'] },
    { cmd:'/rename',      desc:['Renombrar la conversación activa'] },
    { cmd:'/resume',      desc:['Reanudar una conversación guardada por nombre'] },
    { cmd:'/sessions',    desc:['Listar conversaciones guardadas en el proyecto'] },
    { cmd:'/skills',      desc:['Listar, leer, buscar o instalar skills de skills.sh'] },
    { cmd:'/version',     desc:['Mostrar la versión de AgentLag'] },
];

const CommandMenu = ({ input, selectedIndex }) => {
    const query    = input.slice(1).toLowerCase();
    const filtered = SLASH_COMMANDS.filter(c => c.cmd.includes(query));
    return (
        <Box flexDirection="column">
            {filtered.map((item,i) => {
                const sel=i===selectedIndex, cc=sel?'cyan':'white', dc=sel?'cyan':'gray';
                const pad=' '.repeat(Math.max(0,18-item.cmd.length));
                return (
                    <Box key={item.cmd} flexDirection="column">
                        <Box><Text color={cc}>{item.cmd}</Text><Text>{pad}</Text><Text color={dc}>{item.desc[0]}</Text></Box>
                        {item.desc[1] && <Box><Text>{' '.repeat(18)}</Text><Text color={dc}>{item.desc[1]}</Text></Box>}
                    </Box>
                );
            })}
        </Box>
    );
};

const ShortcutsHelp = () => (
    <Box flexDirection="column">
        <Text color="gray">  ! for shell mode   double tap esc to clear   ctrl+shift+_ to undo</Text>
    </Box>
);

const HR_FULL = () => <Text color="gray">{'─'.repeat(process.stdout.columns || 80)}</Text>;

// ─── App principal ────────────────────────────────────────────────────────────
const App = ({ config: initCfg }) => {
    const initScreen = () => {
        if (!initCfg.colorSet) return 'color';
        if (!initCfg.trusted) return 'trust';
        if (!initCfg.provider) return 'provider';
        if (!initCfg.model) return 'model';
        return 'main';
    };

    const [screen, setScreen]             = useState(initScreen());
    const [ollamaModels, setOllamaModels] = useState([]);
    const [ollamaStatus, setOllamaStatus] = useState('checking'); // 'checking' | 'running' | 'not_running'
    const [dlProgress, setDlProgress] = useState(0);
    const [dlStatus, setDlStatus] = useState('');
    const [menuIndex, setMenuIndex]       = useState(0);
    const [formInput, setFormInput]       = useState('');
    const [apiKeyError, setApiKeyError]   = useState(false);
    const [selProvider, setSelProvider]   = useState(
        initCfg.provider ? PROVIDERS.find(p => p.id === initCfg.provider) : null
    );
    const [selModel, setSelModel]         = useState(initCfg.model || '');
    const cfg = useRef({ ...initCfg });

    // CLI state
    const [input, setInput]               = useState('');
    const [cmdIndex, setCmdIndex]         = useState(0);
    const [status, setStatus]             = useState('idle');
    const [thinkWord, setThinkWord]       = useState('Thinking');
    const [thinkStart, setThinkStart]     = useState(null);
    const [elapsed, setElapsed]           = useState(0);
    const [spinFrame, setSpinFrame]       = useState(0);
    const [activeTool, setActiveTool]     = useState(null);
    const [pendingConfirm, setPendingConfirm] = useState(null);
    const [confirmIdx, setConfirmIdx]     = useState(0);
    const [totalTokens, setTotalTokens]   = useState(0);
    const [staticHistory, setStaticHistory] = useState([]);
    const msgRef = useRef([]);
    const historyRef = useRef([]);
    const currentConversationRef = useRef(null);
    const [agent, setAgent] = useState(null);

    // Nuevos estados para atajos
    const [isVerbose, setIsVerbose]       = useState(false);
    const [showTasks, setShowTasks]       = useState(false);
    const [focusMode, setFocusMode]       = useState(!!initCfg.focusMode);
    const [effortLevel, setEffortLevel]   = useState(initCfg.effort || 'high');
    const [advisorEnabled, setAdvisorEnabled] = useState(!!initCfg.advisor);
    const [forceReAct, setForceReAct]     = useState(!!initCfg.forceReAct);
    const abortCtrlRef                    = useRef(null);

    // Hooks de layout
    const { stdout } = useStdout();
    const [rows, setRows] = useState(stdout?.rows || 24);

    useEffect(() => {
        if (!stdout) return;
        const h = () => setRows(stdout.rows);
        stdout.on('resize', h);
        return () => stdout.off('resize', h);
    }, [stdout]);

    useEffect(() => {
        historyRef.current = staticHistory;
        const saved = saveSession(staticHistory, currentConversationRef.current);
        if (saved?.name) currentConversationRef.current = saved.name;
    }, [staticHistory]);

    const saveAndExit = useCallback(() => {
        saveSession(historyRef.current, currentConversationRef.current);
        process.exit();
    }, []);

    useEffect(() => {
        const onExit = () => saveSession(historyRef.current, currentConversationRef.current);
        const onSignal = () => saveAndExit();
        process.on('exit', onExit);
        process.on('SIGINT', onSignal);
        process.on('SIGTERM', onSignal);
        return () => {
            process.off('exit', onExit);
            process.off('SIGINT', onSignal);
            process.off('SIGTERM', onSignal);
        };
    }, [saveAndExit]);

    // ── Ciclos ────────────────────────────────────────────────────────────────
    useEffect(() => {
        let t;
        if (status !== 'idle') {
            t = setInterval(() => {
                setSpinFrame(f => (f + 1) % SPINNERS.length);
                if (thinkStart) setElapsed(Math.floor((Date.now() - thinkStart) / 1000));
            }, 100);
        } else {
            setElapsed(0);
        }
        return () => clearInterval(t);
    }, [status, thinkStart]);

    // Inicializar agente y mostrar banner como primer item estático
    useEffect(() => {
        if (screen === 'main' && !agent) {
            setStaticHistory(prev => {
                if (prev.length === 0 || prev[0].type !== 'welcome') {
                    return [{
                        type: 'welcome',
                        provider: selProvider?.label || cfg.current.provider || 'provider',
                        model: selModel || cfg.current.model || 'model',
                    }, ...prev];
                }
                return prev;
            });
            buildAgent().then(setAgent).catch(err => {
                setStaticHistory(prev => [...prev, {type:'assistant', text:'❌ Error al iniciar agente: '+err.message}]);
            });
        }
    }, [screen, agent]);

    const askConfirm = useCallback((toolName, detail) =>
        new Promise(resolve => {
            setConfirmIdx(0);
            setPendingConfirm({ toolName, detail, resolve });
        }), []);

    // ── Helpers para slash commands ───────────────────────────────────────────
    const say = (text, ephemeral = false) => {
        setStaticHistory(prev => [...prev, { type:'assistant', text, ephemeral }]);
    };

    const lastAssistantText = () => {
        for (let i = historyRef.current.length - 1; i >= 0; i--) {
            const item = historyRef.current[i];
            if (item.type === 'assistant' && item.text) return item.text;
        }
        return null;
    };

    const persistFlag = (key, value) => {
        cfg.current = { ...cfg.current, [key]: value };
        saveConfig(cfg.current);
    };

    const rebuildAgentWith = async (overrides = {}) => {
        try {
            const next = await buildAgent(overrides);
            setAgent(next);
            return true;
        } catch (e) {
            say(`❌ Error reconstruyendo el agente: ${e.message}`);
            return false;
        }
    };

    // Devuelve true si el comando fue manejado (consume el input).
    // Devuelve false si no es un slash command conocido (sigue el flujo normal).
    const handleSlashCommand = (trimmed) => {
        if (!trimmed.startsWith('/')) return false;
        const [head, ...rest] = trimmed.split(/\s+/);
        const cmd  = head.toLowerCase();
        const args = rest.join(' ').trim();

        switch (cmd) {
            case '/help': {
                const width = Math.max(...SLASH_COMMANDS.map(c => c.cmd.length));
                const helpText = SLASH_COMMANDS
                    .map(c => `  ${c.cmd.padEnd(width + 2)} ${c.desc.join(' ')}`)
                    .join('\n');
                say(`Comandos disponibles:\n${helpText}`);
                return true;
            }
            case '/version': {
                say(`AgentLag v${AGENTLAG_VERSION}\nNode ${process.version} · ${process.platform}/${process.arch}`);
                return true;
            }
            case '/cwd': {
                say(`📁 ${process.cwd()}`);
                return true;
            }
            case '/exit':
            case '/quit': {
                saveAndExit();
                return true;
            }
            case '/clear': {
                setStaticHistory(prev => prev.filter(i => i.type === 'welcome'));
                msgRef.current = [];
                currentConversationRef.current = null;
                clearLatestSession();
                return true;
            }
            case '/config': {
                cfg.current = {};
                saveConfig({});
                setScreen('color');
                return true;
            }
            case '/color': {
                cfg.current = { ...cfg.current, colorSet: false };
                saveConfig(cfg.current);
                setMenuIndex(0);
                setScreen('color');
                return true;
            }
            case '/provider': {
                cfg.current = { ...cfg.current, provider: null, apiKey: null, model: null };
                saveConfig(cfg.current);
                setMenuIndex(0); setFormInput('');
                setScreen('provider');
                return true;
            }
            case '/model': {
                if (!selProvider) {
                    setScreen('provider');
                } else {
                    setMenuIndex(0); setFormInput('');
                    setScreen('model');
                }
                return true;
            }
            case '/effort': {
                if (!args) {
                    say(`Nivel de esfuerzo actual: ${effortLevel}\nUso: /effort <${EFFORT_LEVELS.join(' | ')}>`);
                    return true;
                }
                const lvl = args.toLowerCase();
                if (!EFFORT_LEVELS.includes(lvl)) {
                    say(`❌ Nivel desconocido "${args}". Opciones: ${EFFORT_LEVELS.join(', ')}.`);
                    return true;
                }
                setEffortLevel(lvl);
                persistFlag('effort', lvl);
                say(`✅ Effort = ${lvl}`);
                return true;
            }
            case '/focus': {
                const next = !focusMode;
                setFocusMode(next);
                persistFlag('focusMode', next);
                say(`🎯 Focus mode: ${next ? 'ON (oculta tools)' : 'OFF'}`);
                return true;
            }
            case '/react': {
                const next = !forceReAct;
                setForceReAct(next);
                persistFlag('forceReAct', next);
                say(`🔁 ReAct forzado: ${next ? 'ON' : 'OFF'}\nReconstruyendo agente…`);
                rebuildAgentWith(next ? { forceReAct: true } : {});
                return true;
            }
            case '/advisor': {
                const next = !advisorEnabled;
                setAdvisorEnabled(next);
                persistFlag('advisor', next);
                say(`🧭 Advisor: ${next ? 'ON' : 'OFF'} (la lógica completa requiere segundo modelo configurado)`);
                return true;
            }
            case '/logout': {
                const provider = cfg.current.provider || 'desconocido';
                cfg.current = { ...cfg.current, apiKey: null };
                saveConfig(cfg.current);
                say(`🔒 API key borrada para ${provider}. Usa /provider para reconfigurar.`);
                return true;
            }
            case '/add-dir': {
                if (!args) { say('Uso: /add-dir <ruta>'); return true; }
                const target = path.resolve(args);
                const trustedDirs = cfg.current.trustedDirs || [];
                if (trustedDirs.includes(target)) {
                    say(`✓ ${target} ya estaba en la lista de confianza.`);
                } else {
                    trustedDirs.push(target);
                    cfg.current = { ...cfg.current, trustedDirs };
                    saveConfig(cfg.current);
                    say(`✅ Directorio añadido a workspace: ${target}\nDirs de confianza:\n  ${trustedDirs.join('\n  ')}`);
                }
                return true;
            }
            case '/copy': {
                const last = lastAssistantText();
                if (!last) { say('⚠ No hay respuesta del asistente para copiar.'); return true; }
                copyToClipboard(last).then(ok => {
                    say(ok
                        ? `📋 Copiado al portapapeles (${last.length} chars).`
                        : `⚠ No se encontró un cliente de portapapeles. Instala xclip / xsel / wl-copy / pbcopy / termux-clipboard-set.\n\n--- contenido ---\n${last}`);
                });
                return true;
            }
            case '/diff': {
                say('⏳ git diff HEAD…');
                runCommand('git', ['diff', 'HEAD']).then(({ ok, output }) => {
                    if (!ok && output.includes('not a git repository')) {
                        say('⚠ Este directorio no es un repo git.');
                    } else {
                        const trimmedOut = output.length > 4000 ? output.slice(0, 4000) + '\n…(truncado)' : output;
                        say(trimmedOut || '(sin cambios pendientes)');
                    }
                });
                return true;
            }
            case '/doctor': {
                const cfgNow = cfg.current || {};
                const lines = [];
                lines.push('🩺 Diagnóstico AgentLag');
                lines.push(`  • Node ${process.version} · ${process.platform}/${process.arch}`);
                lines.push(`  • Versión: ${AGENTLAG_VERSION}`);
                lines.push(`  • cwd: ${process.cwd()}`);
                lines.push(`  • Provider: ${cfgNow.provider || '(sin configurar)'}`);
                lines.push(`  • Modelo: ${cfgNow.model || '(sin configurar)'}`);
                lines.push(`  • API key guardada: ${cfgNow.apiKey ? 'sí' : 'no'}`);
                lines.push(`  • Effort: ${effortLevel}`);
                lines.push(`  • ReAct forzado: ${forceReAct ? 'sí' : 'no'}`);
                lines.push(`  • Tavily key: ${process.env.TAVILY_API_KEY ? 'sí' : 'no'}`);
                lines.push(`  • Mensajes en sesión: ${msgRef.current.length}`);
                say(lines.join('\n'));
                if (cfgNow.provider === 'ollama' || cfgNow.provider === 'huggingface') {
                    isOllamaRunning().then(running => say(`  • Ollama corriendo: ${running ? 'sí' : 'no (ollama serve)'}`));
                }
                return true;
            }
            case '/context': {
                const stats = [];
                stats.push(`📊 Contexto`);
                stats.push(`  • Tokens acumulados: ${totalTokens}`);
                stats.push(`  • Mensajes en memoria: ${msgRef.current.length}`);
                stats.push(`  • Items en historial UI: ${historyRef.current.length}`);
                stats.push(`  • Conversación activa: ${currentConversationRef.current || '(latest)'}`);
                say(stats.join('\n'));
                return true;
            }
            case '/compact': {
                const removed = msgRef.current.length;
                if (removed === 0) { say('Ya estás en contexto vacío.'); return true; }
                const summary = `[resumen automático: ${removed} mensajes previos en esta sesión]`;
                msgRef.current = [new HumanMessage(summary)];
                setStaticHistory(prev => {
                    const welcome = prev.find(i => i.type === 'welcome');
                    return [
                        ...(welcome ? [welcome] : []),
                        { type:'assistant', text:`🗜 Compactados ${removed} mensajes en un resumen.`, ephemeral:true },
                    ];
                });
                setTotalTokens(0);
                return true;
            }
            case '/export': {
                const name = args || `export-${Date.now()}`;
                const safe = normalizeConversationName(name) || `export-${Date.now()}`;
                const dir  = path.join(process.cwd(), '.agentlag', 'exports');
                try { fs.mkdirSync(dir, { recursive: true }); } catch {}
                const file = path.join(dir, `${safe}.md`);
                const lines = ['# AgentLag conversation', '', `_exported: ${new Date().toISOString()}_`, ''];
                for (const item of historyRef.current) {
                    if (item.type === 'user')      lines.push(`## 🧑 user`, '', item.text || '', '');
                    if (item.type === 'assistant') lines.push(`## 🤖 assistant`, '', item.text || '', '');
                    if (item.type === 'tool')      lines.push(`### 🛠 tool · ${item.name}`, '', '```', String(item.output || ''), '```', '');
                }
                try {
                    fs.writeFileSync(file, lines.join('\n'));
                    say(`✅ Exportado a ${file}`);
                } catch (e) {
                    say(`❌ Error exportando: ${e.message}`);
                }
                return true;
            }
            case '/feedback': {
                say(`💬 Envía feedback / bugs:\n  https://github.com/andreslpxz/AgentLag_npm/issues/new\n\nIncluye versión (${AGENTLAG_VERSION}), provider y un resumen.`);
                return true;
            }
            case '/keybindings': {
                say([
                    '⌨  Atajos:',
                    '  Enter            Enviar',
                    '  Shift+Tab        Ciclar modo',
                    '  Esc              Limpiar input · doble Esc limpia historial',
                    '  Ctrl+C           Salir guardando sesión',
                    '  Ctrl+Z           Cancelar la operación en curso',
                    '  Ctrl+O           Toggle verbose',
                    '  Ctrl+T           Toggle tasks',
                    '  Alt+P            Cambiar de modelo',
                    '  !                Modo shell (al inicio del input)',
                    '  @                Mencionar archivo (al inicio del input)',
                    '  /                Menú de comandos (autocomplete)',
                ].join('\n'));
                return true;
            }
            case '/hooks': {
                let data = {};
                try { data = JSON.parse(fs.readFileSync(HOOKS_FILE, 'utf8')); } catch {}
                const entries = Object.entries(data);
                if (entries.length === 0) {
                    say(`🪝 No hay hooks configurados.\nEdita ${HOOKS_FILE} para añadir, ej:\n{\n  "PreToolUse":  ["echo about to run a tool"],\n  "PostToolUse": ["echo finished"]\n}`);
                } else {
                    const lines = ['🪝 Hooks configurados:'];
                    for (const [event, cmds] of entries) {
                        lines.push(`  • ${event}: ${(Array.isArray(cmds) ? cmds : [cmds]).join(' ; ')}`);
                    }
                    say(lines.join('\n'));
                }
                return true;
            }
            case '/mcp': {
                let data = {};
                try { data = JSON.parse(fs.readFileSync(MCP_FILE, 'utf8')); } catch {}
                const servers = Object.entries(data?.mcpServers || {});
                if (servers.length === 0) {
                    say(`🔌 No hay servidores MCP configurados.\nCrea ${MCP_FILE} con:\n{\n  "mcpServers": {\n    "playwright": { "command": "npx", "args": ["-y","@playwright/mcp@latest"] }\n  }\n}`);
                } else {
                    const lines = ['🔌 MCP servers:'];
                    for (const [name, def] of servers) {
                        lines.push(`  • ${name}: ${def.command || ''} ${(def.args || []).join(' ')}`);
                    }
                    say(lines.join('\n'));
                }
                return true;
            }
            case '/agents': {
                let entries = [];
                try { entries = fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.json')); } catch {}
                if (entries.length === 0) {
                    say(`🤖 No hay subagentes definidos.\nCrea archivos en ${AGENTS_DIR}/<nombre>.json con { "description": "...", "systemPrompt": "..." }`);
                } else {
                    const lines = ['🤖 Subagentes:'];
                    for (const f of entries) {
                        try {
                            const def = JSON.parse(fs.readFileSync(path.join(AGENTS_DIR, f), 'utf8'));
                            lines.push(`  • ${path.basename(f, '.json')} — ${def.description || '(sin descripción)'}`);
                        } catch {
                            lines.push(`  • ${path.basename(f, '.json')} — (archivo inválido)`);
                        }
                    }
                    say(lines.join('\n'));
                }
                return true;
            }
            case '/ide': {
                const term = process.env.TERM_PROGRAM || process.env.TERM || 'unknown';
                const inIDE = !!(process.env.VSCODE_INJECTION || process.env.CURSOR_TRACE_ID || process.env.JETBRAINS_IDE);
                say(`💻 IDE/terminal: ${term}\n  • Detectado dentro de IDE: ${inIDE ? 'sí' : 'no'}\n  • La integración profunda con IDEs aún no está implementada.`);
                return true;
            }
            case '/memory': {
                let content = '';
                try { content = fs.readFileSync(MEMORY_FILE, 'utf8'); } catch {}
                if (!args) {
                    if (!content.trim()) {
                        say(`🧠 Memoria vacía. Crea/edita ${MEMORY_FILE} o usa:\n  /memory add <nota>     añade una línea`);
                    } else {
                        say(`🧠 Memoria (${MEMORY_FILE}):\n\n${content.trim()}`);
                    }
                    return true;
                }
                const sub = rest[0]?.toLowerCase();
                const note = rest.slice(1).join(' ').trim();
                if (sub === 'add' && note) {
                    try { ensureDir(); } catch {}
                    fs.appendFileSync(MEMORY_FILE, `- ${note}\n`);
                    say(`✅ Añadido a memoria: ${note}`);
                } else if (sub === 'clear') {
                    try { fs.writeFileSync(MEMORY_FILE, ''); } catch {}
                    say('🧹 Memoria limpiada.');
                } else {
                    say('Uso: /memory  ·  /memory add <nota>  ·  /memory clear');
                }
                return true;
            }
            case '/sessions': {
                const list = listConversations();
                if (list.length === 0) say('Sin sesiones guardadas en este proyecto.');
                else say(`💾 Sesiones:\n  ${list.join('\n  ')}\n\nUsa /resume <nombre> o /import <nombre>.`);
                return true;
            }
            case '/skills': {
                const [subRaw, ...subArgs] = rest;
                const sub = (subRaw || 'list').toLowerCase();
                const tail = subArgs.join(' ').trim();

                if (sub === 'list') {
                    say(`🧩 Skills instaladas:\n${formatSkillsIndex(process.cwd())}`);
                    return true;
                }

                if (sub === 'read') {
                    if (!tail) {
                        say('Uso: /skills read <nombre>\nEjemplo: /skills read find-skills');
                        return true;
                    }
                    const skill = readSkill(tail, process.cwd());
                    if (!skill) say(`⚠ No encontré la skill "${tail}". Usa /skills list.`);
                    else say(`📘 ${skill.name} (${skill.scope})\n${skill.path}\n\n${skill.content}`);
                    return true;
                }

                if (sub === 'find' || sub === 'search') {
                    if (!tail) {
                        say('Uso: /skills find <consulta>\nEjemplo: /skills find image optimization');
                        return true;
                    }
                    say(`⏳ Buscando skills: ${tail}`, true);
                    runCommand('npx', ['-y', 'skills', 'find', tail]).then(({ code, output }) => {
                        const clean = output.trim() || '(sin salida)';
                        say(code === 0 ? clean : `❌ Error buscando skills:\n${clean}`);
                    });
                    return true;
                }

                if (sub === 'add' || sub === 'install') {
                    const parsedArgs = splitCommandArgs(subArgs.join(' '));
                    const source = parsedArgs[0];
                    if (!source) {
                        say('Uso: /skills add <source> [--skill nombre] [--global] [--copy]\nEjemplo: /skills add https://github.com/vercel-labs/skills --skill find-skills');
                        return true;
                    }
                    const extra = parsedArgs.slice(1);
                    say(`⏳ Instalando skill desde ${source}…`, true);
                    runCommand('npx', ['-y', 'skills', 'add', source, '-y', ...extra]).then(({ code, output }) => {
                        const clean = output.trim() || '(sin salida)';
                        say(code === 0 ? clean : `❌ Error instalando skill:\n${clean}`);
                        if (code === 0) {
                            clearSkillsCache();
                            rebuildAgentWith();
                        }
                    });
                    return true;
                }

                if (sub === 'check' || sub === 'update') {
                    say(`⏳ Ejecutando skills ${sub}…`, true);
                    runCommand('npx', ['-y', 'skills', sub, '-y']).then(({ code, output }) => {
                        const clean = output.trim() || '(sin salida)';
                        say(code === 0 ? clean : `❌ Error en skills ${sub}:\n${clean}`);
                        if (code === 0) {
                            clearSkillsCache();
                            rebuildAgentWith();
                        }
                    });
                    return true;
                }

                say([
                    'Uso:',
                    '  /skills list',
                    '  /skills read <nombre>',
                    '  /skills find <consulta>',
                    '  /skills add <source> [--skill nombre] [--global] [--copy]',
                    '  /skills update',
                ].join('\n'));
                return true;
            }
            case '/resume':
            case '/import': {
                const importName = args;
                const s = loadSession(importName);
                if (s.history?.length) {
                    currentConversationRef.current = s.name || normalizeConversationName(importName) || currentConversationRef.current;
                    msgRef.current = s.history.map(m =>
                        m.type === 'user' ? new HumanMessage(m.text) : new AIMessage(m.text)
                    );
                    const welcome = historyRef.current.find(i => i.type === 'welcome');
                    setStaticHistory([
                        ...(welcome ? [welcome] : []),
                        ...s.history,
                        { type:'assistant', text:`Historial importado: ${s.name || importName || 'latest'}.`, ephemeral:true },
                    ]);
                } else {
                    const available = listConversations();
                    const suffix = available.length ? `\nDisponibles: ${available.join(', ')}` : '';
                    say(`No hay historial para importar${importName ? `: ${importName}` : ' en este proyecto'}.${suffix}`, true);
                }
                return true;
            }
            case '/rename': {
                if (!args) { say('Uso: /rename <nuevo-nombre>'); return true; }
                const next = normalizeConversationName(args);
                if (!next) { say('❌ Nombre inválido.'); return true; }
                currentConversationRef.current = next;
                const saved = saveSession(historyRef.current, next);
                say(`✅ Conversación renombrada a "${saved?.name || next}".`);
                return true;
            }
            case '/branch': {
                const branchName = args ? normalizeConversationName(args) : `${currentConversationRef.current || 'branch'}-${Date.now().toString(36)}`;
                const saved = saveSession(historyRef.current, branchName);
                if (saved?.name) {
                    currentConversationRef.current = saved.name;
                    say(`🌿 Branch creado: ${saved.name}. La conversación actual ahora se guarda con ese nombre.`);
                } else {
                    say('⚠ No hay nada que ramificar todavía.');
                }
                return true;
            }
            case '/btw': {
                say(args
                    ? `📝 Nota lateral: ${args}`
                    : '📝 Modo nota / side question. Escribe la pregunta paralela como un mensaje normal — no romperá el flujo principal.');
                return true;
            }
            default:
                return false;
        }
    };

    // ── Input ─────────────────────────────────────────────────────────────────
    useInput((str, key) => {
        if (key.ctrl && str === 'c') saveAndExit();

        if (screen === 'color') {
            if (key.upArrow)   setMenuIndex(i => Math.max(0, i-1));
            if (key.downArrow) setMenuIndex(i => Math.min(3, i+1));
            if (key.return) {
                cfg.current = { ...cfg.current, colorSet:true, colorMode:menuIndex };
                saveConfig(cfg.current);
                setMenuIndex(0); setScreen('trust');
            }
            return;
        }
        if (screen === 'trust') {
            if (key.upArrow)   setMenuIndex(i => Math.max(0, i-1));
            if (key.downArrow) setMenuIndex(i => Math.min(1, i+1));
            if (key.escape || (key.return && menuIndex===1)) saveAndExit();
            if (key.return && menuIndex===0) {
                const trustedDirs = cfg.current.trustedDirs || [];
                if (!trustedDirs.includes(process.cwd())) trustedDirs.push(process.cwd());
                cfg.current = { ...cfg.current, trustedDirs, trusted: true };
                saveConfig(cfg.current);
                setMenuIndex(0);

                // Si ya teníamos provider y model, saltamos directo a main
                if (cfg.current.provider && cfg.current.model) {
                    setScreen('main');
                } else {
                    setScreen('provider');
                }
            }
            return;
        }
        if (screen === 'provider') {
            if (key.upArrow)   setMenuIndex(i => Math.max(0, i-1));
            if (key.downArrow) setMenuIndex(i => Math.min(PROVIDERS.length-1, i+1));
            if (key.return) {
                const selected = PROVIDERS[menuIndex];
                setSelProvider(selected);
                if (selected.id === 'ollama') {
                    setOllamaStatus('checking');
                    isOllamaRunning().then(running => {
                        setOllamaStatus(running ? 'running' : 'not_running');
                        if (running) fetchOllamaModels().then(setOllamaModels);
                    });
                }
                setMenuIndex(0); setFormInput(''); setScreen('apikey');
            }
            return;
        }
        if (screen === 'apikey') {
            if (key.escape) { setScreen('provider'); setFormInput(''); setApiKeyError(false); return; }
            if (key.return) {
                const noKeyNeeded = selProvider?.id === 'ollama' || selProvider?.id === 'huggingface';
                const apiKey = noKeyNeeded ? 'local' : formInput.trim();
                if (!noKeyNeeded && !apiKey) {
                    setApiKeyError(true);
                    return;
                }
                setApiKeyError(false);
                cfg.current = { ...cfg.current, provider:selProvider.id, apiKey };
                saveConfig(cfg.current);
                setFormInput(''); setMenuIndex(0); setScreen('model');
                return;
            }
            if (key.backspace||key.delete) { setFormInput(p=>p.slice(0,-1)); return; }
            if (str && !key.ctrl && !key.meta) setFormInput(p=>p+str);
            return;
        }
        if (screen === 'downloading') {
            // No input during download
            return;
        }
        if (screen === 'model') {
            let sugg;
            if (selProvider?.id === 'ollama') {
                sugg = ollamaStatus === 'running' ? ollamaModels : [];
            } else {
                sugg = PROVIDER_MODELS[selProvider?.id] || [];
            }
            if (key.escape) { setScreen('apikey'); setFormInput(''); return; }
            if (key.upArrow)   { setMenuIndex(i=>Math.max(0,i-1)); return; }
            if (key.downArrow) { setMenuIndex(i=>Math.min(sugg.length-1,i+1)); return; }
            if (key.return) {
                const model = formInput.trim() || sugg[menuIndex] || '';
                if (!model) return;

                if (selProvider?.id === 'huggingface') {
                    const hfRepo = model.replace(/^hf\.co\//, '');
                    setDlProgress(0);
                    setDlStatus('Descargando desde HuggingFace...');
                    setScreen('downloading');

                    const dlProc = spawn('python3', ['-m', 'huggingface_hub.commands.huggingface_cli', 'download', hfRepo], {
                        stdio: ['ignore', 'pipe', 'pipe'],
                        env: { ...process.env, HF_HUB_ENABLE_HF_TRANSFER: '1' },
                    });
                    let dlOutput = '';
                    let cachePath = '';
                    const parseDlProgress = (data) => {
                        const text = data.toString();
                        dlOutput += text;
                        const pctMatch = text.match(/(\d+)%/);
                        if (pctMatch) setDlProgress(Math.min(parseInt(pctMatch[1]), 90));
                        const line = text.trim().split('\n').pop() || '';
                        if (line) setDlStatus(line.substring(0, 60));
                    };
                    dlProc.stdout.on('data', d => { cachePath += d.toString(); parseDlProgress(d); });
                    dlProc.stderr.on('data', parseDlProgress);
                    dlProc.on('close', code => {
                        if (code !== 0) {
                            const errMsg = dlOutput.includes('not found')
                                ? 'Modelo no encontrado en HuggingFace.'
                                : `Error en descarga (código ${code}).`;
                            setDlStatus(`${errMsg} Instala: pip install huggingface-hub`);
                            setTimeout(() => { setFormInput(''); setScreen('model'); }, 4000);
                            return;
                        }
                        setDlProgress(90);
                        setDlStatus('Importando modelo a Ollama...');
                        const modelDir = cachePath.trim();
                        const modelName = hfRepo.replace(/\//g, '-').toLowerCase();

                        // Crear Modelfile e importar a Ollama
                        const modelfilePath = path.join(os.tmpdir(), `Modelfile_${Date.now()}`);
                        fs.writeFileSync(modelfilePath, `FROM ${modelDir}\n`);
                        const createProc = spawn('ollama', ['create', modelName, '-f', modelfilePath], {
                            stdio: ['ignore', 'pipe', 'pipe'],
                        });
                        let createOutput = '';
                        createProc.stdout.on('data', d => { createOutput += d.toString(); });
                        createProc.stderr.on('data', d => {
                            createOutput += d.toString();
                            const line = d.toString().trim().split('\n').pop() || '';
                            if (line) setDlStatus(line.substring(0, 60));
                        });
                        createProc.on('close', code2 => {
                            try { fs.unlinkSync(modelfilePath); } catch {}
                            if (code2 === 0) {
                                setDlProgress(100);
                                setDlStatus('Modelo listo!');
                                setSelModel(modelName);
                                cfg.current = { ...cfg.current, provider: 'ollama', model: modelName };
                                saveConfig(cfg.current);
                                setTimeout(() => { setFormInput(''); setScreen('main'); }, 1000);
                            } else {
                                setDlStatus(`Error al importar: ${createOutput.trim().substring(0, 50)}`);
                                setTimeout(() => { setFormInput(''); setScreen('model'); }, 4000);
                            }
                        });
                    });
                    dlProc.on('error', err => {
                        setDlStatus(`python3 no encontrado. Instala: pip install huggingface-hub`);
                        setTimeout(() => { setFormInput(''); setScreen('model'); }, 4000);
                    });
                    return;
                }

                setSelModel(model);
                cfg.current = { ...cfg.current, model };
                saveConfig(cfg.current);
                setFormInput(''); setScreen('main');
                return;
            }
            if (key.backspace||key.delete) { setFormInput(p=>p.slice(0,-1)); setMenuIndex(0); return; }
            if (str && !key.ctrl && !key.meta) { setFormInput(p=>p+str); setMenuIndex(0); }
            return;
        }

        // ── main ──────────────────────────────────────────────────────────────

        if (screen === 'main') {
            if (str === '!' && input === '') { setInput('! '); return; }
            if (str === '@' && input === '') { setInput('@ '); return; }
            if (key.ctrl && str === 'o') {
                setIsVerbose(p => {
                    const next = !p;
                    setStaticHistory(prev => [...prev, { type: 'assistant', text: `ℹ️ Verbose mode is now ${next ? 'ON' : 'OFF'}` }]);
                    return next;
                });
                return;
            }
            if (key.ctrl && str === 't') {
                setShowTasks(p => {
                    const next = !p;
                    setStaticHistory(prev => [...prev, { type: 'assistant', text: `ℹ️ Tasks mode is now ${next ? 'ON' : 'OFF'}` }]);
                    return next;
                });
                return;
            }
        }


        // Shortcuts en main
        if (screen === 'main') {
            // alt+p para cambiar modelo
            if (key.meta && str === 'p') {
                setFormInput('');
                setMenuIndex(0);
                setScreen('model');
                return;
            }
            // doble esc para clear: podemos simularlo si key.escape pasa 2 veces rapido
            // Pero como escape ya limpia el input, es mas simple limpiar input primero,
            // y si ya esta vacio limpiar el historial.
            if (key.escape) {
                if (input === '') {
                    setStaticHistory(prev => prev.filter(i => i.type === 'welcome'));
                    msgRef.current = []; currentConversationRef.current = null; clearLatestSession();
                } else {
                    setInput(''); setCmdIndex(0);
                }
                return;
            }
        }

        if (pendingConfirm) {
            if (key.upArrow)   setConfirmIdx(i=>Math.max(0,i-1));
            if (key.downArrow) setConfirmIdx(i=>Math.min(2,i+1));
            if (key.escape)    { pendingConfirm.resolve(false); setPendingConfirm(null); return; }
            if (key.return) {
                pendingConfirm.resolve(confirmIdx !== 2);
                setPendingConfirm(null); setConfirmIdx(0);
            }
            return;
        }

        if (status !== 'idle') {
            if (key.ctrl && str === 'z') {
                if (abortCtrlRef.current) {
                    abortCtrlRef.current.abort();
                }
                setStatus('idle');
                setActiveTool(null);
                setThinkStart(null);
                setStaticHistory(prev => [...prev, { type: 'assistant', text: '🛑 Ejecución cancelada por el usuario.' }]);
                return;
            }
            if (key.escape) { /* abort TODO */ }
            return;
        }

        if (input.startsWith('/')) {
            if (key.upArrow)   { setCmdIndex(i=>Math.max(0,i-1)); return; }
            if (key.downArrow) { setCmdIndex(i=>Math.min(SLASH_COMMANDS.length-1,i+1)); return; }
        }

        if (key.return) {
            const trimmed = input.trim();
            if (!trimmed) return;
            const handled = handleSlashCommand(trimmed);
            if (handled === true) { setInput(''); setCmdIndex(0); return; }
            // false = no era slash command; null = lo manejó pero queremos seguir flow

            if (trimmed.startsWith('/download')) {
                const modelName = trimmed.replace('/download', '').trim().replace(/^hf\.co\//, '');
                if (!modelName) {
                    setStaticHistory(prev => [...prev, { type:'assistant', text:'Uso: /download org/modelo\nEjemplo: /download inclusionai/ling-2.6-1t\n\nDescarga un modelo de HuggingFace e importa a Ollama.' }]);
                    setInput(''); return;
                }
                setStaticHistory(prev => [...prev, { type:'assistant', text:`⏳ Descargando modelo: ${modelName}\n   via huggingface-cli download\n   Esto puede tardar varios minutos...` }]);
                setInput('');
                const dlProc = spawn('python3', ['-m', 'huggingface_hub.commands.huggingface_cli', 'download', modelName], {
                    stdio: ['ignore', 'pipe', 'pipe'],
                    env: { ...process.env, HF_HUB_ENABLE_HF_TRANSFER: '1' },
                });
                let dlOutput = '';
                let cachePath = '';
                dlProc.stdout.on('data', d => { cachePath += d.toString(); });
                dlProc.stderr.on('data', d => { dlOutput += d.toString(); });
                dlProc.on('close', code => {
                    if (code !== 0) {
                        setStaticHistory(prev => [...prev, { type:'assistant', text:`❌ Error al descargar: ${dlOutput.trim() || `código ${code}`}\n\nAsegúrate de tener huggingface-cli: pip install huggingface-hub` }]);
                        return;
                    }
                    setStaticHistory(prev => [...prev, { type:'assistant', text:`⏳ Importando a Ollama...` }]);
                    const modelDir = cachePath.trim();
                    const ollamaName = modelName.replace(/\//g, '-').toLowerCase();
                    const modelfilePath = path.join(os.tmpdir(), `Modelfile_${Date.now()}`);
                    fs.writeFileSync(modelfilePath, `FROM ${modelDir}\n`);
                    const createProc = spawn('ollama', ['create', ollamaName, '-f', modelfilePath], {
                        stdio: ['ignore', 'pipe', 'pipe'],
                    });
                    let createOutput = '';
                    createProc.stdout.on('data', d => { createOutput += d.toString(); });
                    createProc.stderr.on('data', d => { createOutput += d.toString(); });
                    createProc.on('close', code2 => {
                        try { fs.unlinkSync(modelfilePath); } catch {}
                        if (code2 === 0) {
                            setStaticHistory(prev => [...prev, { type:'assistant', text:`✅ Modelo ${ollamaName} listo!\n\nUsa /config para seleccionarlo como modelo activo.` }]);
                        } else {
                            setStaticHistory(prev => [...prev, { type:'assistant', text:`❌ Error al importar a Ollama: ${createOutput.trim().substring(0, 100)}\n\nAsegúrate de que Ollama está corriendo.` }]);
                        }
                    });
                });
                dlProc.on('error', () => {
                    setStaticHistory(prev => [...prev, { type:'assistant', text:`❌ python3 o huggingface-hub no encontrado.\nInstala con: pip install huggingface-hub` }]);
                });
                return;
            }
            if (trimmed.startsWith('/')) {
                const q = trimmed.slice(1).toLowerCase();
                const m = SLASH_COMMANDS.filter(c=>c.cmd.includes(q))[cmdIndex];
                if (m) { setInput(m.cmd+' '); setCmdIndex(0); return; }
            }
            setInput(''); setCmdIndex(0);
            handleSend(trimmed);
            return;
        }

        if (key.backspace||key.delete) { setInput(p => p.slice(0, -1)); setCmdIndex(0); return; }
        if (str && !key.ctrl && !key.meta) {
            setInput(p => p + str); setCmdIndex(0);
        }
    });

    // ── Agente ────────────────────────────────────────────────────────────────
    const handleSend = useCallback(async (msg) => {
        if (!agent) {
            setStaticHistory(prev => [...prev, { type:'assistant', text:'❌ El agente aún no está inicializado.' }]);
            return;
        }
        setStaticHistory(prev => [...prev, { type:'user', text:msg }]);
        setThinkWord(randWord()); setThinkStart(Date.now()); setElapsed(0);
        setStatus('thinking'); setActiveTool(null);

        msgRef.current = [...msgRef.current, new HumanMessage(msg)];

        abortCtrlRef.current = new AbortController();

        try {
            const stream = await agent.stream(
                { messages: msgRef.current },
                { recursionLimit: 30, signal: abortCtrlRef.current.signal }
            );
            const allChunks = [];
            let pendingTC = null;

            for await (const chunk of stream) {
                allChunks.push(chunk);

                if (chunk.agent) {
                    let last = chunk.agent.messages?.at(-1);
                    // Salvamento preventivo: si el modelo no dio tool_calls pero el contenido parece uno
                    if (last && (!last.tool_calls || last.tool_calls.length === 0)) {
                        const salvaged = trySalvageToolCall(last);
                        if (salvaged) last = salvaged;
                    }

                    if (last?.tool_calls?.length > 0) {
                        const tc = last.tool_calls[0];
                        pendingTC = { name:tc.name, args:tc.args };

                        if (NEEDS_CONFIRM.has(tc.name)) {
                            let detail = '';
                            try {
                                const a = tc.args;
                                detail = a.path||a.command||a.filename||JSON.stringify(a).slice(0,80);
                            } catch {}
                            setStatus('idle');
                            const ok = await askConfirm(tc.name, detail);
                            if (!ok) {
                                setStaticHistory(prev=>[...prev,{type:'assistant',text:'⚠ Acción cancelada por el usuario.'}]);
                                setStatus('idle'); return;
                            }
                        }

                        setStatus('running');
                        setActiveTool({ name:tc.name, input:tc.args });
                        setThinkWord(randWord()); setThinkStart(Date.now());
                    } else {
                        setStatus('thinking'); setActiveTool(null);
                    }

                    // Tokens
                    const usage = last?.response_metadata?.token_usage || last?.usage_metadata;
                    if (usage) {
                        const t = usage.total_tokens || (usage.input_tokens||0)+(usage.output_tokens||0);
                        if (t) setTotalTokens(prev=>prev+t);
                    }
                }

                if (chunk.tools) {
                    for (const tm of (chunk.tools.messages||[])) {
                        if (tm.name && tm.content !== undefined) {
                            setStaticHistory(prev=>[...prev,{
                                type:'tool', name:tm.name,
                                input: pendingTC?.name===tm.name ? pendingTC.args : null,
                                output:tm.content, running:false,
                            }]);
                            setActiveTool(null);
                            setStatus('thinking'); setThinkWord(randWord()); setThinkStart(Date.now());
                        }
                    }
                }
            }

            // Respuesta final
            let responseText = '';
            for (let i=allChunks.length-1; i>=0; i--) {
                const nd = allChunks[i].agent || allChunks[i].tools;
                if (!nd?.messages) continue;
                for (let j=nd.messages.length-1; j>=0; j--) {
                    const m=nd.messages[j];
                    if (m instanceof AIMessage && typeof m.content==='string' && m.content.trim()) {
                        responseText=m.content.trim(); break;
                    }
                }
                if (responseText) break;
            }

            const allMsgs=[];
            for (const c of allChunks)
                for (const nk of ['agent','tools'])
                    if (c[nk]?.messages) allMsgs.push(...c[nk].messages);
            msgRef.current=[...msgRef.current,...allMsgs];

            if (responseText) {
                const cleaned = stripMarkdown(responseText);
                setStaticHistory(prev=>[...prev,{type:'assistant',text:cleaned}]);
            }

        } catch(err) {
            if (isToolUnsupportedError(err)) {
                // Si Groq devolvió `tool_use_failed`, el contenido que el modelo
                // intentó emitir suele ir en `failed_generation`. Lo
                // recuperamos y lo enseñamos como respuesta del asistente
                // antes de cambiar a ReAct, así el usuario no pierde el
                // turno.
                const salvaged = extractFailedGeneration(err);
                if (salvaged) {
                    setStaticHistory(prev=>[...prev,{
                        type:'assistant',
                        text: salvaged,
                    }]);
                    msgRef.current = [...msgRef.current, new AIMessage(salvaged)];
                }
                setStaticHistory(prev=>[...prev,{
                    type:'assistant',
                    text: salvaged
                        ? 'ℹ️ El proveedor falló al emitir tool calls; activando modo ReAct para los próximos turnos…'
                        : '⚠️ El proveedor no expone tool calling para este modelo. Cambiando a modo ReAct…'
                }]);
                try {
                    const reactAgent = await buildAgent({ forceReAct: true });
                    setAgent(reactAgent);
                    setForceReAct(true);
                    persistFlag('forceReAct', true);
                    // Si pudimos rescatar la respuesta, ya cumplimos el turno;
                    // no reintentamos la misma pregunta para no duplicar.
                    if (salvaged) { return; }
                    // Reintentar con el agente ReAct
                    setStatus('thinking'); setThinkWord(randWord()); setThinkStart(Date.now());
                    const retryStream = await reactAgent.stream(
                        { messages: msgRef.current },
                        { recursionLimit: 30, signal: abortCtrlRef.current.signal }
                    );
                    const retryChunks = [];
                    let retryPendingTC = null;
                    for await (const chunk of retryStream) {
                        retryChunks.push(chunk);
                        if (chunk.agent) {
                            const last = chunk.agent.messages?.at(-1);
                            if (last?.tool_calls?.length > 0) {
                                const tc = last.tool_calls[0];
                                retryPendingTC = { name:tc.name, args:tc.args };
                                if (NEEDS_CONFIRM.has(tc.name)) {
                                    let detail = '';
                                    try { const a=tc.args; detail=a.path||a.command||a.filename||JSON.stringify(a).slice(0,80); } catch {}
                                    setStatus('idle');
                                    const ok = await askConfirm(tc.name, detail);
                                    if (!ok) {
                                        setStaticHistory(prev=>[...prev,{type:'assistant',text:'⚠ Acción cancelada.'}]);
                                        setStatus('idle'); return;
                                    }
                                }
                                setStatus('running');
                                setActiveTool({ name:tc.name, input:tc.args });
                                setThinkWord(randWord()); setThinkStart(Date.now());
                            } else {
                                setStatus('thinking'); setActiveTool(null);
                            }
                        }
                        if (chunk.tools) {
                            for (const tm of (chunk.tools.messages||[])) {
                                if (tm.name && tm.content !== undefined) {
                                    setStaticHistory(prev=>[...prev,{
                                        type:'tool', name:tm.name,
                                        input: retryPendingTC?.name===tm.name ? retryPendingTC.args : null,
                                        output:tm.content, running:false,
                                    }]);
                                    setActiveTool(null);
                                    setStatus('thinking'); setThinkWord(randWord()); setThinkStart(Date.now());
                                }
                            }
                        }
                    }
                    let retryText = '';
                    for (let i=retryChunks.length-1; i>=0; i--) {
                        const nd = retryChunks[i].agent || retryChunks[i].tools;
                        if (!nd?.messages) continue;
                        for (let j=nd.messages.length-1; j>=0; j--) {
                            const m=nd.messages[j];
                            if (m instanceof AIMessage && typeof m.content==='string' && m.content.trim()) {
                                retryText=m.content.trim(); break;
                            }
                        }
                        if (retryText) break;
                    }
                    const retryMsgs=[];
                    for (const c of retryChunks)
                        for (const nk of ['agent','tools'])
                            if (c[nk]?.messages) retryMsgs.push(...c[nk].messages);
                    msgRef.current=[...msgRef.current,...retryMsgs];
                    if (retryText) {
                        const cleaned = stripMarkdown(retryText);
                        setStaticHistory(prev=>[...prev,{type:'assistant',text:cleaned}]);
                    }
                } catch (reactErr) {
                    setStaticHistory(prev=>[...prev,{type:'assistant',text:`❌ Error (ReAct): ${reactErr.message}`}]);
                }
            } else {
                setStaticHistory(prev=>[...prev,{type:'assistant',text:`❌ Error: ${err.message || err}`}]);
            }
        } finally {
            setStatus('idle'); setActiveTool(null); setThinkStart(null); setElapsed(0);
        }
    }, [agent, askConfirm]);

    // ── Render ────────────────────────────────────────────────────────────────
    if (screen==='color')    return <ColorScreen    menuIndex={menuIndex} />;
    if (screen==='trust')    return <TrustScreen    menuIndex={menuIndex} />;
    if (screen==='provider') return <ProviderScreen menuIndex={menuIndex} />;
    if (screen==='apikey')   return <ApiKeyScreen   provider={selProvider} inputText={formInput} showError={apiKeyError} />;
    if (screen==='downloading') return <DownloadScreen modelName={formInput || selModel} progress={dlProgress} statusText={dlStatus} />;
    if (screen==='model')    return <ModelScreen    provider={selProvider} menuIndex={menuIndex} inputText={formInput} ollamaModels={ollamaModels} ollamaStatus={ollamaStatus} />;

    const isWorking  = status !== 'idle';
    const spinner    = SPINNERS[spinFrame];
    const timeStr    = elapsed > 0 ? ` (${elapsed}s)` : '';
    const tokenStr   = totalTokens > 0 ? ` · ↓ ${totalTokens} tokens` : '';
    const CONFIRM_OPTS = ['Yes', "Yes, allow all for this session", 'No'];

    return (
        <Box flexDirection="column">
            <Static items={focusMode ? staticHistory.filter(i => i.type !== 'tool') : staticHistory}>
                {(item, index) => {
                    if (item.type==='welcome')   return (
                        <WelcomeBox key="welcome" provider={item.provider} model={item.model} />
                    );
                    if (item.type==='user')      return <UserMessage      key={index} text={item.text} />;
                    if (item.type==='assistant') return <AssistantMessage key={index} text={item.text} />;
                    if (item.type==='tool')      return (
                        <Box key={index} marginTop={1}>
                            <ToolLine name={item.name} input={item.input} output={item.output} running={false} />
                        </Box>
                    );
                    return null;
                }}
            </Static>

            {/* Parte activa (no estática) que siempre está al final */}
            <Box flexDirection="column">
                {/* Herramienta activa */}
                {activeTool && (
                    <Box marginTop={1}>
                        <ToolLine name={activeTool.name} input={activeTool.input} running={true} />
                    </Box>
                )}

                {/* Spinner */}
                {isWorking && !pendingConfirm && (
                    <Box marginTop={1}>
                        <Text color="yellow">{spinner} </Text>
                        <Text color="yellow">{thinkWord}…</Text>
                        <Text color="gray">{timeStr}{tokenStr}</Text>
                    </Box>
                )}

                {/* Confirmación */}
                {pendingConfirm && (
                    <ConfirmDialog
                        toolName={pendingConfirm.toolName}
                        detail={pendingConfirm.detail}
                        options={CONFIRM_OPTS}
                        selectedIndex={confirmIdx}
                    />
                )}

                {/* Prompt */}
                {!pendingConfirm && (
                    <Box marginTop={1} flexDirection="column">
                        <HR />
                        <Box>
                            <Text color={isWorking?'gray':'cyan'}>❯ </Text>
                            <Text>{input}</Text>
                            <Text color={isWorking?'gray':'white'}>█</Text>
                        </Box>
                        <HR />
                    </Box>
                )}

                {/* Footer */}
                {!pendingConfirm && isWorking && <Text color="gray">  esc to interrupt</Text>}
                {!pendingConfirm && !isWorking && input==='?' && <ShortcutsHelp />}
                {!pendingConfirm && !isWorking && input.startsWith('/') && <CommandMenu input={input} selectedIndex={cmdIndex} />}
                {!pendingConfirm && !isWorking && input!=='?' && !input.startsWith('/') && (
                    <Box>
                        <Text color="gray">  ? for shortcuts</Text>
                        <Text color="gray">{' '.repeat(40)}</Text>
                        <Text color="white">●</Text>
                        <Text color="gray"> {effortLevel} · /effort</Text>
                        {focusMode && <Text color="magenta"> · focus</Text>}
                        {forceReAct && <Text color="yellow"> · react</Text>}
                        {advisorEnabled && <Text color="cyan"> · advisor</Text>}
                    </Box>
                )}
            </Box>

        </Box>
    );
};

// ─── Entry point ──────────────────────────────────────────────────────────────
const savedConfig = loadConfig();
render(<App config={savedConfig} />, { patchConsole: false });
