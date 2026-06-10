// ─── commands.js ──────────────────────────────────────────────────────────────
// Catálogo de slash commands y lógica de ejecución.
import fs   from 'fs';
import path from 'path';
import { spawn } from 'child_process';

import {
    CONFIG_DIR, MEMORY_FILE, HOOKS_FILE, MCP_FILE, AGENTS_DIR,
    normalizeConversationName, listConversations, conversationFile,
    loadSession, saveSession, clearLatestSession,
} from './session.js';
import { copyToClipboard, splitCommandArgs, runCommand } from './utils.js';
import { clearSkillsCache, formatSkillsIndex, readSkill } from './skills.js';
import { loadMcpConfig } from './mcp_utils.js';
import { isOllamaRunning } from './ollama_utils.js';
import { getEvolutions, getLatestEvolution, removeEvolution } from './evolution_store.js';
import { applyEvolution } from './evolution_engine.js';
import { consolidateHistory } from './consolidator.js';
import { buildAgent } from './agent.js';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import pkg from './package.json' with { type: 'json' };

export const AGENTLAG_VERSION = pkg.version;
export const EFFORT_LEVELS    = ['low', 'medium', 'high', 'xhigh', 'max'];

// ─── Catálogo ─────────────────────────────────────────────────────────────────
export const SLASH_COMMANDS = [
    { cmd: '/add-dir',     desc: ['Añadir un directorio al workspace de confianza'] },
    { cmd: '/advisor',     desc: ['Activar/desactivar modelo asesor para decisiones complejas'] },
    { cmd: '/agents',      desc: ['Listar subagentes definidos por el usuario'] },
    { cmd: '/branch',      desc: ['Guardar la conversación actual con un nuevo nombre'] },
    { cmd: '/btw',         desc: ['Lanzar una pregunta paralela sin romper el flujo'] },
    { cmd: '/clear',       desc: ['Limpiar el historial de la conversación'] },
    { cmd: '/color',       desc: ['Volver a abrir el selector de tema/color'] },
    { cmd: '/compact',     desc: ['Resumir el historial para liberar contexto'] },
    { cmd: '/config',      desc: ['Reiniciar y volver a correr el wizard completo'] },
    { cmd: '/context',     desc: ['Mostrar uso estimado de contexto/tokens'] },
    { cmd: '/copy',        desc: ['Copiar la última respuesta del asistente al portapapeles'] },
    { cmd: '/cwd',         desc: ['Mostrar el directorio de trabajo actual'] },
    { cmd: '/diff',        desc: ['Mostrar git diff de cambios sin confirmar'] },
    { cmd: '/doctor',      desc: ['Ejecutar diagnóstico de la instalación y proveedores'] },
    { cmd: '/download',    desc: ['Descargar un modelo de HuggingFace e importar a Ollama'] },
    { cmd: '/effort',      desc: ['Ajustar el nivel de esfuerzo del modelo (low|medium|high|xhigh|max)'] },
    { cmd: '/evolve',      desc: ['Aplicar la última evolución de habilidad sugerida'] },
    { cmd: '/exit',        desc: ['Guardar la sesión y salir'] },
    { cmd: '/export',      desc: ['Exportar la conversación a un archivo markdown'] },
    { cmd: '/feedback',    desc: ['Abrir la página de issues de GitHub para enviar feedback'] },
    { cmd: '/focus',       desc: ['Toggle modo focus (oculta tool spam)'] },
    { cmd: '/help',        desc: ['Mostrar todos los comandos disponibles'] },
    { cmd: '/hooks',       desc: ['Listar hooks configurados (~/.agentlag/hooks.json)'] },
    { cmd: '/ide',         desc: ['Mostrar estado de la integración con IDE'] },
    { cmd: '/import',      desc: ['Importar una conversación por nombre'] },
    { cmd: '/keybindings', desc: ['Mostrar los atajos de teclado disponibles'] },
    { cmd: '/logout',      desc: ['Borrar la API key del proveedor activo'] },
    { cmd: '/mcp',         desc: ['Listar servidores MCP configurados'] },
    { cmd: '/memory',      desc: ['Ver/editar ~/.agentlag/memory.md (notas del proyecto)'] },
    { cmd: '/model',       desc: ['Cambiar el modelo activo'] },
    { cmd: '/provider',    desc: ['Cambiar el proveedor de LLM activo'] },
    { cmd: '/quit',        desc: ['Guardar la sesión y salir'] },
    { cmd: '/react',       desc: ['Toggle modo ReAct (forzar fallback sin tools nativas)'] },
    { cmd: '/rename',      desc: ['Renombrar la conversación activa'] },
    { cmd: '/resume',      desc: ['Reanudar una conversación guardada por nombre'] },
    { cmd: '/sessions',    desc: ['Listar conversaciones guardadas en el proyecto'] },
    { cmd: '/schedule',    desc: ['Gestionar tareas programadas (list|add|remove)'] },
    { cmd: '/server',      desc: ['Iniciar el servidor web de AgentLag'] },
    { cmd: '/bot',         desc: ['Iniciar el bot de Telegram de AgentLag'] },
    { cmd: '/skills',      desc: ['Listar, leer, buscar o instalar skills de skills.sh'] },
    { cmd: '/version',     desc: ['Mostrar la versión de AgentLag'] },
];

