// ─── commands.js ──────────────────────────────────────────────────────────────
// Catálogo de slash commands y lógica de ejecución.
import fs   from 'fs';
import path from 'path';
import { spawn, execSync } from 'child_process';

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
import { webSearch } from './tools.js';
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
    { cmd: '/deepsearch',  desc: ['Busca en profundidad sobre un tema y guarda los resultados en un .md'] },
    { cmd: '/standup',     desc: ['Genera un resumen del día listo para Slack/Teams basado en la sesión'] },
    { cmd: '/review',      desc: ['Code review completo de un archivo: bugs, mejoras, seguridad'] },
    { cmd: '/changelog',   desc: ['Lee los commits de git y genera un CHANGELOG.md automático'] },
    { cmd: '/todo',        desc: ['Escanea el proyecto buscando TODO/FIXME/HACK y los consolida en un .md'] },
    { cmd: '/audit',       desc: ['Auditoría de seguridad: dependencias vulnerables, secrets expuestos'] },
    { cmd: '/explain',     desc: ['Genera documentación técnica de un archivo y la guarda en .md'] },
    { cmd: '/diagram',     desc: ['Analiza el codebase y genera un diagrama de arquitectura en Mermaid'] },
    { cmd: '/task',        desc: ['Divide una tarea en subtareas y las delega a subagentes en paralelo'] },
    { cmd: '/draft',       desc: ['Genera borradores: email, PR description, issue de GitHub'] },
    { cmd: '/compare',     desc: ['Compara dos archivos semánticamente y muestra diferencias clave'] },
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

        // ─── /deepsearch <tema> ───────────────────────────────────────────────
        // Realiza una investigación profunda sobre un tema usando múltiples
        // búsquedas web y guarda los resultados en un archivo .md.
        //
        // Uso:
        //   /deepsearch inteligencia artificial
        //   /deepsearch "modelos de lenguaje 2024"
        //
        // Opciones de salida:
        //   El archivo se guarda en .agentlag/deepsearch/<tema-normalizado>.md
        //   con fecha, fuentes, resumen y secciones por subtema.
        //
        // Cómo funciona:
        //   1. Genera automáticamente 5 subpreguntas derivadas del tema.
        //   2. Ejecuta una búsqueda web por cada subpregunta (usando Tavily
        //      si TAVILY_API_KEY está en .env, o DuckDuckGo como fallback).
        //   3. Consolida los resultados en un documento Markdown estructurado.
        //   4. Guarda el archivo y muestra la ruta al usuario.
        // ─────────────────────────────────────────────────────────────────────
        case '/deepsearch': {
            if (!args) {
                say('Uso: /deepsearch <tema>\nEjemplo: /deepsearch inteligencia artificial\n\nRealiza una investigación profunda y guarda los resultados en un archivo .md');
                return true;
            }

            const topic = args.trim();
            say(`🔍 Iniciando Deep Search sobre: "${topic.slice(0, 50)}${topic.length > 50 ? '...' : ''}"\nEsto puede tardar unos segundos...`);

            (async () => {
                let subQuestions = [];
                try {
                    // Generar subpreguntas inteligentes usando el LLM
                    const prompt = `Eres un experto investigador. Dado el tema "${topic}", genera exactamente 5 sub-preguntas cortas y específicas para realizar una investigación profunda. Devuelve solo las preguntas, una por línea, sin numeración ni texto adicional.`;
                    const llmResponse = await agent.llm.invoke(prompt);
                    subQuestions = llmResponse.content.trim().split('\n')
                        .map(q => q.replace(/^\d+[\.\)]\s*/, '').trim())
                        .filter(q => q.length > 3)
                        .slice(0, 5);
                } catch (e) {
                    subQuestions = [
                        `¿Qué es ${topic}? definición y conceptos básicos`,
                        `${topic} últimas novedades y avances recientes`,
                        `${topic} aplicaciones prácticas y casos de uso`,
                        `${topic} ventajas desventajas y limitaciones`,
                        `${topic} herramientas frameworks y recursos recomendados`,
                    ];
                }

                const results = [];
                let errorCount = 0;
                let statusIndex = -1;

                const updateStatus = (text) => {
                    setStaticHistory(prev => {
                        const next = [...prev];
                        if (statusIndex === -1) {
                            statusIndex = next.length;
                            next.push({ type: 'assistant', text });
                        } else {
                            next[statusIndex] = { type: 'assistant', text };
                        }
                        return next;
                    });
                };

                updateStatus(`🔍 Investigando: ○ ○ ○ ○ ○`);

                for (let i = 0; i < subQuestions.length; i++) {
                    const question = subQuestions[i];
                    try {
                        const result = await webSearch.invoke({ query: question });
                        results.push({ question, content: result });
                    } catch (e) {
                        results.push({ question, content: `⚠️ Error al buscar: ${e.message}` });
                        errorCount++;
                    }
                    const dots = '● '.repeat(i + 1) + '○ '.repeat(subQuestions.length - (i + 1));
                    updateStatus(`🔍 Investigando: ${dots.trim()}`);
                }

                // Construir el documento Markdown
                const timestamp  = new Date().toISOString();
                const dateStr    = new Date().toLocaleDateString('es-ES', { year: 'numeric', month: 'long', day: 'numeric' });
                const safeTopic  = normalizeConversationName(topic) || `deepsearch-${Date.now()}`;
                const outDir     = path.join(process.cwd(), '.agentlag', 'deepsearch');
                const outFile    = path.join(outDir, `${safeTopic}.md`);

                const sections = results.map(({ question, content }, i) => {
                    return [
                        `## Sección ${i + 1}: ${question}`,
                        '',
                        content,
                        '',
                    ].join('\n');
                });

                const doc = [
                    `# 🔍 Deep Search: ${topic}`,
                    '',
                    `> **Generado:** ${dateStr}  `,
                    `> **Timestamp:** \`${timestamp}\`  `,
                    `> **Subtemas investigados:** ${subQuestions.length}  `,
                    errorCount > 0 ? `> ⚠️ **Advertencia:** ${errorCount} búsqueda(s) fallaron.` : '',
                    '',
                    '---',
                    '',
                    ...sections,
                    '---',
                    '',
                    `_Documento generado automáticamente por AgentLag /deepsearch_`,
                ].filter(line => line !== undefined).join('\n');

                try {
                    fs.mkdirSync(outDir, { recursive: true });
                    fs.writeFileSync(outFile, doc, 'utf8');
                    updateStatus([
                        `✅ Deep Search completado`,
                        `📄 Documento: ${outFile}`,
                        `📊 ${subQuestions.length} subtemas investigados`,
                    ].join('\n'));
                } catch (e) {
                    updateStatus(`❌ Deep Search completado pero falló al guardar: ${e.message}\n\nResultados:\n${doc.slice(0, 500)}...`);
                }
            })();

            return true;
        }

        // ─── /standup ─────────────────────────────────────────────────────────
        // Genera un resumen del día basado en el historial de la sesión actual,
        // listo para copiar a Slack, Teams o una daily standup.
        //
        // Uso:
        //   /standup
        //   /standup mi-equipo   (guarda en .agentlag/standups/mi-equipo.md)
        //
        // El documento incluye:
        //   - Tareas completadas (mensajes del asistente con acciones ejecutadas)
        //   - Próximos pasos detectados en la conversación
        //   - Blockers mencionados
        // ─────────────────────────────────────────────────────────────────────
        case '/standup': {
            const history = historyRef.current;
            if (!history || history.length === 0) {
                say('⚠️ No hay historial en esta sesión para generar un standup.');
                return true;
            }

            const name     = args ? normalizeConversationName(args) : `standup-${new Date().toISOString().slice(0,10)}`;
            const outDir   = path.join(process.cwd(), '.agentlag', 'standups');
            const outFile  = path.join(outDir, `${name}.md`);
            const dateStr  = new Date().toLocaleDateString('es-ES', { year: 'numeric', month: 'long', day: 'numeric' });

            // Extraer mensajes relevantes del historial
            const userMsgs = history.filter(i => i.type === 'user').map(i => `- ${i.text}`).join('\n') || '_Sin mensajes de usuario_';
            const asstMsgs = history.filter(i => i.type === 'assistant').map(i => i.text?.slice(0, 200)).filter(Boolean);
            const toolMsgs = history.filter(i => i.type === 'tool').map(i => `- \`${i.name}\`: ${String(i.output || '').slice(0, 120)}`).join('\n') || '_Sin herramientas usadas_';

            // Detectar posibles blockers y próximos pasos (heurística simple)
            const blockers   = asstMsgs.filter(t => /error|fall[oó]|problema|bloq|no (se |puedo|pude)/i.test(t)).map(t => `- ${t.slice(0,150)}`).join('\n') || '_Sin blockers detectados_';
            const nextSteps  = asstMsgs.filter(t => /próximo|siguiente|pendiente|falta|deber[ií]as|recomiend/i.test(t)).map(t => `- ${t.slice(0,150)}`).join('\n') || '_Sin próximos pasos detectados_';
            const completed  = asstMsgs.filter(t => /✅|completad|listo|generado|guardado|creado|actualizado/i.test(t)).map(t => `- ${t.slice(0,150)}`).join('\n') || '_Sin tareas completadas detectadas_';

            const doc = [
                `# 📋 Standup — ${dateStr}`,
                '',
                `> _Generado automáticamente por AgentLag /standup_`,
                '',
                '---',
                '',
                '## ✅ ¿Qué hice hoy?',
                '',
                completed,
                '',
                '## 🔧 Herramientas y acciones ejecutadas',
                '',
                toolMsgs,
                '',
                '## 📝 Preguntas / tareas del usuario',
                '',
                userMsgs,
                '',
                '## 🚧 Blockers',
                '',
                blockers,
                '',
                '## ➡️ Próximos pasos',
                '',
                nextSteps,
                '',
                '---',
                `_Sesión: ${history.length} mensajes · ${new Date().toISOString()}_`,
            ].join('\n');

            try {
                fs.mkdirSync(outDir, { recursive: true });
                fs.writeFileSync(outFile, doc, 'utf8');
                say([
                    '📋 **Standup generado:**',
                    '',
                    `✅ Tareas completadas detectadas: ${completed.split('\n').filter(l=>l.startsWith('-')).length}`,
                    `🚧 Blockers: ${blockers.split('\n').filter(l=>l.startsWith('-')).length}`,
                    `➡️ Próximos pasos: ${nextSteps.split('\n').filter(l=>l.startsWith('-')).length}`,
                    '',
                    `📄 Guardado en: ${outFile}`,
                ].join('\n'));
            } catch (e) {
                say(`❌ Error guardando standup: ${e.message}\n\n${doc.slice(0, 800)}`);
            }
            return true;
        }

        // ─── /review <archivo> ────────────────────────────────────────────────
        // Hace un code review completo de un archivo: bugs, mejoras, seguridad,
        // estilo y complejidad. Guarda el reporte en .agentlag/reviews/.
        //
        // Uso:
        //   /review src/index.js
        //   /review utils/helpers.py
        // ─────────────────────────────────────────────────────────────────────
        case '/review': {
            if (!args) {
                say('Uso: /review <archivo>\nEjemplo: /review src/index.js\n\nHace un code review completo y guarda el reporte en .agentlag/reviews/');
                return true;
            }

            const filePath = path.resolve(process.cwd(), args.trim());
            let fileContent;
            try {
                fileContent = fs.readFileSync(filePath, 'utf8');
            } catch (e) {
                say(`❌ No se pudo leer el archivo: ${filePath}\n${e.message}`);
                return true;
            }

            say(`🔍 Analizando ${args.trim()}... (esto puede tardar unos segundos)`);

            const ext      = path.extname(filePath).replace('.', '') || 'txt';
            const lines    = fileContent.split('\n').length;
            const outDir   = path.join(process.cwd(), '.agentlag', 'reviews');
            const safeName = path.basename(filePath).replace(/[^a-z0-9]/gi, '-');
            const outFile  = path.join(outDir, `review-${safeName}-${Date.now()}.md`);
            const dateStr  = new Date().toLocaleDateString('es-ES', { year: 'numeric', month: 'long', day: 'numeric' });

            // Análisis heurístico del código
            const issues = [];

            // Detectar posibles problemas comunes
            if (/console\.log|print\(|debugger/g.test(fileContent))
                issues.push('⚠️ **Debug statements** encontrados (`console.log`, `print`, `debugger`). Eliminar antes de producción.');
            if (/TODO|FIXME|HACK|XXX/g.test(fileContent))
                issues.push('📝 **TODOs/FIXMEs** pendientes en el código.');
            if (/password|secret|api_key|apikey|token\s*=/gi.test(fileContent))
                issues.push('🔴 **Posible secret hardcodeado** detectado. Mover a variables de entorno.');
            if (/catch\s*\(\s*\)\s*\{?\s*\}|except\s*:\s*pass/g.test(fileContent))
                issues.push('⚠️ **Catch/except vacío** detectado. Los errores se están silenciando.');
            if (lines > 500)
                issues.push(`📏 **Archivo muy largo** (${lines} líneas). Considerar dividir en módulos más pequeños.`);
            if (/eval\s*\(|exec\s*\(/g.test(fileContent))
                issues.push('🔴 **Uso de `eval`/`exec`** detectado. Riesgo de seguridad.');
            if (/http:\/\//g.test(fileContent))
                issues.push('⚠️ **URLs HTTP** (no HTTPS) detectadas.');

            const issueBlock = issues.length > 0 ? issues.join('\n') : '✅ No se detectaron problemas automáticos evidentes.';

            // Métricas básicas
            const fnMatches   = fileContent.match(/function\s+\w+|=>\s*\{|def\s+\w+|func\s+\w+/g) || [];
            const importLines = fileContent.split('\n').filter(l => /^import|^from|^require/.test(l.trim()));
            const commentLines= fileContent.split('\n').filter(l => /^\s*(\/\/|#|\/\*)/.test(l)).length;
            const commentRatio= lines > 0 ? Math.round((commentLines / lines) * 100) : 0;

            const doc = [
                `# 🔍 Code Review: \`${path.basename(filePath)}\``,
                '',
                `> **Fecha:** ${dateStr}  `,
                `> **Archivo:** \`${filePath}\`  `,
                `> **Lenguaje:** ${ext}  `,
                `> **Líneas:** ${lines} | **Funciones detectadas:** ${fnMatches.length} | **Imports:** ${importLines.length}  `,
                `> **Ratio comentarios:** ${commentRatio}%`,
                '',
                '---',
                '',
                '## 🚨 Problemas detectados automáticamente',
                '',
                issueBlock,
                '',
                '## 📊 Métricas',
                '',
                `| Métrica | Valor |`,
                `|---------|-------|`,
                `| Líneas totales | ${lines} |`,
                `| Funciones / métodos | ${fnMatches.length} |`,
                `| Imports / dependencias | ${importLines.length} |`,
                `| Líneas de comentario | ${commentLines} (${commentRatio}%) |`,
                '',
                '## 📦 Imports detectados',
                '',
                importLines.length > 0 ? importLines.map(l => `- \`${l.trim()}\``).join('\n') : '_Sin imports detectados_',
                '',
                '## 📄 Contenido analizado',
                '',
                '```' + ext,
                fileContent.slice(0, 3000) + (fileContent.length > 3000 ? '\n\n... (truncado)' : ''),
                '```',
                '',
                '---',
                `_Review generado por AgentLag /review · ${new Date().toISOString()}_`,
            ].join('\n');

            try {
                fs.mkdirSync(outDir, { recursive: true });
                fs.writeFileSync(outFile, doc, 'utf8');
                say([
                    `✅ Code review completado: \`${path.basename(filePath)}\``,
                    '',
                    issueBlock,
                    '',
                    `📄 Reporte completo en: ${outFile}`,
                ].join('\n'));
            } catch (e) {
                say(`❌ Error guardando review: ${e.message}\n\n${issueBlock}`);
            }
            return true;
        }

        // ─── /changelog ───────────────────────────────────────────────────────
        // Lee los commits de git del proyecto y genera un CHANGELOG.md
        // automático agrupado por fecha y tipo de commit (feat, fix, docs…).
        //
        // Uso:
        //   /changelog           (últimos 50 commits)
        //   /changelog 100       (últimos N commits)
        // ─────────────────────────────────────────────────────────────────────
        case '/changelog': {
            const limit   = parseInt(args) || 50;
            const outFile = path.join(process.cwd(), 'CHANGELOG.md');
            say(`📝 Generando CHANGELOG con los últimos ${limit} commits...`);

            let gitLog;
            try {
                gitLog = execSync(
                    `git log --pretty=format:"%ad|%s|%an" --date=short -n ${limit}`,
                    { cwd: process.cwd(), encoding: 'utf8', timeout: 15000 }
                );
            } catch (e) {
                say(`❌ Error leyendo git log: ${e.message}\nAsegúrate de estar en un repositorio git.`);
                return true;
            }

            if (!gitLog.trim()) {
                say('⚠️ No se encontraron commits en este repositorio.');
                return true;
            }

            // Parsear y agrupar commits por fecha
            const commits = gitLog.trim().split('\n').map(line => {
                const [date, subject, author] = line.split('|');
                // Detectar tipo convencional
                const typeMatch = subject?.match(/^(feat|fix|docs|style|refactor|test|chore|perf|ci|build|revert)(\(.+?\))?:/i);
                const type   = typeMatch ? typeMatch[1].toLowerCase() : 'other';
                const clean  = typeMatch ? subject.slice(typeMatch[0].length).trim() : subject?.trim();
                return { date: date?.trim(), subject: clean || subject?.trim(), author: author?.trim(), type };
            }).filter(c => c.date && c.subject);

            // Agrupar por fecha
            const byDate = {};
            for (const c of commits) {
                if (!byDate[c.date]) byDate[c.date] = [];
                byDate[c.date].push(c);
            }

            const typeEmoji = { feat:'✨', fix:'🐛', docs:'📝', style:'💄', refactor:'♻️', test:'✅', chore:'🔧', perf:'⚡', ci:'👷', build:'📦', revert:'⏪', other:'🔹' };
            const typeLabel = { feat:'Features', fix:'Bug Fixes', docs:'Documentation', style:'Styles', refactor:'Refactoring', test:'Tests', chore:'Chores', perf:'Performance', ci:'CI', build:'Build', revert:'Reverts', other:'Other' };

            const sections = Object.entries(byDate).map(([date, cms]) => {
                const byType = {};
                for (const c of cms) {
                    if (!byType[c.type]) byType[c.type] = [];
                    byType[c.type].push(c);
                }
                const typeBlocks = Object.entries(byType).map(([type, items]) =>
                    `### ${typeEmoji[type] || '🔹'} ${typeLabel[type] || type}\n${items.map(i => `- ${i.subject} _(${i.author})_`).join('\n')}`
                ).join('\n\n');
                return `## ${date}\n\n${typeBlocks}`;
            }).join('\n\n---\n\n');

            const doc = [
                '# 📋 CHANGELOG',
                '',
                `> _Generado automáticamente por AgentLag /changelog · ${new Date().toISOString()}_`,
                `> _Commits analizados: ${commits.length}_`,
                '',
                '---',
                '',
                sections,
            ].join('\n');

            try {
                fs.writeFileSync(outFile, doc, 'utf8');
                say(`✅ CHANGELOG generado con ${commits.length} commits\n📄 Guardado en: ${outFile}`);
            } catch (e) {
                say(`❌ Error guardando CHANGELOG: ${e.message}`);
            }
            return true;
        }

        // ─── /todo ────────────────────────────────────────────────────────────
        // Escanea todos los archivos del proyecto buscando comentarios TODO,
        // FIXME, HACK, XXX y los consolida en un archivo .md con contexto.
        //
        // Uso:
        //   /todo
        //   /todo src/    (solo en una carpeta)
        // ─────────────────────────────────────────────────────────────────────
        case '/todo': {
            const scanDir = args ? path.resolve(process.cwd(), args.trim()) : process.cwd();
            say(`🔍 Escaneando TODOs en: ${scanDir}`);

            let grepOutput;
            try {
                grepOutput = execSync(
                    `grep -rIn --include="*.js" --include="*.ts" --include="*.jsx" --include="*.tsx" --include="*.py" --include="*.go" --include="*.rs" --include="*.java" --include="*.php" --include="*.rb" --include="*.css" --include="*.md" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=build -E "(TODO|FIXME|HACK|XXX|BUG|NOTE):?" "${scanDir}" 2>/dev/null || true`,
                    { encoding: 'utf8', timeout: 30000 }
                );
            } catch (e) {
                grepOutput = '';
            }

            const lines = grepOutput.trim().split('\n').filter(Boolean);

            if (lines.length === 0) {
                say('✅ No se encontraron TODOs, FIXMEs ni HARAKs en el proyecto. ¡Código limpio!');
                return true;
            }

            // Parsear resultados
            const items = lines.map(line => {
                const match = line.match(/^(.+?):(\d+):.*(TODO|FIXME|HACK|XXX|BUG|NOTE)[:\s]*(.*)/i);
                if (!match) return null;
                const [, file, lineNum, type, text] = match;
                const relFile = path.relative(process.cwd(), file);
                return { file: relFile, line: lineNum, type: type.toUpperCase(), text: text.trim() };
            }).filter(Boolean);

            // Agrupar por tipo
            const byType = {};
            for (const item of items) {
                if (!byType[item.type]) byType[item.type] = [];
                byType[item.type].push(item);
            }

            const typeEmoji2 = { TODO:'📝', FIXME:'🔴', HACK:'⚠️', XXX:'❌', BUG:'🐛', NOTE:'💡' };

            const sections2 = Object.entries(byType).map(([type, entries]) => {
                const rows = entries.map(e => `| \`${e.file}:${e.line}\` | ${e.text || '_sin descripción_'} |`).join('\n');
                return `## ${typeEmoji2[type] || '🔹'} ${type} (${entries.length})\n\n| Ubicación | Descripción |\n|-----------|-------------|\n${rows}`;
            }).join('\n\n');

            const outDir2  = path.join(process.cwd(), '.agentlag');
            const outFile2 = path.join(outDir2, 'TODO.md');
            const dateStr2 = new Date().toLocaleDateString('es-ES', { year: 'numeric', month: 'long', day: 'numeric' });

            const doc = [
                `# 📝 TODO List — ${dateStr2}`,
                '',
                `> **Total encontrados:** ${items.length}  `,
                `> **Directorio escaneado:** \`${scanDir}\`  `,
                `> _Generado por AgentLag /todo · ${new Date().toISOString()}_`,
                '',
                '---',
                '',
                sections2,
            ].join('\n');

            try {
                fs.mkdirSync(outDir2, { recursive: true });
                fs.writeFileSync(outFile2, doc, 'utf8');
                const summary = Object.entries(byType).map(([t, e]) => `${typeEmoji2[t]||'🔹'} ${t}: ${e.length}`).join(' · ');
                say(`✅ Encontrados ${items.length} items: ${summary}\n📄 Guardado en: ${outFile2}`);
            } catch (e) {
                say(`❌ Error guardando TODO.md: ${e.message}`);
            }
            return true;
        }

        // ─── /audit ───────────────────────────────────────────────────────────
        // Auditoría de seguridad del proyecto: detecta dependencias con
        // vulnerabilidades (npm audit), secrets expuestos y patrones peligrosos.
        //
        // Uso:
        //   /audit
        // ─────────────────────────────────────────────────────────────────────
        case '/audit': {
            say('🔐 Iniciando auditoría de seguridad...');
            const outDir3  = path.join(process.cwd(), '.agentlag', 'audits');
            const outFile3 = path.join(outDir3, `audit-${Date.now()}.md`);
            const dateStr3 = new Date().toLocaleDateString('es-ES', { year: 'numeric', month: 'long', day: 'numeric' });

            const sections3 = [];

            // 1. npm audit
            let npmAudit = '_No se pudo ejecutar npm audit (¿no es un proyecto Node.js?)_';
            try {
                npmAudit = execSync('npm audit --json 2>/dev/null', { cwd: process.cwd(), encoding: 'utf8', timeout: 30000 });
                const auditData = JSON.parse(npmAudit);
                const vulns = auditData.metadata?.vulnerabilities || {};
                const total = (vulns.critical||0) + (vulns.high||0) + (vulns.moderate||0) + (vulns.low||0);
                npmAudit = total === 0
                    ? '✅ Sin vulnerabilidades detectadas por npm audit.'
                    : `🔴 **${total} vulnerabilidades**: Critical: ${vulns.critical||0} · High: ${vulns.high||0} · Moderate: ${vulns.moderate||0} · Low: ${vulns.low||0}\n\nEjecuta \`npm audit fix\` para corregirlas.`;
            } catch (e) {
                npmAudit = `⚠️ npm audit no disponible: ${e.message.slice(0,100)}`;
            }
            sections3.push(`## 📦 Dependencias (npm audit)\n\n${npmAudit}`);

            // 2. Buscar secrets expuestos
            say('  🔍 Buscando secrets expuestos...');
            let secretsFound = [];
            try {
                const secretPatterns = [
                    { label: 'API Key hardcodeada', pattern: '(api_key|apikey|APIKEY)\\s*=\\s*["\'][^"\']{8,}' },
                    { label: 'Password hardcodeada', pattern: '(password|passwd|pwd)\\s*=\\s*["\'][^"\']{4,}' },
                    { label: 'Token hardcodeado',    pattern: '(token|TOKEN)\\s*=\\s*["\'][^"\']{8,}' },
                    { label: 'Secret hardcodeado',   pattern: '(secret|SECRET)\\s*=\\s*["\'][^"\']{8,}' },
                    { label: 'AWS Key',              pattern: 'AKIA[0-9A-Z]{16}' },
                    { label: 'Private Key',          pattern: 'BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY' },
                ];
                for (const { label, pattern } of secretPatterns) {
                    try {
                        const result = execSync(
                            `grep -rIn --exclude-dir=node_modules --exclude-dir=.git --exclude="*.lock" -E "${pattern}" "${process.cwd()}" 2>/dev/null || true`,
                            { encoding: 'utf8', timeout: 10000 }
                        );
                        if (result.trim()) {
                            const hits = result.trim().split('\n').slice(0,3).map(l => `  - \`${path.relative(process.cwd(), l.split(':')[0])}:${l.split(':')[1]}\``).join('\n');
                            secretsFound.push(`🔴 **${label}**:\n${hits}`);
                        }
                    } catch {}
                }
            } catch {}
            sections3.push(`## 🔑 Secrets expuestos\n\n${secretsFound.length > 0 ? secretsFound.join('\n\n') : '✅ No se detectaron secrets hardcodeados.'}`);

            // 3. Patrones peligrosos en código
            say('  🔍 Buscando patrones peligrosos...');
            const dangerPatterns = [];
            try {
                const dangerous = [
                    { label: 'eval()',           pattern: 'eval\\s*\\(' },
                    { label: 'exec() dinámico',  pattern: 'exec\\s*\\(' },
                    { label: 'innerHTML directo',pattern: '\\.innerHTML\\s*=' },
                    { label: 'HTTP sin HTTPS',   pattern: 'http://' },
                    { label: 'Catch vacío',      pattern: 'catch\\s*\\(.*\\)\\s*\\{\\s*\\}' },
                ];
                for (const { label, pattern } of dangerous) {
                    try {
                        const result = execSync(
                            `grep -rlIn --exclude-dir=node_modules --exclude-dir=.git -E "${pattern}" "${process.cwd()}" 2>/dev/null || true`,
                            { encoding: 'utf8', timeout: 10000 }
                        );
                        if (result.trim()) {
                            const files = result.trim().split('\n').slice(0,3).map(f => `\`${path.relative(process.cwd(), f)}\``).join(', ');
                            dangerPatterns.push(`⚠️ **${label}** en: ${files}`);
                        }
                    } catch {}
                }
            } catch {}
            sections3.push(`## ⚠️ Patrones peligrosos\n\n${dangerPatterns.length > 0 ? dangerPatterns.join('\n') : '✅ No se detectaron patrones peligrosos.'}`);

            // 4. Archivos sensibles expuestos
            const sensitiveFiles = ['.env', '.env.local', '.env.production', 'id_rsa', 'id_ed25519', '*.pem', 'credentials.json'];
            const foundSensitive = sensitiveFiles.filter(f => {
                try { execSync(`find "${process.cwd()}" -name "${f}" -not -path "*/node_modules/*" 2>/dev/null`, { encoding:'utf8', timeout:5000 }); return true; } catch { return false; }
            });
            sections3.push(`## 📁 Archivos sensibles\n\n${foundSensitive.length > 0 ? foundSensitive.map(f=>`⚠️ \`${f}\` encontrado en el proyecto`).join('\n') : '✅ No se encontraron archivos sensibles expuestos.'}`);

            const doc = [
                `# 🔐 Auditoría de Seguridad — ${dateStr3}`,
                '',
                `> **Proyecto:** \`${process.cwd()}\`  `,
                `> _Generado por AgentLag /audit · ${new Date().toISOString()}_`,
                '',
                '---',
                '',
                sections3.join('\n\n---\n\n'),
                '',
                '---',
                '',
                '## 📋 Recomendaciones generales',
                '',
                '- Nunca committear archivos `.env` (añadir a `.gitignore`)',
                '- Usar variables de entorno para todas las credenciales',
                '- Ejecutar `npm audit fix` regularmente',
                '- Revisar dependencias con `npm outdated`',
                '- Evitar `eval()` e `innerHTML` sin sanitización',
            ].join('\n');

            try {
                fs.mkdirSync(outDir3, { recursive: true });
                fs.writeFileSync(outFile3, doc, 'utf8');
                const totalIssues = secretsFound.length + dangerPatterns.length;
                say([
                    `🔐 Auditoría completada`,
                    `🔑 Secrets detectados: ${secretsFound.length}`,
                    `⚠️ Patrones peligrosos: ${dangerPatterns.length}`,
                    totalIssues === 0 ? '✅ Sin problemas críticos detectados' : `🔴 ${totalIssues} problema(s) requieren atención`,
                    `📄 Reporte completo: ${outFile3}`,
                ].join('\n'));
            } catch (e) {
                say(`❌ Error guardando auditoría: ${e.message}`);
            }
            return true;
        }

        // ─── /explain <archivo> ───────────────────────────────────────────────
        // Genera documentación técnica de un archivo: qué hace, sus funciones,
        // parámetros, dependencias y ejemplos de uso. Guarda en .md.
        //
        // Uso:
        //   /explain src/utils.js
        //   /explain agent.py
        // ─────────────────────────────────────────────────────────────────────
        case '/explain': {
            if (!args) {
                say('Uso: /explain <archivo>\nEjemplo: /explain src/utils.js\n\nGenera documentación técnica del archivo y la guarda en .agentlag/docs/');
                return true;
            }

            const filePath4 = path.resolve(process.cwd(), args.trim());
            let fileContent4;
            try {
                fileContent4 = fs.readFileSync(filePath4, 'utf8');
            } catch (e) {
                say(`❌ No se pudo leer: ${filePath4}\n${e.message}`);
                return true;
            }

            say(`📖 Generando documentación para: ${args.trim()}`);

            const ext4     = path.extname(filePath4).replace('.', '') || 'txt';
            const lines4   = fileContent4.split('\n');
            const outDir4  = path.join(process.cwd(), '.agentlag', 'docs');
            const safeName4= path.basename(filePath4).replace(/[^a-z0-9]/gi, '-');
            const outFile4 = path.join(outDir4, `${safeName4}.md`);

            // Extraer funciones, clases, exports
            const fnRegex   = /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/g;
            const arrowRegex= /(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?\(([^)]*)\)\s*=>/g;
            const classRegex= /(?:export\s+)?class\s+(\w+)/g;
            const importRegex= /^(?:import|const\s+\{[^}]+\}\s*=\s*require)\s+/;

            const functions = [];
            let m;
            while ((m = fnRegex.exec(fileContent4)) !== null)   functions.push({ name: m[1], params: m[2], type: 'function' });
            while ((m = arrowRegex.exec(fileContent4)) !== null) functions.push({ name: m[1], params: m[2], type: 'arrow' });

            const classes4  = [...fileContent4.matchAll(classRegex)].map(x => x[1]);
            const imports4  = lines4.filter(l => importRegex.test(l.trim())).map(l => l.trim());
            const exports4  = lines4.filter(l => /^export\s+(default\s+)?/.test(l.trim())).map(l => l.trim());

            const fnDocs = functions.length > 0
                ? functions.map(f => `### \`${f.name}(${f.params})\`\n\n> _Tipo: ${f.type}_\n\n_Descripción pendiente de completar_\n\n**Parámetros:**\n${f.params ? f.params.split(',').map(p=>`- \`${p.trim()}\``).join('\n') : '_Sin parámetros_'}`).join('\n\n')
                : '_No se detectaron funciones exportadas_';

            const doc = [
                `# 📖 Documentación: \`${path.basename(filePath4)}\``,
                '',
                `> **Ruta:** \`${filePath4}\`  `,
                `> **Lenguaje:** ${ext4}  `,
                `> **Líneas:** ${lines4.length} | **Funciones:** ${functions.length} | **Clases:** ${classes4.length}  `,
                `> _Generado por AgentLag /explain · ${new Date().toISOString()}_`,
                '',
                '---',
                '',
                '## 📋 Resumen',
                '',
                `Este archivo contiene **${functions.length} función(es)** y **${classes4.length} clase(s)**. `,
                `Tiene **${imports4.length} import(s)** y **${exports4.length} export(s)**.`,
                '',
                '## 📦 Dependencias (imports)',
                '',
                imports4.length > 0 ? imports4.map(i => `- \`${i}\``).join('\n') : '_Sin imports_',
                '',
                classes4.length > 0 ? `## 🏛️ Clases\n\n${classes4.map(c=>`### \`${c}\`\n\n_Descripción pendiente_`).join('\n\n')}` : '',
                '',
                '## ⚙️ Funciones',
                '',
                fnDocs,
                '',
                '## 📤 Exports',
                '',
                exports4.length > 0 ? exports4.map(e => `- \`${e}\``).join('\n') : '_Sin exports explícitos_',
                '',
                '## 📄 Código fuente',
                '',
                '```' + ext4,
                fileContent4.slice(0, 4000) + (fileContent4.length > 4000 ? '\n\n... (truncado a 4000 chars)' : ''),
                '```',
            ].filter(l => l !== '').join('\n');

            try {
                fs.mkdirSync(outDir4, { recursive: true });
                fs.writeFileSync(outFile4, doc, 'utf8');
                say([
                    `✅ Documentación generada para \`${path.basename(filePath4)}\``,
                    `📊 ${functions.length} funciones · ${classes4.length} clases · ${imports4.length} imports`,
                    `📄 Guardado en: ${outFile4}`,
                ].join('\n'));
            } catch (e) {
                say(`❌ Error guardando documentación: ${e.message}`);
            }
            return true;
        }

        // ─── /diagram ─────────────────────────────────────────────────────────
        // Analiza el codebase y genera un diagrama de arquitectura en Mermaid,
        // mostrando módulos, dependencias y relaciones entre archivos.
        //
        // Uso:
        //   /diagram
        //   /diagram src/    (solo una carpeta)
        // ─────────────────────────────────────────────────────────────────────
        case '/diagram': {
            const scanDir2  = args ? path.resolve(process.cwd(), args.trim()) : process.cwd();
            const outDir5   = path.join(process.cwd(), '.agentlag');
            const outFile5  = path.join(outDir5, 'ARCHITECTURE.md');
            say(`🗺️ Analizando arquitectura en: ${scanDir2}`);


            // Listar archivos JS/TS principales (excluir node_modules, dist, etc.)
            let fileList = [];
            try {
                const result = execSync(
                    `find "${scanDir2}" -type f \\( -name "*.js" -o -name "*.ts" -o -name "*.jsx" -o -name "*.tsx" -o -name "*.py" \\) -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" -not -path "*/build/*" 2>/dev/null | head -60`,
                    { encoding: 'utf8', timeout: 15000 }
                );
                fileList = result.trim().split('\n').filter(Boolean);
            } catch {}

            if (fileList.length === 0) {
                say('⚠️ No se encontraron archivos de código en el proyecto.');
                return true;
            }

            // Para cada archivo, extraer sus imports locales
            const edges = [];
            const nodes = new Set();

            for (const file of fileList.slice(0, 40)) {
                const rel = path.relative(process.cwd(), file);
                const nodeId = rel.replace(/[^a-z0-9]/gi, '_');
                const label  = path.basename(file);
                nodes.add(`    ${nodeId}["${label}"]`);

                try {
                    const content = fs.readFileSync(file, 'utf8');
                    const localImports = [...content.matchAll(/(?:import|require)\s*[\s({'"]*['"](\.[^'"]+)['"]/g)]
                        .map(m => m[1]);

                    for (const imp of localImports) {
                        const resolved = path.resolve(path.dirname(file), imp);
                        const extensions = ['.js', '.ts', '.jsx', '.tsx', '.py', ''];
                        for (const ext5 of extensions) {
                            const candidate = resolved + ext5;
                            if (fileList.includes(candidate)) {
                                const targetRel = path.relative(process.cwd(), candidate);
                                const targetId  = targetRel.replace(/[^a-z0-9]/gi, '_');
                                edges.push(`    ${nodeId} --> ${targetId}`);
                                break;
                            }
                        }
                    }
                } catch {}
            }

            const mermaid = [
                '```mermaid',
                'graph TD',
                ...Array.from(nodes),
                ...(edges.length > 0 ? edges : ['    %% No se detectaron dependencias locales']),
                '```',
            ].join('\n');

            const dateStr5 = new Date().toLocaleDateString('es-ES', { year: 'numeric', month: 'long', day: 'numeric' });
            const doc = [
                `# 🗺️ Arquitectura del Proyecto`,
                '',
                `> **Fecha:** ${dateStr5}  `,
                `> **Archivos analizados:** ${fileList.length}  `,
                `> **Relaciones detectadas:** ${edges.length}  `,
                `> _Generado por AgentLag /diagram · ${new Date().toISOString()}_`,
                '',
                '---',
                '',
                '## Diagrama de dependencias',
                '',
                mermaid,
                '',
                '---',
                '',
                '## 📋 Archivos analizados',
                '',
                fileList.slice(0, 40).map(f => `- \`${path.relative(process.cwd(), f)}\``).join('\n'),
            ].join('\n');

            try {
                fs.mkdirSync(outDir5, { recursive: true });
                fs.writeFileSync(outFile5, doc, 'utf8');
                say([
                    `✅ Diagrama generado`,
                    `📊 ${fileList.length} archivos · ${edges.length} relaciones`,
                    `📄 Guardado en: ${outFile5}`,
                    ``,
                    `Abre el archivo en un visor Markdown con soporte Mermaid (VSCode, GitHub, Obsidian).`,
                ].join('\n'));
            } catch (e) {
                say(`❌ Error guardando diagrama: ${e.message}`);
            }
            return true;
        }

        // ─── /task <descripción> ──────────────────────────────────────────────
        // Divide una tarea grande en subtareas y las delega a subagentes en
        // paralelo usando delegate_to_subagents. Ideal para tareas complejas.
        //
        // Uso:
        //   /task refactorizar el módulo de autenticación
        //   /task añadir tests unitarios a todos los utilities
        // ─────────────────────────────────────────────────────────────────────
        case '/task': {
            if (!args) {
                say('Uso: /task <descripción de la tarea>\nEjemplo: /task refactorizar el módulo de autenticación\n\nDivide la tarea en subtareas y las delega a subagentes en paralelo.');
                return true;
            }

            const taskDesc = args.trim();
            say(`🤖 Planificando tarea: "${taskDesc}"\nGenerando plan de subtareas...`);

            // Generar subtareas basadas en el tipo de tarea detectado
            let subtasks = [];

            if (/test|spec|unitari/i.test(taskDesc)) {
                subtasks = [
                    { name: 'analyzer',    task: `Analiza el código existente y lista los archivos que necesitan tests: ${taskDesc}` },
                    { name: 'test-writer', task: `Escribe los tests unitarios necesarios para: ${taskDesc}` },
                    { name: 'validator',   task: `Verifica que los tests cubran los casos edge para: ${taskDesc}` },
                ];
            } else if (/refactor/i.test(taskDesc)) {
                subtasks = [
                    { name: 'analyzer',    task: `Analiza el código actual e identifica problemas de calidad: ${taskDesc}` },
                    { name: 'refactorer',  task: `Propone los cambios de refactoring necesarios: ${taskDesc}` },
                    { name: 'doc-updater', task: `Identifica qué documentación necesita actualizarse: ${taskDesc}` },
                ];
            } else if (/documenta|doc/i.test(taskDesc)) {
                subtasks = [
                    { name: 'scanner',     task: `Escanea el proyecto y lista archivos sin documentación: ${taskDesc}` },
                    { name: 'doc-writer',  task: `Genera la documentación técnica necesaria: ${taskDesc}` },
                    { name: 'readme',      task: `Actualiza o crea el README con la nueva información: ${taskDesc}` },
                ];
            } else if (/bug|error|fix|arregl/i.test(taskDesc)) {
                subtasks = [
                    { name: 'debugger',    task: `Localiza la causa del problema: ${taskDesc}` },
                    { name: 'fixer',       task: `Propone y aplica la corrección: ${taskDesc}` },
                    { name: 'tester',      task: `Verifica que la corrección no rompa nada más: ${taskDesc}` },
                ];
            } else {
                // Subtareas genéricas
                subtasks = [
                    { name: 'planner',     task: `Analiza el contexto del proyecto y planifica los pasos: ${taskDesc}` },
                    { name: 'executor',    task: `Ejecuta la tarea principal: ${taskDesc}` },
                    { name: 'reviewer',    task: `Revisa el resultado y sugiere mejoras: ${taskDesc}` },
                ];
            }

            say(`📋 Plan generado con ${subtasks.length} subtareas:\n${subtasks.map((s,i)=>`  ${i+1}. [${s.name}] ${s.task.slice(0,80)}...`).join('\n')}\n\nDelegando a subagentes...`);

            // Agregar a historial para que el agente lo procese
            const delegationMsg = `Por favor ejecuta esta tarea delegando a subagentes en paralelo usando la herramienta delegate_to_subagents:\n\nTarea principal: ${taskDesc}\n\nDelegaciones:\n${JSON.stringify(subtasks, null, 2)}`;

            if (msgRef?.current !== undefined) {
                msgRef.current = delegationMsg;
                say('✅ Tarea enviada al agente para delegación paralela. El agente procesará las subtareas ahora.');
            } else {
                say(`✅ Plan de tarea listo. Ejecuta esto en el chat:\n\n${delegationMsg}`);
            }
            return true;
        }

        // ─── /draft <tipo> ────────────────────────────────────────────────────
        // Genera borradores estructurados: email, PR description, issue de
        // GitHub, commit message o release notes según el contexto del proyecto.
        //
        // Uso:
        //   /draft pr
        //   /draft email <asunto>
        //   /draft issue <título>
        //   /draft commit
        //   /draft release
        // ─────────────────────────────────────────────────────────────────────
        case '/draft': {
            if (!args) {
                say('Uso: /draft <tipo> [descripción]\nTipos: pr · email · issue · commit · release\n\nEjemplos:\n  /draft pr\n  /draft email solicitud de vacaciones\n  /draft issue bug en el login\n  /draft commit');
                return true;
            }

            const [draftType, ...draftRest] = args.trim().split(/\s+/);
            const draftDesc = draftRest.join(' ');

            let draft = '';
            const type = draftType.toLowerCase();

            // Obtener contexto git
            let lastCommits = '';
            let currentBranch = '';
            try {
                lastCommits    = execSync('git log --oneline -5 2>/dev/null', { encoding: 'utf8', cwd: process.cwd(), timeout: 5000 }).trim();
                currentBranch  = execSync('git branch --show-current 2>/dev/null', { encoding: 'utf8', cwd: process.cwd(), timeout: 5000 }).trim();
            } catch {}

            if (type === 'pr') {
                draft = [
                    '## 📋 Pull Request',
                    '',
                    `### Descripción`,
                    `${draftDesc || '_Describe los cambios realizados_'}`,
                    '',
                    `**Rama:** \`${currentBranch || 'feature/nombre'}\``,
                    '',
                    '### ¿Qué hace este PR?',
                    '- ',
                    '',
                    '### ¿Por qué se realizaron estos cambios?',
                    '- ',
                    '',
                    '### Tipo de cambio',
                    '- [ ] 🐛 Bug fix',
                    '- [ ] ✨ Nueva funcionalidad',
                    '- [ ] 💥 Breaking change',
                    '- [ ] 📝 Documentación',
                    '- [ ] ♻️ Refactoring',
                    '',
                    '### Testing',
                    '- [ ] He añadido tests',
                    '- [ ] Los tests existentes pasan',
                    '',
                    '### Commits relacionados',
                    lastCommits ? lastCommits.split('\n').map(c=>`- ${c}`).join('\n') : '- _Sin commits recientes_',
                ].join('\n');

            } else if (type === 'email') {
                draft = [
                    `**Para:** `,
                    `**Asunto:** ${draftDesc || 'Asunto del email'}`,
                    '',
                    'Hola [nombre],',
                    '',
                    `_[Cuerpo del email sobre: ${draftDesc || 'el tema'}]_`,
                    '',
                    'Quedo a tu disposición para cualquier consulta.',
                    '',
                    'Saludos,',
                    '[Tu nombre]',
                ].join('\n');

            } else if (type === 'issue') {
                draft = [
                    `## 🐛 Issue: ${draftDesc || 'Título del issue'}`,
                    '',
                    '### Descripción',
                    '_Describe el problema o la funcionalidad solicitada_',
                    '',
                    '### Pasos para reproducir (si es un bug)',
                    '1. ',
                    '2. ',
                    '3. ',
                    '',
                    '### Comportamiento esperado',
                    '',
                    '### Comportamiento actual',
                    '',
                    '### Entorno',
                    `- Rama: \`${currentBranch || 'main'}\``,
                    '- Node.js: ',
                    '- OS: ',
                    '',
                    '### Posible solución',
                    '_Opcional_',
                ].join('\n');

            } else if (type === 'commit') {
                let gitDiff = '';
                try {
                    gitDiff = execSync('git diff --stat HEAD 2>/dev/null', { encoding:'utf8', cwd: process.cwd(), timeout: 5000 }).trim().slice(0, 300);
                } catch {}
                draft = [
                    `feat: ${draftDesc || 'descripción del cambio'}`,
                    '',
                    '- ',
                    '',
                    gitDiff ? `Cambios:\n${gitDiff}` : '',
                ].join('\n');

            } else if (type === 'release') {
                let changelog = '';
                try {
                    changelog = execSync('git log --oneline -10 2>/dev/null', { encoding:'utf8', cwd: process.cwd(), timeout: 5000 }).trim();
                } catch {}
                draft = [
                    `## 🚀 Release ${draftDesc || 'v1.0.0'}`,
                    '',
                    `**Fecha:** ${new Date().toLocaleDateString('es-ES')}`,
                    '',
                    '### ✨ Nuevas funcionalidades',
                    '- ',
                    '',
                    '### 🐛 Bug fixes',
                    '- ',
                    '',
                    '### 💥 Breaking changes',
                    '- _Ninguno_',
                    '',
                    '### 📋 Commits incluidos',
                    changelog ? changelog.split('\n').map(c=>`- ${c}`).join('\n') : '- _Sin commits_',
                ].join('\n');

            } else {
                say(`❌ Tipo desconocido: "${type}"\nTipos disponibles: pr · email · issue · commit · release`);
                return true;
            }

            // Guardar el borrador
            const outDir6  = path.join(process.cwd(), '.agentlag', 'drafts');
            const outFile6 = path.join(outDir6, `draft-${type}-${Date.now()}.md`);
            try {
                fs.mkdirSync(outDir6, { recursive: true });
                fs.writeFileSync(outFile6, draft, 'utf8');
                say(`✅ Borrador de ${type} generado:\n\n${draft}\n\n📄 Guardado en: ${outFile6}`);
            } catch {
                say(`✅ Borrador de ${type}:\n\n${draft}`);
            }
            return true;
        }

        // ─── /compare <archivo1> <archivo2> ──────────────────────────────────
        // Compara dos archivos semánticamente (no solo diff de líneas):
        // muestra funciones añadidas/eliminadas, cambios de imports, tamaño.
        //
        // Uso:
        //   /compare src/old.js src/new.js
        //   /compare v1/utils.py v2/utils.py
        // ─────────────────────────────────────────────────────────────────────
        case '/compare': {
            const parts = args?.trim().split(/\s+/);
            if (!parts || parts.length < 2) {
                say('Uso: /compare <archivo1> <archivo2>\nEjemplo: /compare src/old.js src/new.js');
                return true;
            }

            const [file1Path, file2Path] = parts.map(p => path.resolve(process.cwd(), p));
            let content1, content2;

            try { content1 = fs.readFileSync(file1Path, 'utf8'); } catch (e) { say(`❌ No se pudo leer: ${file1Path}`); return true; }
            try { content2 = fs.readFileSync(file2Path, 'utf8'); } catch (e) { say(`❌ No se pudo leer: ${file2Path}`); return true; }

            say(`🔄 Comparando ${path.basename(file1Path)} ↔ ${path.basename(file2Path)}...`);

            // Extraer funciones de cada archivo
            const extractFns = (content) => {
                const matches = [...content.matchAll(/(?:async\s+)?function\s+(\w+)|(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?\(/g)];
                return new Set(matches.map(m => m[1] || m[2]).filter(Boolean));
            };
            const extractImports = (content) => new Set(content.split('\n').filter(l => /^import|require/.test(l.trim())).map(l=>l.trim()));

            const fns1 = extractFns(content1);
            const fns2 = extractFns(content2);
            const imp1 = extractImports(content1);
            const imp2 = extractImports(content2);

            const addedFns   = [...fns2].filter(f => !fns1.has(f));
            const removedFns = [...fns1].filter(f => !fns2.has(f));
            const addedImps  = [...imp2].filter(i => !imp1.has(i));
            const removedImps= [...imp1].filter(i => !imp2.has(i));

            const lines1 = content1.split('\n').length;
            const lines2 = content2.split('\n').length;
            const diffLines = lines2 - lines1;
            const diffSign  = diffLines >= 0 ? `+${diffLines}` : `${diffLines}`;

            // Git diff si es posible
            let gitDiff2 = '';
            try {
                gitDiff2 = execSync(`diff -u "${file1Path}" "${file2Path}" 2>/dev/null || true`, { encoding:'utf8', timeout: 10000 }).slice(0, 2000);
            } catch {}

            const outDir7  = path.join(process.cwd(), '.agentlag', 'compares');
            const outFile7 = path.join(outDir7, `compare-${Date.now()}.md`);

            const doc = [
                `# 🔄 Comparación de archivos`,
                '',
                `| | Archivo 1 | Archivo 2 |`,
                `|--|-----------|-----------|`,
                `| **Nombre** | \`${path.basename(file1Path)}\` | \`${path.basename(file2Path)}\` |`,
                `| **Líneas** | ${lines1} | ${lines2} (${diffSign}) |`,
                `| **Funciones** | ${fns1.size} | ${fns2.size} |`,
                `| **Imports** | ${imp1.size} | ${imp2.size} |`,
                '',
                '---',
                '',
                '## ✨ Funciones añadidas',
                addedFns.length > 0 ? addedFns.map(f=>`- \`${f}\``).join('\n') : '_Ninguna_',
                '',
                '## 🗑️ Funciones eliminadas',
                removedFns.length > 0 ? removedFns.map(f=>`- \`${f}\``).join('\n') : '_Ninguna_',
                '',
                '## 📦 Imports añadidos',
                addedImps.length > 0 ? addedImps.map(i=>`- \`${i}\``).join('\n') : '_Ninguno_',
                '',
                '## 📦 Imports eliminados',
                removedImps.length > 0 ? removedImps.map(i=>`- \`${i}\``).join('\n') : '_Ninguno_',
                '',
                gitDiff2 ? `## 📋 Diff\n\n\`\`\`diff\n${gitDiff2}\n\`\`\`` : '',
                '',
                `---`,
                `_Generado por AgentLag /compare · ${new Date().toISOString()}_`,
            ].filter(l => l !== '').join('\n');

            try {
                fs.mkdirSync(outDir7, { recursive: true });
                fs.writeFileSync(outFile7, doc, 'utf8');
                say([
                    `✅ Comparación completada`,
                    `📊 Líneas: ${lines1} → ${lines2} (${diffSign})`,
                    `✨ Funciones añadidas: ${addedFns.length} | 🗑️ Eliminadas: ${removedFns.length}`,
                    `📦 Imports añadidos: ${addedImps.length} | Eliminados: ${removedImps.length}`,
                    `📄 Reporte: ${outFile7}`,
                ].join('\n'));
            } catch (e) {
                say(`❌ Error guardando comparación: ${e.message}`);
            }
            return true;
        }

        default:
            return false;
    }
}
