#!/usr/bin/env node
import React, { useState, useCallback, useRef, useEffect } from 'react';
import { render, Text, Box, useInput, Static, Newline, useStdout } from 'ink';
import { buildAgent } from './agent.js';
import { fetchOllamaModels, isOllamaRunning } from './ollama_utils.js';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ─── Persistencia ~/.agentlag/ ────────────────────────────────────────────────
const CONFIG_DIR  = path.join(os.homedir(), '.agentlag');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const SESSION_FILE = path.join(process.cwd(), '.agentlag_history.json');

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
function loadSession() {
    try { return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')); } catch { return { history: [] }; }
}
function saveSession(history) {
    const toSave = history.filter(m => m.type === 'user' || m.type === 'assistant');
    fs.writeFileSync(SESSION_FILE, JSON.stringify({ history: toSave }, null, 2));
}

// ─── Constantes ───────────────────────────────────────────────────────────────
const SPINNERS       = ['✻', '✼', '✽', '✾', '✿'];
const THINKING_WORDS = ['Thinking','Reasoning','Analyzing','Computing','Marinating','Levitating','Pondering','Brewing'];
const TOOL_ICONS     = { create_file:'●', read_file:'●', list_directory:'●', run_shell:'●', web_search:'●' };
const NEEDS_CONFIRM  = new Set(['run_shell', 'create_file']);

const toolLabel = (n) => n?.replace(/_/g, ' ') ?? 'tool';
const randWord  = () => THINKING_WORDS[Math.floor(Math.random() * THINKING_WORDS.length)];

// ─── Proveedores ──────────────────────────────────────────────────────────────
const PROVIDERS = [
    { id:'groq',       label:'Groq',           desc:'Ultra-fast inference (LPU)' },
    { id:'openai',     label:'OpenAI',          desc:'GPT-4o, o1, o3…' },
    { id:'anthropic',  label:'Anthropic',       desc:'Claude Sonnet / Opus' },
    { id:'openrouter', label:'OpenRouter',      desc:'Multi-model gateway' },
    { id:'nvidia',     label:'NVIDIA NIM',      desc:'NVIDIA hosted models' },
    { id:'deepseek',   label:'DeepSeek',        desc:'DeepSeek-V3 / R1' },
    { id:'mistral',    label:'Mistral AI',      desc:'Mixtral, Mistral-Large' },
    { id:'meta',       label:'Meta (Llama)',    desc:'Llama 3.x via API' },
    { id:'ollama',     label:'Ollama (local)',  desc:'Local models, no API key' },
    { id:'together',   label:'Together AI',     desc:'Open models hosted' },
];

const PROVIDER_MODELS = {
    groq:       ['qwen/qwen3-32b','llama-3.3-70b-versatile','mixtral-8x7b-32768','gemma2-9b-it'],
    openai:     ['gpt-4o','gpt-4o-mini','o1','o3-mini'],
    anthropic:  ['claude-sonnet-4-5','claude-opus-4','claude-haiku-4-5'],
    openrouter: ['openai/gpt-4o','anthropic/claude-3-opus','meta-llama/llama-3-70b'],
    nvidia:     ['meta/llama-3.1-70b-instruct','mistralai/mixtral-8x7b-instruct'],
    deepseek:   ['deepseek-chat','deepseek-reasoner'],
    mistral:    ['mistral-large-latest','mistral-medium','codestral-latest'],
    meta:       ['llama-3.3-70b','llama-3.1-405b'],
    ollama:     ['llama3','mistral','qwen2','gemma2','phi3','codellama'],
    together:   ['meta-llama/Llama-3-70b-chat-hf','mistralai/Mixtral-8x7B-Instruct-v0.1'],
};

// ─── Componentes base ─────────────────────────────────────────────────────────
const HR = ({ char='─', width=72 }) => <Text color="gray">{char.repeat(width)}</Text>;

const AgentLogo = () => (
    <Box flexDirection="column">
        <Text color="#00FF87"> ▄▀▄ █▀▀ █▀▀ █▄ █ ▀█▀ █   ▄▀▄ █▀▀ </Text>
        <Text color="#00FF87"> █▀█ █ █ █▀▀ █ ▀█  █  █   █▀█ █ █ </Text>
        <Text color="#00FF87"> ▀ ▀ ▀▀▀ ▀▀▀ ▀  ▀  ▀  ▀▀▀ ▀ ▀ ▀▀▀ </Text>
        <Box><Text color="white" bold>  AGENTLAG</Text><Text color="gray">  v1.0.0</Text></Box>
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
    const lines = (text || '').split('\n');
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
            <Text color="gray">Welcome to AgentLag v1.0.0</Text>
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

const ApiKeyScreen = ({ provider, inputText }) => (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
        <AgentLogo /><Newline />
        <Text color="gray">{'─'.repeat(69)}</Text>
        <Text bold> Enter API Key for <Text color="#00FF87">{provider?.label}</Text></Text><Newline />
        <Text color="gray"> {provider?.id==='ollama' ? 'No key needed for local Ollama' : 'Your key is stored locally in ~/.agentlag/config.json'}</Text>
        <Newline />
        <Box borderStyle="single" borderColor="cyan" paddingX={1}>
            <Text color="gray">Key: </Text>
            <Text>{provider?.id==='ollama' ? 'Local' : '*'.repeat(inputText.length)}</Text>
            <Text color="white">█</Text>
        </Box>
        <Newline />
        <Text color="gray"> Enter to confirm · Esc to go back</Text>
        <Text color="gray">{'╌'.repeat(69)}</Text>
    </Box>
);

const ModelScreen = ({ provider, menuIndex, inputText, ollamaModels, ollamaStatus }) => {
    const isOllama = provider?.id === 'ollama';
    let suggestions;
    if (isOllama) {
        suggestions = ollamaStatus === 'running' ? ollamaModels : [];
    } else {
        suggestions = PROVIDER_MODELS[provider?.id] || [];
    }
    return (
        <Box flexDirection="column" paddingX={1} paddingY={1}>
            <AgentLogo /><Newline />
            <Text color="gray">{'─'.repeat(69)}</Text>
            <Text bold> Select or type model for <Text color="#00FF87">{provider?.label}</Text></Text><Newline />
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
                    <Text color="gray"> {isOllama && ollamaStatus === 'running' ? 'Modelos instalados' : 'Suggestions'} (↑↓ pick · Enter confirm):</Text>
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
const SLASH_COMMANDS = [
    { cmd:'/add-dir',  desc:['Add a new working directory'] },
    { cmd:'/advisor',  desc:['Configure the Advisor Tool','for guidance at key moments…'] },
    { cmd:'/agents',   desc:['Manage agent configurations'] },
    { cmd:'/branch',   desc:['Create a branch of the current','conversation at this point'] },
    { cmd:'/clear',    desc:['Clear conversation history'] },
    { cmd:'/import',   desc:['Import history from current project'] },
    { cmd:'/help',     desc:['Show all available commands'] },
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
    const [menuIndex, setMenuIndex]       = useState(0);
    const [formInput, setFormInput]       = useState('');
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
    const [agent, setAgent] = useState(null);

    // Nuevos estados para atajos
    const [isVerbose, setIsVerbose]       = useState(false);
    const [showTasks, setShowTasks]       = useState(false);
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

    // Inicializar agente
    useEffect(() => {
        if (screen === 'main' && !agent) {
            buildAgent().then(setAgent).catch(err => {
                setStaticHistory([{type:'assistant', text:'❌ Error al iniciar agente: '+err.message}]);
            });
        }
    }, [screen, agent]);

    const askConfirm = useCallback((toolName, detail) =>
        new Promise(resolve => {
            setConfirmIdx(0);
            setPendingConfirm({ toolName, detail, resolve });
        }), []);

    // ── Input ─────────────────────────────────────────────────────────────────
    useInput((str, key) => {
        if (key.ctrl && str === 'c') process.exit();

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
            if (key.escape || (key.return && menuIndex===1)) process.exit();
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
            if (key.escape) { setScreen('provider'); setFormInput(''); return; }
            if (key.return) {
                const apiKey = selProvider?.id==='ollama' ? 'ollama' : formInput.trim();
                cfg.current = { ...cfg.current, provider:selProvider.id, apiKey };
                saveConfig(cfg.current);
                setFormInput(''); setMenuIndex(0); setScreen('model');
                return;
            }
            if (key.backspace||key.delete) { setFormInput(p=>p.slice(0,-1)); return; }
            if (str && !key.ctrl && !key.meta && str.length===1) setFormInput(p=>p+str);
            return;
        }
        if (screen === 'model') {
            const sugg = (selProvider?.id === 'ollama' && ollamaStatus === 'running') ? ollamaModels : (selProvider?.id === 'ollama' ? [] : (PROVIDER_MODELS[selProvider?.id] || []));
            if (key.escape) { setScreen('apikey'); setFormInput(''); return; }
            if (key.upArrow)   { setMenuIndex(i=>Math.max(0,i-1)); return; }
            if (key.downArrow) { setMenuIndex(i=>Math.min(sugg.length-1,i+1)); return; }
            if (key.return) {
                const model = formInput.trim() || sugg[menuIndex] || '';
                if (!model) return;
                setSelModel(model);
                cfg.current = { ...cfg.current, model };
                saveConfig(cfg.current);
                setFormInput(''); setScreen('main');
                return;
            }
            if (key.backspace||key.delete) { setFormInput(p=>p.slice(0,-1)); setMenuIndex(0); return; }
            if (str && !key.ctrl && !key.meta && str.length===1) { setFormInput(p=>p+str); setMenuIndex(0); }
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
                    setStaticHistory([]); msgRef.current = []; saveSession([]);
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
            if (trimmed === '/config') {
                // Reset setup
                cfg.current = {};
                saveConfig({});
                setScreen('color');
                return;
            }
            if (trimmed === '/clear') {
                setStaticHistory([]); msgRef.current = []; saveSession([]); setInput(''); return;
            }
            if (trimmed === '/help') {
                const helpText = SLASH_COMMANDS.map(c => `  ${c.cmd.padEnd(12)} - ${c.desc.join(' ')}`).join('\n');
                setStaticHistory(prev => [...prev, { type: 'assistant', text: `Comandos disponibles:\n${helpText}` }]);
                setInput(''); return;
            }
            if (trimmed.startsWith('/btw')) {
                setStaticHistory(prev => [...prev, { type: 'assistant', text: '📝 Modo nota / side question activo...' }]);
                setInput(''); return;
            }
            if (trimmed === '/import') {
                const s = loadSession();
                if (s.history?.length) {
                    msgRef.current = s.history.map(m =>
                        m.type === 'user' ? new HumanMessage(m.text) : new AIMessage(m.text)
                    );
                    setStaticHistory(s.history);
                    setStaticHistory(prev => [...prev, { type:'assistant', text:'✅ Historial importado correctamente.' }]);
                } else {
                    setStaticHistory(prev => [...prev, { type:'assistant', text:'⚠️ No hay historial previo para importar en este proyecto.' }]);
                }
                setInput(''); return;
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
        if (str && !key.ctrl && !key.meta && str.length === 1) {
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
                    const last = chunk.agent.messages?.at(-1);
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

            if (responseText) setStaticHistory(prev=>[...prev,{type:'assistant',text:responseText}]);

        } catch(err) {
            if (err.message?.includes('does not support tools')) {
                setStaticHistory(prev=>[...prev,{
                    type:'assistant',
                    text:'⚠️ Este modelo no soporta tools nativas. Cambiando a modo ReAct...'
                }]);
                try {
                    const reactAgent = await buildAgent({ forceReAct: true });
                    setAgent(reactAgent);
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
                    if (retryText) setStaticHistory(prev=>[...prev,{type:'assistant',text:retryText}]);
                } catch (reactErr) {
                    setStaticHistory(prev=>[...prev,{type:'assistant',text:`❌ Error (ReAct): ${reactErr.message}`}]);
                }
            } else {
                setStaticHistory(prev=>[...prev,{type:'assistant',text:`❌ Error: ${err.message}`}]);
            }
        } finally {
            setStatus('idle'); setActiveTool(null); setThinkStart(null); setElapsed(0);
        }
    }, [agent, askConfirm]);

    // ── Render ────────────────────────────────────────────────────────────────
    if (screen==='color')    return <ColorScreen    menuIndex={menuIndex} />;
    if (screen==='trust')    return <TrustScreen    menuIndex={menuIndex} />;
    if (screen==='provider') return <ProviderScreen menuIndex={menuIndex} />;
    if (screen==='apikey')   return <ApiKeyScreen   provider={selProvider} inputText={formInput} />;
    if (screen==='model')    return <ModelScreen    provider={selProvider} menuIndex={menuIndex} inputText={formInput} ollamaModels={ollamaModels} ollamaStatus={ollamaStatus} />;

    const isWorking  = status !== 'idle';
    const spinner    = SPINNERS[spinFrame];
    const timeStr    = elapsed > 0 ? ` (${elapsed}s)` : '';
    const tokenStr   = totalTokens > 0 ? ` · ↓ ${totalTokens} tokens` : '';
    const CONFIRM_OPTS = ['Yes', "Yes, allow all for this session", 'No'];

    return (
        <Box flexDirection="column">
            {/* Solo mostramos el WelcomeBox al inicio, luego Static lo empujará arriba */}
            <WelcomeBox
                provider={selProvider?.label || cfg.current.provider || 'provider'}
                model={selModel || cfg.current.model || 'model'}
            />

            <Static items={staticHistory}>
                {(item, index) => {
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
                        <Text color="gray"> high · /effort</Text>
                    </Box>
                )}
            </Box>

        </Box>
    );
};

// ─── Entry point ──────────────────────────────────────────────────────────────
const savedConfig = loadConfig();
render(<App config={savedConfig} />, { patchConsole: false });