// ─── Handler principal ────────────────────────────────────────────────────────
/**
 * Ejecuta un slash command.
 *
 * @param {string} trimmed   - Texto completo del input (ya sin espacios laterales).
 * @param {object} ctx       - Contexto de la aplicación (estado + setters).
 * @returns {boolean}        - true si el comando fue manejado; false si no era slash.
 */
export function handleSlashCommand(trimmed, ctx) {
    if (!trimmed.startsWith('/')) return false;

    const [head, ...rest] = trimmed.split(/\s+/);
    const cmd  = head.toLowerCase();
    const args = rest.join(' ').trim();

    const {
        cfg, saveAndExit,
        say, lastAssistantText, persistFlag, rebuildAgentWith,
        setScreen, setMenuIndex, setFormInput,
        setStaticHistory, setTotalTokens,
        msgRef, historyRef, currentConversationRef,
        totalTokens, effortLevel, setEffortLevel,
        focusMode, setFocusMode, forceReAct, setForceReAct,
        advisorEnabled, setAdvisorEnabled, setAgent,
        schedulerRef,
    } = ctx;

    switch (cmd) {
        case '/help': {
            const width   = Math.max(...SLASH_COMMANDS.map(c => c.cmd.length));
            const helpText = SLASH_COMMANDS
                .map(c => `  ${c.cmd.padEnd(width + 2)} ${c.desc.join(' ')}`)
                .join('\n');
            say(`Comandos disponibles:\n${helpText}`);
            return true;
        }

        case '/schedule': {
            const parts = args ? args.split(' ') : [];
            const sub   = parts[0];
            if (sub === 'list' || !sub) {
                const tasks = schedulerRef.current.listTasks();
                if (tasks.length === 0) say('No hay tareas programadas.');
                else {
                    const lines = ['📅 Tareas programadas:', ''];
                    tasks.forEach(t => lines.push(`  • ${t.id} [${t.cronExp}]: ${t.prompt}`));
                    say(lines.join('\n'));
                }
            } else if (sub === 'add') {
                const match = args.match(/add "([^"]+)" "([^"]+)" "([^"]+)"/);
                if (!match) say('Uso: /schedule add "id" "cron" "prompt"');
                else {
                    try {
                        schedulerRef.current.scheduleTask(match[1], match[2], match[3]);
                        say(`✅ Tarea ${match[1]} programada.`);
                    } catch (err) {
                        say(`❌ Error al programar tarea: ${err.message}`);
                    }
                }
            } else if (sub === 'remove') {
                if (!parts[1]) say('Uso: /schedule remove <id>');
                else {
                    const ok = schedulerRef.current.removeTask(parts[1]);
                    say(ok ? `✅ Tarea ${parts[1]} eliminada.` : `❌ Tarea ${parts[1]} no encontrada.`);
                }
            }
            return true;
        }

        case '/server': {
            say('🚀 Iniciando servidor en puerto ' + (process.env.PORT || 3000) + '...');
            spawn('node', ['server.js'], { detached: true, stdio: 'ignore' }).unref();
            return true;
        }

        case '/bot': {
            say('🤖 Iniciando bot de Telegram...');
            spawn('node', ['telegram.js'], { detached: true, stdio: 'ignore' }).unref();
            return true;
        }

        case '/version':
            say(`AgentLag v${AGENTLAG_VERSION}\nNode ${process.version} · ${process.platform}/${process.arch}`);
            return true;

        case '/cwd':
            say(`📁 ${process.cwd()}`);
            return true;

        case '/exit':
        case '/quit':
            saveAndExit();
            return true;

        case '/clear':
            setStaticHistory(prev => prev.filter(i => i.type === 'welcome'));
            msgRef.current = [];
            currentConversationRef.current = null;
            clearLatestSession();
            return true;

        case '/config':
            cfg.current = {};
            persistFlag('__reset__', true); // fuerza reescritura con objeto vacío
            saveConfig({});
            setScreen('color');
            return true;

        case '/color':
            cfg.current = { ...cfg.current, colorSet: false };
            persistFlag('colorSet', false);
            setMenuIndex(0);
            setScreen('color');
            return true;

        case '/provider':
            cfg.current = { ...cfg.current, provider: null, apiKey: null, model: null };
            persistFlag('provider', null);
            setMenuIndex(0); setFormInput('');
            setScreen('provider');
            return true;

        case '/model':
            if (!ctx.selProvider) setScreen('provider');
            else { setMenuIndex(0); setFormInput(''); setScreen('model'); }
            return true;

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
            persistFlag('apiKey', null);
            say(`🔒 API key borrada para ${provider}. Usa /provider para reconfigurar.`);
            return true;
        }

        case '/add-dir': {
            if (!args) { say('Uso: /add-dir <ruta>'); return true; }
            const target     = path.resolve(args);
            const trustedDirs = cfg.current.trustedDirs || [];
            if (trustedDirs.includes(target)) {
                say(`✓ ${target} ya estaba en la lista de confianza.`);
            } else {
                trustedDirs.push(target);
                cfg.current = { ...cfg.current, trustedDirs };
                persistFlag('trustedDirs', trustedDirs);
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
                    const trimmedOut = output.length > 4000
                        ? output.slice(0, 4000) + '\n…(truncado)'
                        : output;
                    say(trimmedOut || '(sin cambios pendientes)');
                }
            });
            return true;
        }

        case '/doctor': {
            const cfgNow = cfg.current || {};
            const lines  = [
                '🩺 Diagnóstico AgentLag',
                `  • Node ${process.version} · ${process.platform}/${process.arch}`,
                `  • Versión: ${AGENTLAG_VERSION}`,
                `  • cwd: ${process.cwd()}`,
                `  • Provider: ${cfgNow.provider || '(sin configurar)'}`,
                `  • Modelo: ${cfgNow.model || '(sin configurar)'}`,
                `  • API key guardada: ${cfgNow.apiKey ? 'sí' : 'no'}`,
                `  • Effort: ${effortLevel}`,
                `  • ReAct forzado: ${forceReAct ? 'sí' : 'no'}`,
                `  • Tavily key: ${process.env.TAVILY_API_KEY ? 'sí' : 'no'}`,
                `  • Mensajes en sesión: ${msgRef.current.length}`,
            ];
            say(lines.join('\n'));
            if (cfgNow.provider === 'ollama' || cfgNow.provider === 'huggingface') {
                isOllamaRunning().then(running =>
                    say(`  • Ollama corriendo: ${running ? 'sí' : 'no (ollama serve)'}`)
                );
            }
            return true;
        }

        case '/context': {
            say([
                '📊 Contexto',
                `  • Tokens acumulados: ${totalTokens}`,
                `  • Mensajes en memoria: ${msgRef.current.length}`,
                `  • Items en historial UI: ${historyRef.current.length}`,
                `  • Conversación activa: ${currentConversationRef.current || '(latest)'}`,
            ].join('\n'));
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
                    { type: 'assistant', text: `🗜 Compactados ${removed} mensajes en un resumen.`, ephemeral: true },
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
            const file  = path.join(dir, `${safe}.md`);
            const lines = ['# AgentLag conversation', '', `_exported: ${new Date().toISOString()}_`, ''];
            for (const item of historyRef.current) {
                if (item.type === 'user')      lines.push(`## 🧑 user`,      '', item.text || '', '');
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

        case '/feedback':
            say(`💬 Envía feedback / bugs:\n  https://github.com/andreslpxz/AgentLag_npm/issues/new\n\nIncluye versión (${AGENTLAG_VERSION}), provider y un resumen.`);
            return true;

        case '/keybindings':
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

        case '/hooks': {
            let data = {};
            try { data = JSON.parse(fs.readFileSync(HOOKS_FILE, 'utf8')); } catch {}
            const entries = Object.entries(data);
            if (entries.length === 0) {
                say(`🪝 No hay hooks configurados.\nEdita ${HOOKS_FILE} para añadir, ej:\n{\n  "PreToolUse":  ["echo about to run a tool"],\n  "PostToolUse": ["echo finished"]\n}`);
            } else {
                const lines = ['🪝 Hooks configurados:'];
                for (const [event, cmds] of entries)
                    lines.push(`  • ${event}: ${(Array.isArray(cmds) ? cmds : [cmds]).join(' ; ')}`);
                say(lines.join('\n'));
            }
            return true;
        }

        case '/mcp': {
            const data    = loadMcpConfig();
            const servers = Object.entries(data?.mcpServers || {});
            if (servers.length === 0) {
                say(`🔌 No hay servidores MCP configurados.\nCrea ${MCP_FILE} con:\n{\n  "mcpServers": {\n    "playwright": { "command": "npx", "args": ["-y","@playwright/mcp@latest"] }\n  }\n}`);
            } else {
                const lines = ['🔌 MCP servers:'];
                for (const [name, def] of servers)
                    lines.push(`  • ${name}: ${def.command || ''} ${(def.args || []).join(' ')}`);
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
            const term  = process.env.TERM_PROGRAM || process.env.TERM || 'unknown';
            const inIDE = !!(process.env.VSCODE_INJECTION || process.env.CURSOR_TRACE_ID || process.env.JETBRAINS_IDE);
            say(`💻 IDE/terminal: ${term}\n  • Detectado dentro de IDE: ${inIDE ? 'sí' : 'no'}\n  • La integración profunda con IDEs aún no está implementada.`);
            return true;
        }

        case '/consolidate': {
            if (!historyRef.current.length) {
                say('⚠️ No hay mensajes en la sesión actual para consolidar.');
                return true;
            }
            say('🧠 Consolidando historial en Knowledge Graph L3 (Kuzu)...');
            (async () => {
                try {
                    const ag  = await buildAgent();
                    const res = await consolidateHistory(historyRef.current, ag.llm);
                    say(res);
                } catch (e) {
                    say(`❌ Error en consolidación: ${e.message}`);
                }
            })();
            return true;
        }

        case '/memory': {
            let content = '';
            try { content = fs.readFileSync(MEMORY_FILE, 'utf8'); } catch {}
            if (!args) {
                if (!content.trim())
                    say(`🧠 Memoria vacía. Crea/edita ${MEMORY_FILE} o usa:\n  /memory add <nota>     añade una línea`);
                else
                    say(`🧠 Memoria (${MEMORY_FILE}):\n\n${content.trim()}`);
                return true;
            }
            const sub  = rest[0]?.toLowerCase();
            const note = rest.slice(1).join(' ').trim();
            if (sub === 'add' && note) {
                try { /* ensureDir ya garantiza CONFIG_DIR */ } catch {}
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
            const sub  = (subRaw || 'list').toLowerCase();
            const tail = subArgs.join(' ').trim();

            if (sub === 'list') {
                say(`🧩 Skills instaladas:\n${formatSkillsIndex(process.cwd())}`);
                return true;
            }
            if (sub === 'read') {
                if (!tail) { say('Uso: /skills read <nombre>\nEjemplo: /skills read find-skills'); return true; }
                const skill = readSkill(tail, process.cwd());
                if (!skill) say(`⚠ No encontré la skill "${tail}". Usa /skills list.`);
                else say(`📘 ${skill.name} (${skill.scope})\n${skill.path}\n\n${skill.content}`);
                return true;
            }
            if (sub === 'find' || sub === 'search') {
                if (!tail) { say('Uso: /skills find <consulta>\nEjemplo: /skills find image optimization'); return true; }
                say(`⏳ Buscando skills: ${tail}`, true);
                runCommand('npx', ['-y', 'skills', 'find', tail]).then(({ code, output }) => {
                    const clean = output.trim() || '(sin salida)';
                    say(code === 0 ? clean : `❌ Error buscando skills:\n${clean}`);
                });
                return true;
            }
            if (sub === 'add' || sub === 'install') {
                const parsedArgs = splitCommandArgs(subArgs.join(' '));
                const source     = parsedArgs[0];
                if (!source) {
                    say('Uso: /skills add <source> [--skill nombre] [--global] [--copy]\nEjemplo: /skills add https://github.com/vercel-labs/skills --skill find-skills');
                    return true;
                }
                const extra = parsedArgs.slice(1);
                say(`⏳ Instalando skill desde ${source}…`, true);
                runCommand('npx', ['-y', 'skills', 'add', source, '-y', ...extra]).then(({ code, output }) => {
                    const clean = output.trim() || '(sin salida)';
                    say(code === 0 ? clean : `❌ Error instalando skill:\n${clean}`);
                    if (code === 0) { clearSkillsCache(); rebuildAgentWith(); }
                });
                return true;
            }
            if (sub === 'check' || sub === 'update') {
                say(`⏳ Ejecutando skills ${sub}…`, true);
                runCommand('npx', ['-y', 'skills', sub, '-y']).then(({ code, output }) => {
                    const clean = output.trim() || '(sin salida)';
                    say(code === 0 ? clean : `❌ Error en skills ${sub}:\n${clean}`);
                    if (code === 0) { clearSkillsCache(); rebuildAgentWith(); }
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
            const s = loadSession(args);
            if (s.history?.length) {
                currentConversationRef.current =
                    s.name || normalizeConversationName(args) || currentConversationRef.current;
                msgRef.current = s.history.map(m =>
                    m.type === 'user' ? new HumanMessage(m.text) : new AIMessage(m.text)
                );
                const welcome = historyRef.current.find(i => i.type === 'welcome');
                setStaticHistory([
                    ...(welcome ? [welcome] : []),
                    ...s.history,
                    { type: 'assistant', text: `Historial importado: ${s.name || args || 'latest'}.`, ephemeral: true },
                ]);
            } else {
                const available = listConversations();
                const suffix    = available.length ? `\nDisponibles: ${available.join(', ')}` : '';
                say(`No hay historial para importar${args ? `: ${args}` : ' en este proyecto'}.${suffix}`, true);
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
            const branchName = args
                ? normalizeConversationName(args)
                : `${currentConversationRef.current || 'branch'}-${Date.now().toString(36)}`;
            const saved = saveSession(historyRef.current, branchName);
            if (saved?.name) {
                currentConversationRef.current = saved.name;
                say(`🌿 Branch creado: ${saved.name}. La conversación actual ahora se guarda con ese nombre.`);
            } else {
                say('⚠ No hay nada que ramificar todavía.');
            }
            return true;
        }

        case '/btw':
            say(args
                ? `📝 Nota lateral: ${args}`
                : '📝 Modo nota / side question. Escribe la pregunta paralela como un mensaje normal — no romperá el flujo principal.');
            return true;

        default:
            return false;
    }
}
