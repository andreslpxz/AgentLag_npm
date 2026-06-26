import fs from "fs";
import path from "path";
import os from "os";
import { spawn, execSync } from 'child_process';

import {
    CONFIG_DIR, MEMORY_FILE, HOOKS_FILE, MCP_FILE, AGENTS_DIR,
    normalizeConversationName, listConversations, conversationFile,
    loadSession, saveSession, clearLatestSession, saveConfig,
} from './session.js';
import { copyToClipboard, splitCommandArgs, runCommand } from './utils.js';
import { clearSkillsCache, formatSkillsIndex, readSkill, listInstalledSkills } from './skills.js';
import { loadMcpConfig } from './mcp_utils.js';
import { isOllamaRunning } from './ollama_utils.js';
import { getEvolutions, getLatestEvolution, removeEvolution } from './evolution_store.js';
import { applyEvolution } from './evolution_engine.js';
import { consolidateHistory } from './consolidator.js';
import { buildAgent } from './agent.js';
import { webSearch, tools } from './tools.js';
import {
    getEffortConfig,
    validateEffortLevel,
    describeEffortSupport,
    supportsEffort,
    EFFORT_REGISTRY,
} from './effort_models.js';
import { HumanMessage, AIMessage, SystemMessage } from '@langchain/core/messages';
import cron from 'node-cron';
import pkg from './package.json' with { type: 'json' };

export const AGENTLAG_VERSION = pkg.version;
export const EFFORT_LEVELS    = ['low', 'medium', 'high', 'xhigh', 'max'];

// ─── Catálogo ─────────────────────────────────────────────────────────────────
import { t } from './i18n.js';

