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
import { t, getAvailableLanguages, setLanguage } from './i18n.js';
import { runMcpCli } from './mcp_cli.js';

// ─── Router de subcomandos (fuera de la TUI) ─────────────────────────────────
// Permite invocar utilidades desde fuera de la interfaz interactiva:
//
//   agentlag mcp add playwright npx @playwright/mcp@latest
//   agentlag mcp list
//   agentlag mcp remove playwright
//
// Si el primer argumento es un subcomando conocido, lo ejecutamos y salimos sin
// arrancar la TUI. Si no, arrancamos la app React/Ink como siempre.
const _cliArgs = process.argv.slice(2);
if (_cliArgs.length > 0 && _cliArgs[0] === 'mcp') {
    const code = runMcpCli(_cliArgs.slice(1));
    process.exit(code ?? 0);
}

// Módulos propios
import { loadConfig, saveConfig, clearLatestSession, saveSession } from './session.js';
import { getFromMemory } from './memory_utils.js';
import { PROVIDERS, PROVIDER_MODELS }   from './providers.js';
import { SLASH_COMMANDS, handleSlashCommand, EFFORT_LEVELS, AGENTLAG_VERSION } from './commands.js';
import {
    SPINNERS, NEEDS_CONFIRM, randWord,
    runAgentTurn, runStreamTurn, downloadHFModel,
} from './agent_runner.js';
import {
    HR, LanguageScreen, WelcomeBox, UserMessage, AssistantMessage, ToolLine, ConfirmDialog,
    ShortcutsHelp, ColorScreen, TrustScreen, ProviderScreen,
    ApiKeyScreen, DownloadScreen, ModelScreen, CommandMenu,
    BoxedOutput,
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
    // Cursor position within `input`. Tracked as state so re-render happens
    // when arrows move it. Range: [0 .. input.length].
    const [cursorPos,   setCursorPos]  = useState(0);
    // Wrapper that keeps cursor in sync when input changes wholesale.
    const setInputAt = useCallback((newText, newPos) => {
        const txt = typeof newText === 'function' ? newText(inputRef.current) : newText;
        const pos = newPos === undefined || newPos > txt.length ? txt.length
                  : newPos < 0 ? 0 : newPos;
        inputRef.current = txt;
        cursorPosRef.current = pos;
        setInput(txt);
        setCursorPos(pos);
    }, []);
    // Refs to read fresh values inside useInput without stale closures.
    const inputRef = useRef('');
    const cursorPosRef = useRef(0);
    const schedulerRef = useRef(null);
    if (!schedulerRef.current) {
        schedulerRef.current = new Scheduler(async (p) => {
            const ag = await buildAgent();
            return await ag.invoke({ messages: [new HumanMessage(p)] });
        });
    }
    const [thinkWord,   setThinkWord]  = useState(t('thinking'));
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
    const [lastError,   setLastError]  = useState(null);

    // ── Feature flags ─────────────────────────────────────────────────────────
    const [isVerbose,      setIsVerbose]      = useState(false);
    const [showTasks,      setShowTasks]      = useState(false);
    const [focusMode,      setFocusMode]      = useState(!!initCfg.focusMode);
    const [effortLevel,    setEffortLevel]    = useState(initCfg.effort || 'high');
    const [advisorEnabled, setAdvisorEnabled] = useState(!!initCfg.advisor);
    const [forceReAct,     setForceReAct]     = useState(!!initCfg.forceReAct);
    const [streamMode,     setStreamMode]     = useState(!!initCfg.streamMode);
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
        inputRef.current = input;
        // Si el cursor quedó más allá del final del texto, recortar.
        if (cursorPosRef.current > input.length) {
            cursorPosRef.current = input.length;
            setCursorPos(input.length);
        }
    }, [input]);

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
            const userName = getFromMemory('user_name') || getFromMemory('User_name') || getFromMemory('nombre_usuario');
            setStaticHistory(prev => {
                if (!prev.some(i => i.type === 'welcome')) {
                    return [{
                        type:     'welcome',
                        provider: selProvider?.label || cfg.current.provider || 'provider',
                        model:    selModel || cfg.current.model || 'model',
                        userName: userName,
                    }, ...prev];
                }
                return prev;
            });
            buildAgent()
                .then(ag => { setAgent(ag); setAgentError(null); })
                .catch(err => {
                    const msg = err?.message || String(err || 'Unknown error');
                    if (msg !== agentError) {
                        setAgentError(msg);
                        setLastError(err);
                        setStaticHistory(prev => [...prev, { type: 'assistant', text: t('error_starting_agent', { error: msg }) }]);
                    }
                });
            const pending = getEvolutions();
            if (pending.length > 0) {
                setStaticHistory(prev => [...prev, {
                    type: 'assistant',
                    text: t('pending_evolutions', { count: pending.length }),
                    ephemeral: true,
                }]);
            }
        }
    }, [screen, agent]);

    // ── Helpers para comandos ─────────────────────────────────────────────────
    const say = useCallback((text, ephemeral = false) => {
        setStaticHistory(prev => [...prev, { type: 'assistant', text, ephemeral }]);
    }, []);

    const sayBoxed = useCallback(({ title, lines, borderColor, titleColor, ephemeral }) => {
        setStaticHistory(prev => [...prev, { type: 'boxed', title, lines, borderColor: borderColor || 'gray', titleColor: titleColor || 'white', ephemeral: !!ephemeral }]);
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
            // Always pass the current effort level so it persists across rebuilds
            // (e.g. when toggling /react or /provider, the effort setting carries over)
            const fullOverrides = {
                effortLevel: cfg.current.effort || effortLevel,
                ...overrides,
            };
            const next = await buildAgent(fullOverrides);
            setAgent(next);
            return true;
        } catch (e) {
            say(t('error_rebuilding_agent', { error: e.message }));
            return false;
        }
    }, [say, effortLevel]);

    const askConfirm = useCallback((toolName, detail) =>
        new Promise(resolve => {
            setConfirmIdx(0);
            setPendingConfirm({ toolName, detail, resolve });
        }), []);

    // Contexto compartido con el handler de comandos
    const cmdCtx = {
        cfg, saveAndExit,
        say, sayBoxed, lastAssistantText, persistFlag, rebuildAgentWith,
        setScreen, setMenuIndex, setFormInput,
        setStaticHistory, setStatus, setActiveTool,
        setThinkWord, setThinkStart, setElapsed, setTotalTokens,
        abortCtrlRef, askConfirm,
        msgRef, historyRef, currentConversationRef,
        totalTokens, effortLevel, setEffortLevel,
        focusMode, setFocusMode,
        forceReAct, setForceReAct,
        streamMode, setStreamMode,
        advisorEnabled, setAdvisorEnabled,
        agent, setAgent, schedulerRef,
        selProvider, runAgentTurn, runStreamTurn,
        lastError, setLastError,
    };

    // ── useInput ──────────────────────────────────────────────────────────────
    useInput((str, key) => {
        if (key.ctrl && str === 'c') saveAndExit();

        // ── Bloqueo si el agente falló ────────────────────────────────────────
        if (screen === 'main' && agentError && !input.startsWith('/')) {
            // Permitimos comandos slash para reconfigurar, pero no mensajes normales
            if (key.return) {
                const trimmed = input.trim();
                if (trimmed && !trimmed.startsWith('/')) {
                    // No hacemos nada o podrías mostrar un aviso breve.
                    // El useEffect ya puso el error en el historial.
                    setInputAt('', 0);
                    return;
                }
            }
        }

        // ── Setup screens ─────────────────────────────────────────────────────
        if (screen === 'language') {
            const langs = getAvailableLanguages();
            if (key.upArrow)   setMenuIndex(i => Math.max(0, i - 1));
            if (key.downArrow) setMenuIndex(i => Math.min(langs.length - 1, i + 1));
            if (key.return) {
                const sel = langs[menuIndex];
                setLanguage(sel);
                cfg.current = { ...cfg.current, language: sel };
                saveConfig(cfg.current);
                setMenuIndex(0); setScreen('color');
            }
            return;
        }

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
                    setDlProgress(0); setDlStatus(t('dl_status_starting')); setScreen('downloading');
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
                        setDlStatus(t('error_prefix', { error: msg }));
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
            if (str === '!' && input === '') { setInputAt('! ', 2); return; }
            if (str === '@' && input === '') { setInputAt('@ ', 2); return; }

            if (key.ctrl && str === 'o') {
                setIsVerbose(p => {
                    const next = !p;
                    say(next ? t('verbose_on') : t('verbose_off'));
                    return next;
                });
                return;
            }
            if (key.ctrl && str === 't') {
                setShowTasks(p => {
                    const next = !p;
                    say(next ? t('tasks_on') : t('tasks_off'));
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
                    setInputAt('', 0); setCmdIndex(0);
                }
                return;
            }
        }

        // ── Cancelar agente (ESC o Ctrl+Z) ────────────────────────────────────
        // El hint dice "ESC para interrumpir" — ahora ESC realmente interrumpe.
        if (status !== 'idle') {
            if (key.escape || (key.ctrl && str === 'z')) {
                abortCtrlRef.current?.abort();
                setStatus('idle'); setActiveTool(null); setThinkStart(null); setElapsed(0);
                setStaticHistory(prev => [...prev, { type: 'assistant', text: t('execution_cancelled_user') }]);
            }
            return;
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
                    say(t('download_usage'));
                    setInputAt('', 0); return;
                }
                say(t('downloading_model', { name: modelName }));
                setInputAt('', 0);
                downloadHFModel(modelName, {
                    onProgress: () => {},
                    onStatus:   () => {},
                    onDone: (name) => say(t('model_ready', { name })),
                    onError: (msg) => say(t('error_prefix', { error: msg })),
                });
                return;
            }

            // /evolve
            if (trimmed === '/evolve' || trimmed.startsWith('/evolve ')) {
                _handleEvolveCommand(trimmed, say, setStaticHistory);
                setInputAt('', 0); return;
            }

            // Slash commands normales — handleSlashCommand es async, hay que esperarlo.
            // Si no se espera, devuelve una Promise (que nunca === true), el chequeo
            // falla, y el input se acaba mandando al agente como si fuera un mensaje.
            (async () => {
                const handled = await handleSlashCommand(trimmed, cmdCtx);
                if (handled === true) { setInputAt('', 0); setCmdIndex(0); return; }

                // Si empieza con '/' pero no fue manejado por handleSlashCommand,
                // es un comando desconocido o un comando parcial.
                if (trimmed.startsWith('/')) {
                    const q = trimmed.slice(1).toLowerCase();

                    // ¿Existe una coincidencia parcial para autocompletar?
                    const matches = SLASH_COMMANDS.filter(c => c.cmd.includes(q));
                    if (matches.length > 0) {
                        const m = matches[cmdIndex] || matches[0];
                        // Solo autocompletar si el input NO es ya un comando completo.
                        // Si el input ya es exactamente un comando de la lista pero
                        // handleSlashCommand devolvió false, es porque el comando
                        // existe en el catálogo pero no tiene case en el switch —
                        // mostramos error en lugar de mandarlo al agente.
                        if (m.cmd === trimmed) {
                            say(`⚠ Comando no implementado: ${trimmed}. Usa /help para ver los comandos disponibles.`);
                            setInputAt('', 0); setCmdIndex(0);
                            return;
                        }
                        setInputAt(m.cmd + ' ', m.cmd.length + 1); setCmdIndex(0);
                        return;
                    }

                    // Comando slash desconocido — nunca mandarlo al agente.
                    say(`⚠ Comando desconocido: ${trimmed}. Usa /help para ver los comandos disponibles.`);
                    setInputAt('', 0); setCmdIndex(0);
                    return;
                }

                setInputAt('', 0); setCmdIndex(0);
                // Si /stream está activado (modo toggle como /react), usar streaming
                // token-a-token en lugar del flujo normal con tools.
                if (streamMode) {
                    runStreamTurn(trimmed, {
                        msgRef,
                        setStaticHistory, setStatus, setActiveTool,
                        setThinkWord, setThinkStart, setElapsed,
                        abortCtrlRef, setLastError,
                    });
                } else {
                    runAgentTurn(trimmed, {
                        agent, msgRef,
                        setStaticHistory, setStatus, setActiveTool,
                        setThinkWord, setThinkStart, setElapsed, setTotalTokens,
                        abortCtrlRef, askConfirm,
                        setAgent, setForceReAct, persistFlag,
                        setLastError,
                    });
                }
            })();
            return;
        }

        // ── Edición de texto con cursor ──────────────────────────────────────
        // Soporta: backspace, delete, flechas izq/der, Home/End (Ctrl+A/Ctrl+E),
        // Ctrl+U (borrar línea), Ctrl+K (borrar hasta final), pegado multilínea.
        if (key.backspace || key.delete) {
            const pos = cursorPosRef.current;
            if (pos > 0) {
                const txt = inputRef.current;
                const next = txt.slice(0, pos - 1) + txt.slice(pos);
                setInputAt(next, pos - 1);
            }
            setCmdIndex(0);
            return;
        }
        if (key.leftArrow) {
            const pos = cursorPosRef.current;
            if (pos > 0) { cursorPosRef.current = pos - 1; setCursorPos(pos - 1); }
            setCmdIndex(0);
            return;
        }
        if (key.rightArrow) {
            const pos = cursorPosRef.current;
            const maxPos = inputRef.current.length;
            if (pos < maxPos) { cursorPosRef.current = pos + 1; setCursorPos(pos + 1); }
            setCmdIndex(0);
            return;
        }
        // Ctrl+A → inicio, Ctrl+E → final (convención readline/Emacs)
        if (key.ctrl && str === 'a') {
            cursorPosRef.current = 0; setCursorPos(0); setCmdIndex(0); return;
        }
        if (key.ctrl && str === 'e') {
            const end = inputRef.current.length;
            cursorPosRef.current = end; setCursorPos(end); setCmdIndex(0); return;
        }
        // Ctrl+U → borrar desde cursor hasta inicio
        if (key.ctrl && str === 'u') {
            const pos = cursorPosRef.current;
            const txt = inputRef.current;
            const next = txt.slice(pos);
            setInputAt(next, 0);
            setCmdIndex(0);
            return;
        }
        // Ctrl+K → borrar desde cursor hasta final
        if (key.ctrl && str === 'k') {
            const pos = cursorPosRef.current;
            const txt = inputRef.current;
            const next = txt.slice(0, pos);
            setInputAt(next, pos);
            setCmdIndex(0);
            return;
        }
        // Ctrl+W → borrar palabra anterior
        if (key.ctrl && str === 'w') {
            const pos = cursorPosRef.current;
            const txt = inputRef.current;
            const before = txt.slice(0, pos);
            const after  = txt.slice(pos);
            const m = before.match(/\S+\s*$/);
            if (m) {
                const next = before.slice(0, before.length - m[0].length) + after;
                setInputAt(next, before.length - m[0].length);
            }
            setCmdIndex(0);
            return;
        }

        if (str && !key.ctrl && !key.meta) {
            // Pegado multilínea: Ink entrega el texto pegado en una sola llamada
            // de useInput. Si contiene \r o \n, lo normalizamos a \n y lo
            // insertamos completo en la posición del cursor (en vez de cortarlo).
            // Antes, los pegados largos se truncaban porque Ink llamaba a
            // useInput carácter por carácter y el handler no acumulaba
            // correctamente; ahora recibimos el texto completo y lo insertamos.
            let text = str;
            if (text.includes('\r')) text = text.replace(/\r\n?/g, '\n');

            const pos = cursorPosRef.current;
            const txt = inputRef.current;
            const next = txt.slice(0, pos) + text + txt.slice(pos);
            const newPos = pos + text.length;
            setInputAt(next, newPos);
            setCmdIndex(0);
        }
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
                    if (item.type === 'welcome')   return <WelcomeBox key="welcome" provider={item.provider} model={item.model} userName={item.userName} />;
                    if (item.type === 'user')      return <UserMessage      key={index} text={item.text} />;
                    if (item.type === 'assistant') return <AssistantMessage key={index} text={(item.text === 'Welcome back!' || item.text === '¡Bienvenido de nuevo!') ? t('welcome') : item.text} />;
                    if (item.type === 'tool')      return (
                        <Box key={index} marginTop={1}>
                            <ToolLine name={item.name} input={item.input} output={item.output} running={false} />
                        </Box>
                    );
                    if (item.type === 'boxed')     return <BoxedOutput key={index} title={item.title} lines={item.lines} borderColor={item.borderColor} titleColor={item.titleColor} />;
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
                            <Text>{input.slice(0, cursorPos)}</Text>
                            {/* Cursor: resalta el carácter bajo el cursor, o muestra bloque al final */}
                            {cursorPos < input.length ? (
                                <Text color={isWorking ? 'gray' : 'white'} inverse>{input[cursorPos]}</Text>
                            ) : (
                                <Text color={isWorking ? 'gray' : 'white'}>█</Text>
                            )}
                            <Text>{input.slice(cursorPos + 1)}</Text>
                        </Box>
                        <HR />
                    </Box>
                )}

                {!pendingConfirm && isWorking && <Text color="gray">  {t('esc_to_interrupt')}</Text>}
                {!pendingConfirm && !isWorking && input === '?'        && <ShortcutsHelp />}
                {!pendingConfirm && !isWorking && input.startsWith('/') && (
                    <CommandMenu input={input} selectedIndex={cmdIndex} slashCommands={SLASH_COMMANDS} />
                )}
                {!pendingConfirm && !isWorking && input !== '?' && !input.startsWith('/') && (
                    <Box>
                        <Text color="gray">  {t('shortcuts_hint')}</Text>
                        <Text color="gray">{' '.repeat(40)}</Text>
                        <Text color="white">●</Text>
                        <Text color="gray"> {effortLevel} · /effort</Text>
                        {focusMode      && <Text color="magenta"> · {t('focus')}</Text>}
                        {forceReAct     && <Text color="yellow">  · {t('react')}</Text>}
                        {streamMode     && <Text color="blue">     · {t('stream')}</Text>}
                        {advisorEnabled && <Text color="cyan">   · {t('advisor')}</Text>}
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
            setStaticHistory(prev => [...prev, { type: 'assistant', text: t('cmd_evolve_applied', { name: latest.skillName }) }]);
        } else {
            setStaticHistory(prev => [...prev, { type: 'assistant', text: t('cmd_evolve_none') }]);
        }
    } else if (sub === 'list') {
        if (pending.length === 0) {
            setStaticHistory(prev => [...prev, { type: 'assistant', text: t('cmd_evolve_list_empty') }]);
        } else {
            const lines = [t('cmd_evolve_list_title'), ''];
            pending.forEach((ev, i) => {
                lines.push(`  ${i + 1}. [${ev.skillName}] ${ev.reason.slice(0, 60)}${ev.reason.length > 60 ? '...' : ''}`);
                lines.push(`     ID: ${ev.id}`);
            });
            lines.push('\n' + t('cmd_evolve_usage'));
            setStaticHistory(prev => [...prev, { type: 'assistant', text: lines.join('\n') }]);
        }
    } else if (sub === 'apply' && arg) {
        const target = pending[parseInt(arg) - 1];
        if (target) { applyEvolution(target); removeEvolution(target.id); setStaticHistory(prev => [...prev, { type: 'assistant', text: t('cmd_evolve_applied', { name: target.skillName }) }]); }
        else          setStaticHistory(prev => [...prev, { type: 'assistant', text: t('cmd_evolve_invalid_index', { index: arg }) }]);
    } else if (sub === 'discard' && arg) {
        const target = pending[parseInt(arg) - 1];
        if (target) { removeEvolution(target.id); setStaticHistory(prev => [...prev, { type: 'assistant', text: t('cmd_evolve_discarded', { id: target.id }) }]); }
        else          setStaticHistory(prev => [...prev, { type: 'assistant', text: t('cmd_evolve_invalid_index', { index: arg }) }]);
    } else {
        setStaticHistory(prev => [...prev, { type: 'assistant', text: t('cmd_evolve_usage_full') }]);
    }
}

// ─── Entry point ──────────────────────────────────────────────────────────────
render(<App config={loadConfig()} />, { patchConsole: false });
