#!/usr/bin/env tsx
// ─── cli.jsx ──────────────────────────────────────────────────────────────────
// Entry point del CLI. Solo orquesta: importa módulos y monta el componente App.
import { addEvolution, getEvolutions } from './evolution_store.js';
import React, { useState, useCallback, useRef, useEffect } from 'react';
import { render, Text, Box, useInput, Static, useStdout } from 'ink';
import { buildAgent } from './agent.js';
import { Scheduler } from './scheduler.js';
import { fetchOllamaModels, isOllamaRunning } from './ollama_utils.js';
import { HumanMessage } from '@langchain/core/messages';
import { spawn } from 'child_process';
import fs   from 'fs';
import path from 'path';

// Módulos propios
import { loadConfig, saveConfig, clearLatestSession, saveSession } from './session.js';
import { PROVIDERS, PROVIDER_MODELS }   from './providers.js';
import { SLASH_COMMANDS, handleSlashCommand, EFFORT_LEVELS, AGENTLAG_VERSION } from './commands.js';
import {
    SPINNERS, NEEDS_CONFIRM, randWord,
    runAgentTurn, downloadHFModel,
} from './agent_runner.js';
import {
    HR, WelcomeBox, UserMessage, AssistantMessage, ToolLine, ConfirmDialog,
    ShortcutsHelp, ColorScreen, TrustScreen, ProviderScreen,
    ApiKeyScreen, DownloadScreen, ModelScreen, CommandMenu,
} from './components.jsx';