export const SLASH_COMMANDS = [
    { cmd: '/mcp',         desc: ['cmd_mcp_desc', 'cmd_mcp_usage'] },
    { cmd: '/add-dir',     desc: ['cmd_add_dir_desc'] },
    { cmd: '/advisor',     desc: ['cmd_advisor_desc'] },
    { cmd: '/agents',      desc: ['cmd_agents_desc'] },
    { cmd: '/branch',      desc: ['cmd_branch_desc'] },
    { cmd: '/btw',         desc: ['cmd_btw_desc'] },
    { cmd: '/clear',       desc: ['cmd_clear_desc'] },
    { cmd: '/color',       desc: ['cmd_color_desc'] },
    { cmd: '/compact',     desc: ['cmd_compact_desc'] },
    { cmd: '/config',      desc: ['cmd_config_desc'] },
    { cmd: '/context',     desc: ['cmd_context_desc'] },
    { cmd: '/copy',        desc: ['cmd_copy_desc'] },
    { cmd: '/cwd',         desc: ['cmd_cwd_desc'] },
    { cmd: '/debug',       desc: ['cmd_debug_desc'] },
    { cmd: '/diff',        desc: ['cmd_diff_desc'] },
    { cmd: '/doctor',      desc: ['cmd_doctor_desc'] },
    { cmd: '/download',    desc: ['cmd_download_desc'] },
    { cmd: '/effort',      desc: ['cmd_effort_desc'] },
    { cmd: '/evolve',      desc: ['cmd_evolve_desc'] },
    { cmd: '/exit',        desc: ['cmd_exit_desc'] },
    { cmd: '/export',      desc: ['cmd_export_desc'] },
    { cmd: '/deepsearch',  desc: ['cmd_deepsearch_desc'] },
    { cmd: '/standup',     desc: ['cmd_standup_desc'] },
    { cmd: '/review',      desc: ['cmd_review_desc'] },
    { cmd: '/changelog',   desc: ['cmd_changelog_desc'] },
    { cmd: '/todo',        desc: ['cmd_todo_desc'] },
    { cmd: '/audit',       desc: ['cmd_audit_desc'] },
    { cmd: '/explain',     desc: ['cmd_explain_desc'] },
    { cmd: '/diagram',     desc: ['cmd_diagram_desc'] },
    { cmd: '/task',        desc: ['cmd_task_desc'] },
    { cmd: '/draft',       desc: ['cmd_draft_desc'] },
    { cmd: '/compare',     desc: ['cmd_compare_desc'] },
    { cmd: '/feedback',    desc: ['cmd_feedback_desc'] },
    { cmd: '/focus',       desc: ['cmd_focus_desc'] },
    { cmd: '/help',        desc: ['cmd_help_desc'] },
    { cmd: '/hooks',       desc: ['cmd_hooks_desc'] },
    { cmd: '/ide',         desc: ['cmd_ide_desc'] },
    { cmd: '/import',      desc: ['cmd_import_desc'] },
    { cmd: '/keybindings', desc: ['cmd_keybindings_desc'] },
    { cmd: '/logout',      desc: ['cmd_logout_desc'] },
    { cmd: '/memory',      desc: ['cmd_memory_desc'] },
    { cmd: '/model',       desc: ['cmd_model_desc'] },
    { cmd: '/provider',    desc: ['cmd_provider_desc'] },
    { cmd: '/quit',        desc: ['cmd_quit_desc'] },
    { cmd: '/react',       desc: ['cmd_react_desc'] },
    { cmd: '/rename',      desc: ['cmd_rename_desc'] },
    { cmd: '/resume',      desc: ['cmd_resume_desc'] },
    { cmd: '/sessions',    desc: ['cmd_sessions_desc'] },
    { cmd: '/schedule',    desc: ['cmd_schedule_desc'] },
    { cmd: '/server',      desc: ['cmd_server_desc'] },
    { cmd: '/bot',         desc: ['cmd_bot_desc'] },
    { cmd: '/discord',     desc: ['cmd_discord_desc'] },
    { cmd: '/skills',      desc: ['cmd_skills_desc'] },
    { cmd: '/version',     desc: ['cmd_version_desc'] },
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
        schedulerRef, lastError,
    } = ctx;

    switch (cmd) {
        case '/language': {
            setScreen('language');
            setMenuIndex(0);
            return true;
        }
        case '/mcp': {
            const parts = args?.trim().split(/\s+/);
            const sub = parts?.[0]?.toLowerCase();

            if (sub === 'add' || sub === 'add-json') {
                const name = parts[1];
                if (!name) {
                    say(t('cmd_mcp_usage_error', { sub }));
                    return true;
                }

                let serverConfig = {};
                let scope = 'project';

                const remainder = parts.slice(2).join(' ');
                const scopeMatch = remainder.match(/--scope\s+(\w+)/);
                if (scopeMatch) {
                    scope = scopeMatch[1];
                }

                if (sub === 'add-json') {
                    let jsonStr = scopeMatch ? remainder.replace(scopeMatch[0], '').trim() : remainder.trim();
                    if (jsonStr.startsWith("'") && jsonStr.endsWith("'")) jsonStr = jsonStr.slice(1, -1);
                    if (jsonStr.startsWith('"') && jsonStr.endsWith('"')) jsonStr = jsonStr.slice(1, -1);
                    try {
                        serverConfig = JSON.parse(jsonStr);
                    } catch (e) {
                        say(t('cmd_mcp_json_error', { error: e.message }));
                        return true;
                    }
                } else {
                    // /mcp add name command args...
                    const cmdArgs = scopeMatch ? remainder.replace(scopeMatch[0], '').trim().split(/\s+/) : remainder.trim().split(/\s+/);
                    const command = cmdArgs[0];
                    const argsList = cmdArgs.slice(1);
                    if (!command) {
                        say(t('cmd_mcp_add_error'));
                        return true;
                    }
                    serverConfig = { command, args: argsList };
                }

                try {
                    const configDir = scope === 'user'
                        ? path.join(os.homedir(), '.agentlag')
                        : path.join(process.cwd(), '.agentlag');
                    const configPath = path.join(configDir, 'mcp.json');

                    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });

                    let mcpConfig = { mcpServers: {} };
                    if (fs.existsSync(configPath)) {
                        mcpConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                    }

                    mcpConfig.mcpServers[name] = serverConfig;
                    fs.writeFileSync(configPath, JSON.stringify(mcpConfig, null, 2));

                    say(t('cmd_mcp_added', { name, scope }));
                    rebuildAgentWith();
                    return true;
                } catch (e) {
                say(t('error_prefix', { error: e.message }));
                    return true;
                }
            }

            // Listar si no hay subcomando o es 'list'
            const data = loadMcpConfig();
            const servers = Object.entries(data?.mcpServers || {});
            if (servers.length === 0) {
                say(t('cmd_mcp_none'));
            } else {
                const lines = [t('cmd_mcp_config_list')];
                for (const [name, def] of servers) {
                    const detail = def.url ? `URL: ${def.url}` : `${def.command || ''} ${(def.args || []).join(' ')}`;
                    lines.push(`  • ${name}: ${detail}`);
                }
                lines.push(t('cmd_mcp_list_usage'));
                say(lines.join('\n'));
            }
            return true;
        }
        case '/help': {
            const width   = Math.max(...SLASH_COMMANDS.map(c => c.cmd.length));
            const helpText = SLASH_COMMANDS
                .map(c => {
                    const descText = c.desc.map(k => t(k)).join(' ');
                    return `  ${c.cmd.padEnd(width + 2)} ${descText}`;
                })
                .join('\n');
            say(`${t('cmd_help_available')}:\n${helpText}`);
            return true;
        }

        case '/schedule': {
            const parts = args ? args.split(' ') : [];
            const sub   = parts[0];
            if (sub === 'list' || !sub) {
                const tasks = schedulerRef.current.listTasks();
                if (tasks.length === 0) say(t('cmd_schedule_none'));
                else {
                    const lines = [t('cmd_schedule_list'), ''];
                    tasks.forEach(t => lines.push(`  • ${t.id} [${t.cronExp}]: ${t.prompt}`));
                    say(lines.join('\n'));
                }
            } else if (sub === 'add') {
                const match = args.match(/add "([^"]+)" "([^"]+)" "([^"]+)"/);
                if (!match) say(t('cmd_schedule_add_usage'));
                else {
                    try {
                        schedulerRef.current.scheduleTask(match[1], match[2], match[3]);
                        say(t('cmd_schedule_added', { id: match[1] }));
                    } catch (err) {
                        say(t('cmd_schedule_add_error', { error: err.message }));
                    }
                }
            } else if (sub === 'ask' || sub === 'nl') {
                // Natural-language scheduling: the user describes what they want
                // in plain words, and we ask the LLM to produce { id, cronExp, prompt }.
                // The whole "ask ..." remainder (after stripping the leading keyword)
                // is treated as the natural-language description.
                const rawRemainder = args.split(' ').slice(1).join(' ').trim();
                // Strip optional surrounding quotes
                let description = rawRemainder;
                if ((description.startsWith('"') && description.endsWith('"')) ||
                    (description.startsWith("'") && description.endsWith("'"))) {
                    description = description.slice(1, -1);
                }
                if (!description) {
                    say(t('cmd_schedule_ask_usage'));
                    return true;
                }
                if (!ctx.agent) {
                    say(t('cmd_schedule_ask_no_agent'));
                    return true;
                }
                say(t('cmd_schedule_ask_thinking'));
                // Run async — don't block the UI.
                parseScheduleWithLLM(description, ctx.agent)
                    .then(parsed => {
                        if (!parsed) {
                            say(t('cmd_schedule_ask_failed'));
                            return;
                        }
                        try {
                            schedulerRef.current.scheduleTask(parsed.id, parsed.cronExp, parsed.prompt);
                            say(t('cmd_schedule_ask_added', {
                                id: parsed.id,
                                cron: parsed.cronExp,
                                prompt: parsed.prompt,
                            }));
                        } catch (err) {
                            say(t('cmd_schedule_add_error', { error: err.message }));
                        }
                    })
                    .catch(err => {
                        say(t('cmd_schedule_add_error', { error: err.message || String(err) }));
                    });
            } else if (sub === 'remove') {
                if (!parts[1]) say(t('cmd_schedule_remove_usage'));
                else {
                    const ok = schedulerRef.current.removeTask(parts[1]);
                    say(ok ? t('cmd_schedule_removed', { id: parts[1] }) : t('cmd_schedule_not_found', { id: parts[1] }));
                }
            } else {
                say(t('cmd_schedule_add_usage'));
            }
            return true;
        }

        case '/server': {
            say(t('cmd_server_starting', { port: process.env.PORT || 3000 }));
            spawn('node', ['server.js'], { detached: true, stdio: 'ignore' }).unref();
            return true;
        }

        case '/bot': {
            say(t('cmd_bot_starting'));
            spawn('node', ['telegram.js'], { detached: true, stdio: 'ignore' }).unref();
            return true;
        }

        case '/discord': {
            say(t('cmd_discord_starting'));
            spawn('node', ['discord.js'], { detached: true, stdio: 'ignore' }).unref();
            return true;
        }

        case '/version':
            say(t('cmd_version_info', {
                version: AGENTLAG_VERSION,
                node: process.version,
                platform: process.platform,
                arch: process.arch
            }));
            return true;

        case '/cwd':
            say(t('cmd_cwd_info', { cwd: process.cwd() }));
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

        case '/debug': {
            const skills = listInstalledSkills();
            const mcpCfg = loadMcpConfig();
            const mcpCount = Object.keys(mcpCfg.mcpServers || {}).length;

            let info = [
                t('cmd_debug_title'),
                `- ${t('label_provider')}: ${cfg.current.provider}`,
                `- ${t('label_model')}: ${cfg.current.model}`,
                `- ${t('label_tools_native')}: ${tools.length}`,
                `- ${t('label_mcp_servers')}: ${mcpCount}`,
                `- ${t('label_installed_skills')}: ${skills.length}`,
                `- ${t('label_force_react')}: ${forceReAct ? t('label_yes').toUpperCase() : t('label_no').toUpperCase()}`,
                `- Current CWD: ${process.cwd()}`,
                `- Config Path: ~/.agentlag/config.json`,
            ].join('\n');

            if (lastError) {
                info += `\n\n❌ [LAST ERROR]\n`;
                info += `- Message: ${lastError.message || lastError}\n`;
                if (lastError.stack) {
                    info += `- Stack: ${lastError.stack.split('\n').slice(0, 5).join('\n    ')}\n`;
                }
                if (lastError.response?.data) {
                    info += `- Response Data: ${JSON.stringify(lastError.response.data, null, 2)}\n`;
                }
            }

            info += `\n\n` + t('cmd_debug_tip');

            say(info);
            return true;
        }

        case '/effort': {
            const currentModel    = cfg.current.model    || '(not configured)';
            const currentProvider = cfg.current.provider || '(not configured)';

            // Subcommand: /effort info — show what the current model supports
            if (args && args.toLowerCase() === 'info') {
                say(describeEffortSupport(currentModel, currentProvider));
                return true;
            }

            // Subcommand: /effort list — list all models that support effort
            if (args && args.toLowerCase() === 'list') {
                const lines = ['📋 Modelos con soporte de esfuerzo:', ''];
                for (const [prov, models] of Object.entries(EFFORT_REGISTRY)) {
                    const supported = Object.entries(models)
                        .filter(([, v]) => v.param !== null);
                    if (supported.length === 0) continue;
                    lines.push(`  [${prov}]`);
                    for (const [name, cfg2] of supported) {
                        const lvls = cfg2.levels === 'numeric' ? 'low, medium, high, xhigh, max (numérico)' : cfg2.levels.join(', ');
                        lines.push(`    • ${name}: ${lvls} (default: ${cfg2.default})`);
                    }
                    lines.push('');
                }
                say(lines.join('\n'));
                return true;
            }

            // No args — show current effort + what this model supports
            if (!args) {
                const support = describeEffortSupport(currentModel, currentProvider);
                const lines = [
                    `📊 Esfuerzo actual: ${effortLevel}`,
                    '',
                    support,
                    '',
                    'Uso:',
                    '  /effort <level>   — establecer nivel (low|medium|high|xhigh|max)',
                    '  /effort info      — detalles del modelo actual',
                    '  /effort list      — listar todos los modelos soportados',
                ];
                say(lines.join('\n'));
                return true;
            }

            // Validate the requested level against the model's supported levels
            const lvl = args.toLowerCase();
            const validation = validateEffortLevel(currentModel, currentProvider, lvl);

            if (!validation.ok) {
                // The model doesn't support effort, or the level is invalid.
                // Show a helpful message but still persist the preference (so it
                // applies automatically when the user switches to a model that
                // does support effort).
                const support = describeEffortSupport(currentModel, currentProvider);
                say([
                    `⚠️ No se pudo aplicar "${lvl}" a ${currentModel} (${currentProvider}).`,
                    '',
                    support,
                    '',
                    `Se guardó la preferencia "${lvl}" — se aplicará automáticamente cuando uses un modelo que lo soporte.`,
                ].join('\n'));
                setEffortLevel(lvl);
                persistFlag('effort', lvl);
                return true;
            }

            // All good — apply the effort level
            setEffortLevel(validation.normalized);
            persistFlag('effort', validation.normalized);
            const appliedLevel = typeof validation.normalized === 'string'
                ? validation.normalized.toLowerCase()
                : validation.normalized;
            const cfg2 = getEffortConfig(currentModel, currentProvider);
            const paramInfo = cfg2 ? ` (vía ${cfg2.param})` : '';
            say(`✅ Esfuerzo = ${appliedLevel}${paramInfo}\nModelo: ${currentModel} (${currentProvider})`);

            // Rebuild the agent so the new effort takes effect immediately
            rebuildAgentWith({ effortLevel: validation.normalized });
            return true;
        }

        case '/focus': {
            const next = !focusMode;
            setFocusMode(next);
            persistFlag('focusMode', next);
            say(next ? t('cmd_focus_on') : t('cmd_focus_off'));
            return true;
        }

        case '/react': {
            const next = !forceReAct;
            setForceReAct(next);
            persistFlag('forceReAct', next);
            say(next ? t('cmd_react_on') : t('cmd_react_off'));
            rebuildAgentWith(next ? { forceReAct: true } : {});
            return true;
        }

        case '/advisor': {
            const next = !advisorEnabled;
            setAdvisorEnabled(next);
            persistFlag('advisor', next);
            say(next ? t('cmd_advisor_on') : t('cmd_advisor_off'));
            return true;
        }

        case '/logout': {
            const provider = cfg.current.provider || 'unknown';
            cfg.current = { ...cfg.current, apiKey: null };
            persistFlag('apiKey', null);
            say(t('cmd_logout_ok', { provider }));
            return true;
        }

        case '/add-dir': {
            if (!args) { say(t('cmd_add_dir_usage')); return true; }
            const target     = path.resolve(args);
            const trustedDirs = cfg.current.trustedDirs || [];
            if (trustedDirs.includes(target)) {
                say(t('cmd_add_dir_exists', { path: target }));
            } else {
                trustedDirs.push(target);
                cfg.current = { ...cfg.current, trustedDirs };
                persistFlag('trustedDirs', trustedDirs);
                say(t('cmd_add_dir_ok', { path: target, dirs: trustedDirs.join('\n  ') }));
            }
            return true;
        }

        case '/copy': {
            const last = lastAssistantText();
            if (!last) { say(t('cmd_copy_none')); return true; }
            copyToClipboard(last).then(ok => {
                say(ok
                    ? t('cmd_copy_ok', { count: last.length })
                    : t('cmd_copy_error', { text: last }));
            });
            return true;
        }

        case '/diff': {
            say(t('cmd_diff_starting'));
            runCommand('git', ['diff', 'HEAD']).then(({ ok, output }) => {
                if (!ok && output.includes('not a git repository')) {
                    say(t('cmd_diff_error'));
                } else {
                    const trimmedOut = output.length > 4000
                        ? output.slice(0, 4000) + '\n…(truncated)'
                        : output;
                    say(trimmedOut || t('cmd_diff_none'));
                }
            });
            return true;
        }

        case '/doctor': {
            const cfgNow = cfg.current || {};
            const lines  = [
                t('cmd_doctor_title'),
                `  • Node ${process.version} · ${process.platform}/${process.arch}`,
                `  • ${t('label_version')}: ${AGENTLAG_VERSION}`,
                `  • cwd: ${process.cwd()}`,
                `  • ${t('label_provider')}: ${cfgNow.provider || '(not configured)'}`,
                `  • ${t('label_model')}: ${cfgNow.model || '(not configured)'}`,
                `  • ${t('label_api_key_saved')}: ${cfgNow.apiKey ? t('label_yes') : t('label_no')}`,
                `  • Effort: ${effortLevel}`,
                `  • ${t('label_force_react')}: ${forceReAct ? t('label_yes') : t('label_no')}`,
                `  • Tavily key: ${process.env.TAVILY_API_KEY ? t('label_yes') : t('label_no')}`,
                `  • ${t('label_messages')}: ${msgRef.current.length}`,
            ];
            say(lines.join('\n'));
            if (cfgNow.provider === 'ollama' || cfgNow.provider === 'huggingface') {
                isOllamaRunning().then(running =>
                    say(t('cmd_doctor_ollama', { status: running ? t('label_yes') : `${t('label_no')} (ollama serve)` }))
                );
            }
            return true;
        }

        case '/context': {
            // Estimación simple del prompt del sistema actual
            const systemPromptText = `Eres AgentLag... ${formatSkillsIndex(process.cwd())}`; // Simplificado para el comando
            const estimatedSystemTokens = Math.ceil(systemPromptText.length / 4);

            say([
                t('cmd_context_title'),
                `  • ${t('label_tokens')}: ${totalTokens}`,
                `  • ${t('label_memory_msgs')}: ${msgRef.current.length}`,
                `  • ${t('label_items_hist')}: ${historyRef.current.length}`,
                `  • ${t('label_active_conv')}: ${currentConversationRef.current || '(latest)'}`,
                `  • ${t('label_estimated_tokens')}: ~${estimatedSystemTokens} tokens`,
                "",
                t('cmd_context_tip')
            ].join('\n'));
            return true;
        }

        case '/compact': {
            const removed = msgRef.current.length;
            if (removed === 0) { say(t('cmd_compact_empty')); return true; }
            const summary = `[resumen automático: ${removed} mensajes previos en esta sesión]`;
            msgRef.current = [new HumanMessage(summary)];
            setStaticHistory(prev => {
                const welcome = prev.find(i => i.type === 'welcome');
                return [
                    ...(welcome ? [welcome] : []),
                    { type: 'assistant', text: t('cmd_compact_ok', { count: removed }), ephemeral: true },
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
                say(t('cmd_export_ok', { file }));
            } catch (e) {
                say(t('cmd_export_error', { error: e.message }));
            }
            return true;
        }

        case '/feedback':
            say(t('cmd_feedback_info', { version: AGENTLAG_VERSION }));
            return true;

        case '/keybindings':
            say([
                t('cmd_keybindings_title'),
                `  Enter            ${t('kb_enter')}`,
                `  Shift+Tab        ${t('kb_shift_tab')}`,
                `  Esc              ${t('kb_esc')}`,
                `  Ctrl+C           ${t('kb_ctrl_c')}`,
                `  Ctrl+Z           ${t('kb_ctrl_z')}`,
                `  Ctrl+O           ${t('kb_ctrl_o')}`,
                `  Ctrl+T           ${t('kb_ctrl_t')}`,
                `  Alt+P            ${t('kb_alt_p')}`,
                `  !                ${t('kb_shell')}`,
                `  @                ${t('kb_at')}`,
                `  /                ${t('kb_slash')}`,
            ].join('\n'));
            return true;

        case '/hooks': {
            let data = {};
            try { data = JSON.parse(fs.readFileSync(HOOKS_FILE, 'utf8')); } catch {}
            const entries = Object.entries(data);
            if (entries.length === 0) {
                say(t('cmd_hooks_none', { file: HOOKS_FILE }));
            } else {
                const lines = [t('cmd_hooks_title')];
                for (const [event, cmds] of entries)
                    lines.push(`  • ${event}: ${(Array.isArray(cmds) ? cmds : [cmds]).join(' ; ')}`);
                say(lines.join('\n'));
            }
            return true;
        }


        case '/agents': {
            let entries = [];
            try { entries = fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.json')); } catch {}
            if (entries.length === 0) {
                say(t('cmd_agents_none', { dir: AGENTS_DIR }));
            } else {
                const lines = [t('cmd_agents_title')];
                for (const f of entries) {
                    try {
                        const def = JSON.parse(fs.readFileSync(path.join(AGENTS_DIR, f), 'utf8'));
                        lines.push(`  • ${path.basename(f, '.json')} — ${def.description || '(no description)'}`);
                    } catch {
                        lines.push(`  • ${path.basename(f, '.json')} — (invalid file)`);
                    }
                }
                say(lines.join('\n'));
            }
            return true;
        }

        case '/ide': {
            const term  = process.env.TERM_PROGRAM || process.env.TERM || 'unknown';
            const inIDE = !!(process.env.VSCODE_INJECTION || process.env.CURSOR_TRACE_ID || process.env.JETBRAINS_IDE);
            say(t('cmd_ide_info', { term, inIDE: inIDE ? 'yes' : 'no' }));
            return true;
        }

        case '/consolidate': {
            if (!historyRef.current.length) {
                say(t('cmd_consolidate_none'));
                return true;
            }
            say(t('cmd_consolidate_starting'));
            (async () => {
                try {
                    const ag  = await buildAgent();
                    const res = await consolidateHistory(historyRef.current, ag.llm);
                    say(res);
                } catch (e) {
                    say(t('cmd_consolidate_error', { error: e.message }));
                }
            })();
            return true;
        }

        case '/memory': {
            let content = '';
            try { content = fs.readFileSync(MEMORY_FILE, 'utf8'); } catch {}
            if (!args) {
                if (!content.trim())
                    say(t('cmd_memory_empty', { file: MEMORY_FILE }));
                else
                    say(t('cmd_memory_title', { file: MEMORY_FILE }) + `\n\n${content.trim()}`);
                return true;
            }
            const sub  = rest[0]?.toLowerCase();
            const note = rest.slice(1).join(' ').trim();
            if (sub === 'add' && note) {
                try { /* ensureDir ya garantiza CONFIG_DIR */ } catch {}
                fs.appendFileSync(MEMORY_FILE, `- ${note}\n`);
                say(t('cmd_memory_added', { note }));
            } else if (sub === 'clear') {
                try { fs.writeFileSync(MEMORY_FILE, ''); } catch {}
                say(t('cmd_memory_cleared'));
            } else {
                say(t('cmd_memory_usage'));
            }
            return true;
        }

        case '/sessions': {
            const list = listConversations();
            if (list.length === 0) say(t('cmd_sessions_empty'));
            else say(t('cmd_sessions_title') + `\n  ${list.join('\n  ')}\n\n${t('cmd_sessions_usage')}`);
            return true;
        }

        case '/skills': {
            const [subRaw, ...subArgs] = rest;
            const sub  = (subRaw || 'list').toLowerCase();
            const tail = subArgs.join(' ').trim();

            if (sub === 'list') {
                say(t('cmd_skills_list_title') + `\n${formatSkillsIndex(process.cwd())}`);
                return true;
            }
            if (sub === 'read') {
                if (!tail) { say(t('cmd_skills_read_usage')); return true; }
                const skill = readSkill(tail, process.cwd());
                if (!skill) say(t('cmd_skills_not_found', { name: tail }));
                else say(`${t('cmd_skills_read_header', { name: skill.name, scope: skill.scope })}\n${skill.path}\n\n${skill.content}`);
                return true;
            }
            if (sub === 'find' || sub === 'search') {
                if (!tail) { say(t('cmd_skills_search_usage')); return true; }
                say(t('cmd_skills_searching', { query: tail }), true);
                runCommand('npx', ['-y', 'skills', 'find', tail]).then(({ code, output }) => {
                    const clean = output.trim() || '(no output)';
                    say(code === 0 ? clean : t('cmd_skills_search_error', { error: clean }));
                });
                return true;
            }
            if (sub === 'add' || sub === 'install') {
                const parsedArgs = splitCommandArgs(subArgs.join(' '));
                const source     = parsedArgs[0];
                if (!source) {
                    say(t('cmd_skills_install_usage'));
                    return true;
                }
                const extra = parsedArgs.slice(1);
                say(t('cmd_skills_installing', { source }), true);
                runCommand('npx', ['-y', 'skills', 'add', source, '-y', ...extra]).then(({ code, output }) => {
                    const clean = output.trim() || '(no output)';
                    say(code === 0 ? clean : t('cmd_skills_install_error', { error: clean }));
                    if (code === 0) { clearSkillsCache(); rebuildAgentWith(); }
                });
                return true;
            }
            if (sub === 'check' || sub === 'update') {
                say(t('cmd_skills_updating', { sub }), true);
                runCommand('npx', ['-y', 'skills', sub, '-y']).then(({ code, output }) => {
                    const clean = output.trim() || '(sin salida)';
                    say(code === 0 ? clean : t('cmd_skills_update_error', { sub, error: clean }));
                    if (code === 0) { clearSkillsCache(); rebuildAgentWith(); }
                });
                return true;
            }
            say(t('cmd_skills_usage_full'));
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
                    { type: 'assistant', text: t('cmd_resume_ok', { name: s.name || args || 'latest' }), ephemeral: true },
                ]);
            } else {
                const available = listConversations();
                const suffix    = available.length ? `\nAvailable: ${available.join(', ')}` : '';
                say(t('cmd_resume_none', { args: args ? `: ${args}` : ' in this project', available: suffix }), true);
            }
            return true;
        }

        case '/rename': {
            if (!args) { say(t('cmd_rename_usage')); return true; }
            const next = normalizeConversationName(args);
            if (!next) { say(t('cmd_rename_error')); return true; }
            currentConversationRef.current = next;
            const saved = saveSession(historyRef.current, next);
            say(t('cmd_rename_ok', { name: saved?.name || next }));
            return true;
        }

        case '/branch': {
            const branchName = args
                ? normalizeConversationName(args)
                : `${currentConversationRef.current || 'branch'}-${Date.now().toString(36)}`;
            const saved = saveSession(historyRef.current, branchName);
            if (saved?.name) {
                currentConversationRef.current = saved.name;
                say(t('cmd_branch_ok', { name: saved.name }));
            } else {
                say(t('cmd_branch_error'));
            }
            return true;
        }

        case '/btw':
            say(args
                ? t('cmd_btw_note', { args })
                : t('cmd_btw_info'));
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
                say(t('cmd_deepsearch_usage'));
                return true;
            }

            const topic = args.trim();
            say(t('cmd_deepsearch_starting', { topic: topic.slice(0, 50) + (topic.length > 50 ? '...' : '') }));

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

                updateStatus(t('cmd_deepsearch_investigating', { dots: '○ ○ ○ ○ ○' }));

                for (let i = 0; i < subQuestions.length; i++) {
                    const question = subQuestions[i];
                    try {
                        const result = await webSearch.invoke({ query: question });
                        results.push({ question, content: result });
                    } catch (e) {
                        results.push({ question, content: `⚠️ Error: ${e.message}` });
                        errorCount++;
                    }
                    const dots = '● '.repeat(i + 1) + '○ '.repeat(subQuestions.length - (i + 1));
                    updateStatus(t('cmd_deepsearch_investigating', { dots: dots.trim() }));
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
                    updateStatus(t('error_prefix', { error: `Deep Search completado pero falló al guardar: ${e.message}\n\nResultados:\n${doc.slice(0, 500)}...` }));
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
                say(t('cmd_standup_none'));
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
                    t('cmd_standup_ok'),
                    '',
                    t('cmd_standup_summary_completed', { count: completed.split('\n').filter(l=>l.startsWith('-')).length }),
                    t('cmd_standup_summary_blockers', { count: blockers.split('\n').filter(l=>l.startsWith('-')).length }),
                    t('cmd_standup_summary_next', { count: nextSteps.split('\n').filter(l=>l.startsWith('-')).length }),
                    '',
                    t('standup_report', { file: outFile }),
                ].join('\n'));
            } catch (e) {
                say(t('error_prefix', { error: `${t('cmd_standup_error')}: ${e.message}\n\n${doc.slice(0, 800)}` }));
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
                say(t('cmd_review_usage'));
                return true;
            }

            const filePath = path.resolve(process.cwd(), args.trim());
            let fileContent;
            try {
                fileContent = fs.readFileSync(filePath, 'utf8');
            } catch (e) {
                say(t('cmd_review_error', { path: filePath, error: e.message }));
                return true;
            }

            say(t('cmd_review_starting', { path: args.trim() }));

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
                issues.push(t('review_issue_debug'));
            if (/TODO|FIXME|HACK|XXX/g.test(fileContent))
                issues.push(t('review_issue_todo'));
            if (/password|secret|api_key|apikey|token\s*=/gi.test(fileContent))
                issues.push(t('review_issue_secret'));
            if (/catch\s*\(\s*\)\s*\{?\s*\}|except\s*:\s*pass/g.test(fileContent))
                issues.push(t('review_issue_empty_catch'));
            if (lines > 500)
                issues.push(t('review_issue_long_file', { lines }));
            if (/eval\s*\(|exec\s*\(/g.test(fileContent))
                issues.push(t('review_issue_eval'));
            if (/http:\/\//g.test(fileContent))
                issues.push(t('review_issue_http'));

            const issueBlock = issues.length > 0 ? issues.join('\n') : t('review_no_issues');

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
                `| ${t('review_metric')} | ${t('review_value')} |`,
                `|---------|-------|`,
                `| ${t('review_metric_lines')} | ${lines} |`,
                `| ${t('review_metric_fns')} | ${fnMatches.length} |`,
                `| ${t('review_metric_imports')} | ${importLines.length} |`,
                `| ${t('review_metric_comments')} | ${commentLines} (${commentRatio}%) |`,
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
                    t('cmd_review_ok', { name: path.basename(filePath) }),
                    '',
                    issueBlock,
                    '',
                    t('review_report', { file: outFile }),
                ].join('\n'));
            } catch (e) {
                say(t('error_prefix', { error: `${e.message}\n\n${issueBlock}` }));
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
            say(t('cmd_changelog_starting', { limit }));

            let gitLog;
            try {
                gitLog = execSync(
                    `git log --pretty=format:"%ad|%s|%an" --date=short -n ${limit}`,
                    { cwd: process.cwd(), encoding: 'utf8', timeout: 15000 }
                );
            } catch (e) {
                say(t('cmd_changelog_error', { error: e.message }));
                return true;
            }

            if (!gitLog.trim()) {
                say(t('cmd_changelog_none'));
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
            const typeLabel = {
                feat: t('changelog_feat'),
                fix: t('changelog_fix'),
                docs: t('changelog_docs'),
                style: t('changelog_style'),
                refactor: t('changelog_refactor'),
                test: t('changelog_test'),
                chore: t('changelog_chore'),
                perf: t('changelog_perf'),
                ci: t('changelog_ci'),
                build: t('changelog_build'),
                revert: t('changelog_revert'),
                other: t('changelog_other')
            };

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
                say(t('cmd_changelog_ok', { count: commits.length, file: outFile }));
            } catch (e) {
                say(t('error_prefix', { error: e.message }));
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
            say(t('cmd_todo_starting', { path: scanDir }));

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
                say(t('cmd_todo_none'));
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
                say(t('cmd_todo_ok', { count: items.length, summary, file: outFile2 }));
            } catch (e) {
                say(t('error_prefix', { error: e.message }));
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
            const auditMsg = `Realiza una auditoría de seguridad completa del proyecto actual.
Por favor:
1. Ejecuta 'npm audit' si es un proyecto Node.js.
2. Busca secrets expuestos (API keys, passwords, tokens) usando search_in_files o grep.
3. Busca patrones peligrosos (eval, innerHTML, http sin https, catch vacíos).
4. Verifica si hay archivos sensibles expuestos (.env, claves privadas).
5. Genera un reporte detallado en Markdown y guárdalo en .agentlag/audits/audit-[timestamp].md.
6. Resume los hallazgos principales aquí.`;

            if (ctx.runAgentTurn) {
                ctx.runAgentTurn(auditMsg, ctx);
            } else {
                say(t('cmd_task_chat_plan', { msg: auditMsg }));
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
                say(t('cmd_explain_usage'));
                return true;
            }

            const filePath4 = path.resolve(process.cwd(), args.trim());
            let fileContent4;
            try {
                fileContent4 = fs.readFileSync(filePath4, 'utf8');
            } catch (e) {
                say(t('cmd_explain_error', { path: filePath4, error: e.message }));
                return true;
            }

            say(t('cmd_explain_starting', { path: args.trim() }));

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
                t('explain_summary', { functions: functions.length, classes: classes4.length, imports: imports4.length, exports: exports4.length }),
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
                    t('cmd_explain_ok', { name: path.basename(filePath4) }),
                    t('explain_metrics', { functions: functions.length, classes: classes4.length, imports: imports4.length }),
                    t('explain_report', { file: outFile4 }),
                ].join('\n'));
            } catch (e) {
                say(t('error_prefix', { error: e.message }));
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
            say(t('cmd_diagram_starting', { path: scanDir2 }));


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
                say(t('cmd_diagram_none'));
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
                    t('cmd_diagram_ok'),
                    t('diagram_metrics', { files: fileList.length, edges: edges.length }),
                    t('diagram_report', { file: outFile5 }),
                    '',
                    t('cmd_diagram_tip'),
                ].join('\n'));
            } catch (e) {
                say(t('error_prefix', { error: e.message }));
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
                say(t('cmd_task_usage'));
                return true;
            }

            const taskDesc = args.trim();
            say(t('cmd_task_starting', { topic: taskDesc }));

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

            const subPlan = subtasks.map((s,i)=>`  ${i+1}. [${s.name}] ${s.task.slice(0,80)}...`).join('\n');
            say(t('cmd_task_plan', { count: subtasks.length, plan: subPlan }));

            // Agregar a historial para que el agente lo procese
            const delegationMsg = `Please execute this task by delegating to subagents in parallel using the delegate_to_subagents tool:\n\nMain task: ${taskDesc}\n\nDelegations:\n${JSON.stringify(subtasks, null, 2)}`;

            if (msgRef?.current !== undefined) {
                msgRef.current = delegationMsg;
                say(t('cmd_task_delegated'));
            } else {
                say(t('cmd_task_chat_plan', { msg: delegationMsg }));
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
                say(t('cmd_draft_usage'));
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
                say(t('cmd_draft_error', { type }));
                return true;
            }

            // Guardar el borrador
            const outDir6  = path.join(process.cwd(), '.agentlag', 'drafts');
            const outFile6 = path.join(outDir6, `draft-${type}-${Date.now()}.md`);
            try {
                fs.mkdirSync(outDir6, { recursive: true });
                fs.writeFileSync(outFile6, draft, 'utf8');
                say(t('cmd_draft_ok', { type, draft, file: outFile6 }));
            } catch {
                say(t('cmd_draft_chat_ok', { type, draft }));
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
                say(t('cmd_compare_usage'));
                return true;
            }

            const [file1Path, file2Path] = parts.map(p => path.resolve(process.cwd(), p));
            let content1, content2;

            try { content1 = fs.readFileSync(file1Path, 'utf8'); } catch (e) { say(t('cmd_compare_error', { path: file1Path })); return true; }
            try { content2 = fs.readFileSync(file2Path, 'utf8'); } catch (e) { say(t('cmd_compare_error', { path: file2Path })); return true; }

            say(t('cmd_compare_starting', { name1: path.basename(file1Path), name2: path.basename(file2Path) }));

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
                    t('cmd_compare_ok'),
                    t('compare_metrics', { lines1, lines2, diff: diffSign }),
                    t('compare_summary', { addedFns: addedFns.length, removedFns: removedFns.length }),
                    t('compare_imports', { addedImps: addedImps.length, removedImps: removedImps.length }),
                    t('compare_report', { file: outFile7 }),
                ].join('\n'));
            } catch (e) {
                say(t('error_prefix', { error: e.message }));
            }
            return true;
        }

        default:
            return false;
    }
}