// ─── App principal ────────────────────────────────────────────────────────────
const App = ({ config: initCfg }) => {
    const initScreen = () => {
        if (!initCfg.language) return 'language';
        if (!initCfg.colorSet) return 'color';
        if (!initCfg.trusted)  return 'trust';
        if (!initCfg.provider) return 'provider';
        if (!initCfg.model)    return 'model';
        return 'main';
    };

    // ── Setup screens state ───────────────────────────────────────────────────
    const [screen,       setScreen]       = useState(initScreen());
    const [ollamaModels, setOllamaModels] = useState([]);
    const [ollamaStatus, setOllamaStatus] = useState('checking');
    const [dlProgress,   setDlProgress]   = useState(0);
    const [dlStatus,     setDlStatus]     = useState('');
    const [menuIndex,    setMenuIndex]    = useState(0);
    const [formInput,    setFormInput]    = useState('');
    const [apiKeyError,  setApiKeyError]  = useState(false);
    const [selProvider,  setSelProvider]  = useState(
        initCfg.provider ? PROVIDERS.find(p => p.id === initCfg.provider) : null
    );
    const [selModel, setSelModel] = useState(initCfg.model || '');
    const cfg = useRef({ ...initCfg });

    // ── Main chat state ───────────────────────────────────────────────────────
    const [input,       setInput]      = useState('');
    const [cmdIndex,    setCmdIndex]   = useState(0);
    const [status,      setStatus]     = useState('idle');
    const schedulerRef = useRef(null);
    if (!schedulerRef.current) {
        schedulerRef.current = new Scheduler(async (p) => {
            const ag = await buildAgent();
            return await ag.invoke({ messages: [new HumanMessage(p)] });
        });
    }
    const [thinkWord,   setThinkWord]  = useState('Thinking');
    const [thinkStart,  setThinkStart] = useState(null);
    const [elapsed,     setElapsed]    = useState(0);
    const [spinFrame,   setSpinFrame]  = useState(0);
    const [activeTool,  setActiveTool] = useState(null);
    const [pendingConfirm, setPendingConfirm] = useState(null);
    const [confirmIdx,  setConfirmIdx] = useState(0);
    const [totalTokens, setTotalTokens] = useState(0);
    const [staticHistory, setStaticHistory] = useState([]);
    const msgRef               = useRef([]);
    const historyRef           = useRef([]);
    const currentConversationRef = useRef(null);
    const [agent,       setAgent]      = useState(null);
    const [agentError,  setAgentError] = useState(null);

    // ── Feature flags ─────────────────────────────────────────────────────────
    const [isVerbose,      setIsVerbose]      = useState(false);
    const [showTasks,      setShowTasks]      = useState(false);
    const [focusMode,      setFocusMode]      = useState(!!initCfg.focusMode);
    const [effortLevel,    setEffortLevel]    = useState(initCfg.effort || 'high');
    const [advisorEnabled, setAdvisorEnabled] = useState(!!initCfg.advisor);
    const [forceReAct,     setForceReAct]     = useState(!!initCfg.forceReAct);
    const abortCtrlRef = useRef(null);

    // ── Layout ────────────────────────────────────────────────────────────────
    const { stdout } = useStdout();
    const [rows, setRows] = useState(stdout?.rows || 24);

    useEffect(() => {
        if (!stdout) return;
        const h = () => setRows(stdout.rows);
        stdout.on('resize', h);
        return () => stdout.off('resize', h);
    }, [stdout]);

    // ── Persistencia automática ───────────────────────────────────────────────
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
        const onExit   = () => saveSession(historyRef.current, currentConversationRef.current);
        const onSignal = () => saveAndExit();
        process.on('exit',    onExit);
        process.on('SIGINT',  onSignal);
        process.on('SIGTERM', onSignal);
        return () => {
            process.off('exit',    onExit);
            process.off('SIGINT',  onSignal);
            process.off('SIGTERM', onSignal);
        };
    }, [saveAndExit]);

    // ── Spinner / timer ───────────────────────────────────────────────────────
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

    // ── Inicializar agente ────────────────────────────────────────────────────
    useEffect(() => {
        if (screen === 'main' && !agent) {
            setStaticHistory(prev => {
                if (!prev.some(i => i.type === 'welcome')) {
                    return [{
                        type:     'welcome',
                        provider: selProvider?.label || cfg.current.provider || 'provider',
                        model:    selModel || cfg.current.model || 'model',
                    }, ...prev];
                }
                return prev;
            });
            buildAgent()
                .then(ag => { setAgent(ag); setAgentError(null); })
                .catch(err => {
                    const msg = err?.message || String(err || 'Unknown error'); setAgentError(msg);
                    setStaticHistory(prev => [...prev, { type: 'assistant', text: '❌ Error al iniciar el agente: ' + msg }]);
                });
            const pending = getEvolutions();
            if (pending.length > 0) {
                setStaticHistory(prev => [...prev, {
                    type: 'assistant',
                    text: `💡 ${pending.length} evoluciones pendientes — usa /evolve para revisarlas`,
                    ephemeral: true,
                }]);
            }
        }
    }, [screen, agent]);

    // ── Helpers para comandos ─────────────────────────────────────────────────
    const say = useCallback((text, ephemeral = false) => {
        setStaticHistory(prev => [...prev, { type: 'assistant', text, ephemeral }]);
    }, []);

    const lastAssistantText = useCallback(() => {
        for (let i = historyRef.current.length - 1; i >= 0; i--) {
            const item = historyRef.current[i];
            if (item.type === 'assistant' && item.text) return item.text;
        }
        return null;
    }, []);

    const persistFlag = useCallback((key, value) => {
        cfg.current = { ...cfg.current, [key]: value };
        saveConfig(cfg.current);
    }, []);

    const rebuildAgentWith = useCallback(async (overrides = {}) => {
        try {
            const next = await buildAgent(overrides);
            setAgent(next);
            return true;
        } catch (e) {
            say(`❌ Error reconstruyendo el agente: ${e.message}`);
            return false;
        }
    }, [say]);

    const askConfirm = useCallback((toolName, detail) =>
        new Promise(resolve => {
            setConfirmIdx(0);
            setPendingConfirm({ toolName, detail, resolve });
        }), []);

    // Contexto compartido con el handler de comandos
    const cmdCtx = {
        cfg, saveAndExit,
        say, lastAssistantText, persistFlag, rebuildAgentWith,
        setScreen, setMenuIndex, setFormInput,
        setStaticHistory, setTotalTokens,
        msgRef, historyRef, currentConversationRef,
        totalTokens, effortLevel, setEffortLevel,
        focusMode, setFocusMode,
        forceReAct, setForceReAct,
        advisorEnabled, setAdvisorEnabled,
        agent, setAgent, schedulerRef,
        selProvider,
    };

    // ── useInput ──────────────────────────────────────────────────────────────
    useInput((str, key) => {
        if (key.ctrl && str === 'c') saveAndExit();

        // ── Setup screens ─────────────────────────────────────────────────────

        if (screen === 'color') {
            if (key.upArrow)   setMenuIndex(i => Math.max(0, i - 1));
            if (key.downArrow) setMenuIndex(i => Math.min(3, i + 1));
            if (key.return) {
                cfg.current = { ...cfg.current, colorSet: true, colorMode: menuIndex };
                saveConfig(cfg.current);
                setMenuIndex(0); setScreen('trust');
            }
            return;
        }
        if (screen === 'trust') {
            if (key.upArrow)   setMenuIndex(i => Math.max(0, i - 1));
            if (key.downArrow) setMenuIndex(i => Math.min(1, i + 1));
            if (key.escape || (key.return && menuIndex === 1)) saveAndExit();
            if (key.return && menuIndex === 0) {
                const trustedDirs = cfg.current.trustedDirs || [];
                if (!trustedDirs.includes(process.cwd())) trustedDirs.push(process.cwd());
                cfg.current = { ...cfg.current, trustedDirs, trusted: true };
                saveConfig(cfg.current);
                setMenuIndex(0);
                setScreen(cfg.current.provider && cfg.current.model ? 'main' : 'provider');
            }
            return;
        }
        if (screen === 'provider') {
            if (key.upArrow)   setMenuIndex(i => Math.max(0, i - 1));
            if (key.downArrow) setMenuIndex(i => Math.min(PROVIDERS.length - 1, i + 1));
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
                const apiKey      = noKeyNeeded ? 'local' : formInput.trim();
                if (!noKeyNeeded && !apiKey) { setApiKeyError(true); return; }
                setApiKeyError(false);
                cfg.current = { ...cfg.current, provider: selProvider.id, apiKey };
                saveConfig(cfg.current);
                setFormInput(''); setMenuIndex(0); setScreen('model');
                return;
            }
            if (key.backspace || key.delete) { setFormInput(p => p.slice(0, -1)); return; }
            if (str && !key.ctrl && !key.meta) setFormInput(p => p + str);
            return;
        }
        if (screen === 'downloading') return; // No input durante descarga

        if (screen === 'model') {
            const sugg = selProvider?.id === 'ollama'
                ? (ollamaStatus === 'running' ? ollamaModels : [])
                : (PROVIDER_MODELS[selProvider?.id] || []);

            if (key.escape)    { setScreen('apikey'); setFormInput(''); return; }
            if (key.upArrow)   { setMenuIndex(i => Math.max(0, i - 1)); return; }
            if (key.downArrow) { setMenuIndex(i => Math.min(sugg.length - 1, i + 1)); return; }
            if (key.return) {
                const model = formInput.trim() || sugg[menuIndex] || '';
                if (!model) return;

                if (selProvider?.id === 'huggingface') {
                    const hfRepo = model.replace(/^hf\.co\//, '');
                    setDlProgress(0); setDlStatus('Descargando desde HuggingFace...'); setScreen('downloading');
                    downloadHFModel(hfRepo, {
                        onProgress: setDlProgress,
                        onStatus:   setDlStatus,
                        onDone: (ollamaName) => {
                            setSelModel(ollamaName);
                            cfg.current = { ...cfg.current, provider: 'ollama', model: ollamaName };
                            saveConfig(cfg.current);
                            setTimeout(() => { setFormInput(''); setScreen('main'); }, 1000);
                        },
                        onError: (msg) => {
                            setDlStatus(msg);
                            setTimeout(() => { setFormInput(''); setScreen('model'); }, 4000);
                        },
                    });
                    return;
                }

                setSelModel(model);
                cfg.current = { ...cfg.current, model };
                saveConfig(cfg.current);
                setFormInput(''); setScreen('main');
                return;
            }
            if (key.backspace || key.delete) { setFormInput(p => p.slice(0, -1)); setMenuIndex(0); return; }
            if (str && !key.ctrl && !key.meta) { setFormInput(p => p + str); setMenuIndex(0); }
            return;
        }

        // ── main ──────────────────────────────────────────────────────────────
        if (screen === 'main') {
            if (str === '!' && input === '') { setInput('! '); return; }
            if (str === '@' && input === '') { setInput('@ '); return; }

            if (key.ctrl && str === 'o') {
                setIsVerbose(p => {
                    const next = !p;
                    say(`ℹ️ Verbose mode is now ${next ? 'ON' : 'OFF'}`);
                    return next;
                });
                return;
            }
            if (key.ctrl && str === 't') {
                setShowTasks(p => {
                    const next = !p;
                    say(`ℹ️ Tasks mode is now ${next ? 'ON' : 'OFF'}`);
                    return next;
                });
                return;
            }
            if (key.meta && str === 'p') {
                setFormInput(''); setMenuIndex(0); setScreen('model');
                return;
            }
            if (key.escape) {
                if (input === '') {
                    setStaticHistory(prev => prev.filter(i => i.type === 'welcome'));
                    msgRef.current = []; currentConversationRef.current = null;
                    clearLatestSession();
                } else {
                    setInput(''); setCmdIndex(0);
                }
                return;
            }
        }

        // ── Confirmación pendiente ────────────────────────────────────────────
        if (pendingConfirm) {
            if (key.upArrow)   setConfirmIdx(i => Math.max(0, i - 1));
            if (key.downArrow) setConfirmIdx(i => Math.min(2, i + 1));
            if (key.escape)    { pendingConfirm.resolve(false); setPendingConfirm(null); return; }
            if (key.return) {
                pendingConfirm.resolve(confirmIdx !== 2);
                setPendingConfirm(null); setConfirmIdx(0);
            }
            return;
        }

        // ── Cancelar agente ───────────────────────────────────────────────────
        if (status !== 'idle') {
            if (key.ctrl && str === 'z') {
                abortCtrlRef.current?.abort();
                setStatus('idle'); setActiveTool(null); setThinkStart(null);
                setStaticHistory(prev => [...prev, { type: 'assistant', text: '🛑 Ejecución cancelada por el usuario.' }]);
            }
            return;
        }

        // ── Autocomplete de slash commands ────────────────────────────────────
        if (input.startsWith('/')) {
            const query    = input.slice(1).toLowerCase();
            const filtered = SLASH_COMMANDS.filter(c => c.cmd.includes(query));

            if (key.upArrow && filtered.length > 0) {
                setCmdIndex(i => (i - 1 + filtered.length) % filtered.length);
                return;
            }
            if (key.downArrow && filtered.length > 0) {
                setCmdIndex(i => (i + 1) % filtered.length);
                return;
            }
        }

        // ── Enter ─────────────────────────────────────────────────────────────
        if (key.return) {
            const trimmed = input.trim();
            if (!trimmed) return;

            // /download (no está en el switch de handleSlashCommand)
            if (trimmed.startsWith('/download')) {
                const modelName = trimmed.replace('/download', '').trim().replace(/^hf\.co\//, '');
                if (!modelName) {
                    say('Uso: /download org/modelo\nEjemplo: /download inclusionai/ling-2.6-1t\n\nDescarga un modelo de HuggingFace e importa a Ollama.');
                    setInput(''); return;
                }
                say(`⏳ Descargando modelo: ${modelName}\n   via huggingface-cli download\n   Esto puede tardar varios minutos...`);
                setInput('');
                downloadHFModel(modelName, {
                    onProgress: () => {},
                    onStatus:   () => {},
                    onDone: (name) => say(`✅ Modelo ${name} listo!\n\nUsa /config para seleccionarlo como modelo activo.`),
                    onError: (msg) => say(`❌ ${msg}`),
                });
                return;
            }

            // /evolve
            if (trimmed === '/evolve' || trimmed.startsWith('/evolve ')) {
                _handleEvolveCommand(trimmed, say, setStaticHistory);
                setInput(''); return;
            }

            // Slash commands normales
            const handled = handleSlashCommand(trimmed, cmdCtx);
            if (handled === true) { setInput(''); setCmdIndex(0); return; }

            // Autocomplete: si es un slash parcial, completar
            if (trimmed.startsWith('/')) {
                const q = trimmed.slice(1).toLowerCase();
                const m = SLASH_COMMANDS.filter(c => c.cmd.includes(q))[cmdIndex];
                if (m) { setInput(m.cmd + ' '); setCmdIndex(0); return; }
            }

            setInput(''); setCmdIndex(0);
            runAgentTurn(trimmed, {
                agent, msgRef,
                setStaticHistory, setStatus, setActiveTool,
                setThinkWord, setThinkStart, setElapsed, setTotalTokens,
                abortCtrlRef, askConfirm,
                setAgent, setForceReAct, persistFlag,
            });
            return;
        }

        // ── Edición de texto ──────────────────────────────────────────────────
        if (key.backspace || key.delete) { setInput(p => p.slice(0, -1)); setCmdIndex(0); return; }
        if (str && !key.ctrl && !key.meta) { setInput(p => p + str); setCmdIndex(0); }
    });

    // ── Render ────────────────────────────────────────────────────────────────

        if (screen === 'language')    return <LanguageScreen menuIndex={menuIndex} languages={getAvailableLanguages()} />;
    if (screen === 'color')       return <ColorScreen    menuIndex={menuIndex} />;
    if (screen === 'trust')       return <TrustScreen    menuIndex={menuIndex} />;
    if (screen === 'provider')    return <ProviderScreen menuIndex={menuIndex} />;
    if (screen === 'apikey')      return <ApiKeyScreen   provider={selProvider} inputText={formInput} showError={apiKeyError} />;
    if (screen === 'downloading') return <DownloadScreen modelName={formInput || selModel} progress={dlProgress} statusText={dlStatus} />;
    if (screen === 'model')       return <ModelScreen    provider={selProvider} menuIndex={menuIndex} inputText={formInput} ollamaModels={ollamaModels} ollamaStatus={ollamaStatus} />;

    const isWorking  = status !== 'idle';
    const spinner    = SPINNERS[spinFrame];
    const timeStr    = elapsed > 0 ? ` (${elapsed}s)` : '';
    const tokenStr   = totalTokens > 0 ? ` · ↓ ${totalTokens} tokens` : '';
    const CONFIRM_OPTS = [t('yes'), t('allow_all'), t('no')];

    return (
        <Box flexDirection="column">
            {/* ── Historial estático (nunca se re-renderiza) ────────────────── */}
            <Static items={focusMode ? staticHistory.filter(i => i.type !== 'tool') : staticHistory}>
                {(item, index) => {
                    if (item.type === 'welcome')   return <WelcomeBox key="welcome" provider={item.provider} model={item.model} />;
                    if (item.type === 'user')      return <UserMessage      key={index} text={item.text} />;
                    if (item.type === 'assistant') return <AssistantMessage key={index} text={item.text === 'Welcome back Alonso!' ? t('welcome') : item.text} />;
                    if (item.type === 'tool')      return (
                        <Box key={index} marginTop={1}>
                            <ToolLine name={item.name} input={item.input} output={item.output} running={false} />
                        </Box>
                    );
                    return null;
                }}
            </Static>

            {/* ── Zona activa (siempre al fondo, re-render normal) ─────────── */}
            <Box flexDirection="column">
                {activeTool && (
                    <Box marginTop={1}>
                        <ToolLine name={activeTool.name} input={activeTool.input} running={true} />
                    </Box>
                )}

                {isWorking && !pendingConfirm && (
                    <Box marginTop={1}>
                        <Text color="yellow">{spinner} </Text>
                        <Text color="yellow">{thinkWord}…</Text>
                        <Text color="gray">{timeStr}{tokenStr}</Text>
                    </Box>
                )}

                {pendingConfirm && (
                    <ConfirmDialog
                        toolName={pendingConfirm.toolName}
                        detail={pendingConfirm.detail}
                        options={CONFIRM_OPTS}
                        selectedIndex={confirmIdx}
                    />
                )}

                {/* Prompt (siempre visible a menos que haya confirm) */}
                {!pendingConfirm && (
                    <Box marginTop={1} flexDirection="column">
                        <HR />
                        <Box>
                            <Text color={isWorking ? 'gray' : 'cyan'}>❯ </Text>
                            <Text>{input}</Text>
                            <Text color={isWorking ? 'gray' : 'white'}>█</Text>
                        </Box>
                        <HR />
                    </Box>
                )}

                {!pendingConfirm && isWorking && <Text color="gray">  esc to interrupt</Text>}
                {!pendingConfirm && !isWorking && input === '?'        && <ShortcutsHelp />}
                {!pendingConfirm && !isWorking && input.startsWith('/') && (
                    <CommandMenu input={input} selectedIndex={cmdIndex} slashCommands={SLASH_COMMANDS} />
                )}
                {!pendingConfirm && !isWorking && input !== '?' && !input.startsWith('/') && (
                    <Box>
                        <Text color="gray">  ? for shortcuts</Text>
                        <Text color="gray">{' '.repeat(40)}</Text>
                        <Text color="white">●</Text>
                        <Text color="gray"> {effortLevel} · /effort</Text>
                        {focusMode      && <Text color="magenta"> · focus</Text>}
                        {forceReAct     && <Text color="yellow">  · react</Text>}
                        {advisorEnabled && <Text color="cyan">   · advisor</Text>}
                    </Box>
                )}
            </Box>
        </Box>
    );
};

// ── /evolve separado (no ensucia el switch de comandos) ───────────────────────
function _handleEvolveCommand(trimmed, say, setStaticHistory) {
    const { getEvolutions, getLatestEvolution, removeEvolution } = require('./evolution_store.js');
    const { applyEvolution }                                     = require('./evolution_engine.js');

    const parts   = trimmed.split(' ');
    const sub     = parts[1];
    const arg     = parts[2];
    const pending = getEvolutions();

    if (!sub) {
        const latest = getLatestEvolution();
        if (latest) {
            applyEvolution(latest);
            removeEvolution(latest.id);
            setStaticHistory(prev => [...prev, { type: 'assistant', text: `✅ Habilidad ${latest.skillName} evolucionada y guardada en el registro SQLite.` }]);
        } else {
            setStaticHistory(prev => [...prev, { type: 'assistant', text: '❌ No hay evoluciones pendientes para aplicar.' }]);
        }
    } else if (sub === 'list') {
        if (pending.length === 0) {
            setStaticHistory(prev => [...prev, { type: 'assistant', text: 'No hay evoluciones pendientes.' }]);
        } else {
            const lines = ['🧩 Evoluciones pendientes:', ''];
            pending.forEach((ev, i) => {
                lines.push(`  ${i + 1}. [${ev.skillName}] ${ev.reason.slice(0, 60)}${ev.reason.length > 60 ? '...' : ''}`);
                lines.push(`     ID: ${ev.id}`);
            });
            lines.push('\nUsa /evolve apply <num> o /evolve discard <num>');
            setStaticHistory(prev => [...prev, { type: 'assistant', text: lines.join('\n') }]);
        }
    } else if (sub === 'apply' && arg) {
        const target = pending[parseInt(arg) - 1];
        if (target) { applyEvolution(target); removeEvolution(target.id); setStaticHistory(prev => [...prev, { type: 'assistant', text: `✅ Habilidad ${target.skillName} evolucionada.` }]); }
        else          setStaticHistory(prev => [...prev, { type: 'assistant', text: `❌ Índice ${arg} no válido.` }]);
    } else if (sub === 'discard' && arg) {
        const target = pending[parseInt(arg) - 1];
        if (target) { removeEvolution(target.id); setStaticHistory(prev => [...prev, { type: 'assistant', text: `🗑 Evolución ${target.id} descartada.` }]); }
        else          setStaticHistory(prev => [...prev, { type: 'assistant', text: `❌ Índice ${arg} no válido.` }]);
    } else {
        setStaticHistory(prev => [...prev, { type: 'assistant', text: 'Uso: /evolve [list | apply <n> | discard <n>]' }]);
    }
}

// ─── Entry point ──────────────────────────────────────────────────────────────
render(<App config={loadConfig()} />, { patchConsole: false });