// ─── Natural-language scheduling ─────────────────────────────────────────────
//
// parseScheduleWithLLM(description, agent) -> { id, cronExp, prompt } | null
//
// Uses the agent's underlying LLM (agent.llm) to convert a natural-language
// description like "every day at 9am run npm test" into a structured
// { id, cronExp, prompt } object that the Scheduler can consume.
//
// The cron expression must be a 5-field standard cron (min hour day month
// weekday) — node-cron compatible. We validate with node-cron's validate()
// before returning.

const SCHEDULE_ID_RE = /^[a-z0-9][a-z0-9-_]{0,63}$/i;

export async function parseScheduleWithLLM(description, agent) {
    if (!description || typeof description !== 'string') return null;

    // Try to grab the underlying LLM. The agent compiled by buildAgent()
    // exposes `.llm`; if not, fall back to the agent itself.
    const llm = agent?.llm || agent;
    if (!llm || typeof llm.invoke !== 'function') return null;

    const prompt = `You are a scheduling assistant. Convert the user's natural-language request into a JSON object with three fields:

- "id": a short, kebab-case identifier for the task (lowercase, ≤40 chars). Derive it from what the task does, not the schedule.
- "cronExp": a standard 5-field cron expression (minute hour day-of-month month day-of-week) compatible with node-cron. Use 24-hour time. Examples:
    "0 9 * * *"     -> every day at 09:00
    "*/30 * * * *"  -> every 30 minutes
    "0 9 * * 1"     -> every Monday at 09:00
    "0 0 1 * *"     -> first day of every month at 00:00
    "0 18 * * 1-5"  -> weekdays at 18:00
- "prompt": the exact prompt that should be sent to the agent when the cron fires. Should be a self-contained instruction in the SAME language as the user's request.

User's request: """${description}"""

Respond with ONLY the JSON object, no markdown fences, no commentary. If the request cannot be turned into a valid cron schedule (e.g. vague timing, one-time-only event), respond with: {"error": "reason"}`;

    let response;
    try {
        response = await llm.invoke([
            new SystemMessage("You convert natural-language scheduling requests into JSON. You output ONLY JSON — no prose, no code fences."),
            new HumanMessage(prompt),
        ]);
    } catch (err) {
        console.error('parseScheduleWithLLM invoke error:', err);
        return null;
    }

    const content = typeof response.content === 'string'
        ? response.content
        : (Array.isArray(response.content)
            ? response.content.map(p => typeof p === 'string' ? p : p?.text || '').join('\n')
            : JSON.stringify(response.content));

    // Strip markdown fences if present
    const fenceMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonSource = fenceMatch ? fenceMatch[1] : content;

    const match = jsonSource.match(/\{[\s\S]*\}/);
    if (!match) return null;

    let parsed;
    try {
        parsed = JSON.parse(match[0]);
    } catch {
        return null;
    }

    if (parsed.error || !parsed.id || !parsed.cronExp || !parsed.prompt) return null;

    // Normalize and validate
    const id       = String(parsed.id).trim();
    const cronExp  = String(parsed.cronExp).trim();
    const taskPrompt = String(parsed.prompt).trim();

    if (!SCHEDULE_ID_RE.test(id)) return null;
    if (!cron.validate(cronExp)) return null;
    if (!taskPrompt || taskPrompt.length > 2000) return null;

    return { id, cronExp, prompt: taskPrompt };
}
