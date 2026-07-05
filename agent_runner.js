// ─── agent_runner.js ──────────────────────────────────────────────────────────
// Lógica de invocación del agente: stream, retry en ReAct, descarga HF.
import fs   from 'fs';
import path from 'path';
import os   from 'os';
import { spawn } from 'child_process';
import { HumanMessage, AIMessage, SystemMessage } from '@langchain/core/messages';
import { buildAgent, stripMarkdown, trySalvageToolCall, messageText, createLLM, loadConfig, buildSystemPrompt } from './agent.js';
import { tools } from './tools.js';
import { addToMemory, listMemory } from './memory_utils.js';
import { RecordingSession } from './recording_logger.js';
import { analyzeAndEvolve } from './evolution_engine.js';
import { addEvolution } from './evolution_store.js';
import { isToolUnsupportedError, extractFailedGeneration, isRateLimitError } from './utils.js';
import { t } from './i18n.js';

export const SPINNERS       = ['✻', '✼', '✽', '✾', '✿'];
export const THINKING_WORDS = ['think_1', 'think_2', 'think_3', 'think_4', 'think_5', 'think_6', 'think_7', 'think_8'];
export const TOOL_ICONS     = { create_file:'●', read_file:'●', edit_file:'●', list_directory:'●', search_in_files:'●', show_diff:'●', apply_patch:'●', run_shell:'●', web_search:'●', list_skills:'●', read_skill:'●', find_skills:'●', add_skill:'●' };
export const NEEDS_CONFIRM  = new Set(['run_shell', 'create_file', 'edit_file', 'apply_patch', 'add_skill']);

export const randWord = () => {
    const key = THINKING_WORDS[Math.floor(Math.random() * THINKING_WORDS.length)];
    return t(key);
};

// ── Stream del agente ─────────────────────────────────────────────────────────

/**
 * Procesa un turno completo del agente (stream + tool confirms + retry en ReAct).
 *
 * @param {string} msg          - Mensaje del usuario.
 * @param {object} ctx          - Contexto de la aplicación.
 */
export async function runAgentTurn(msg, ctx) {
    const {
        agent, msgRef,
        setStaticHistory, setStatus, setActiveTool,
        setThinkWord, setThinkStart, setElapsed, setTotalTokens,
        abortCtrlRef, askConfirm,
        setAgent, setForceReAct, persistFlag,
        setLastError,
    } = ctx;

    const session = new RecordingSession(msg);

    if (!agent) {
        setStaticHistory(prev => [...prev, { type: 'assistant', text: t('agent_not_initialized') }]);
        return;
    }

    setStaticHistory(prev => [...prev, { type: 'user', text: msg }]);
    session.logInteraction('user', msg);
    setThinkWord(randWord()); setThinkStart(Date.now()); setElapsed(0);
    setStatus('thinking'); setActiveTool(null);

    // Detección de imágenes para multimodal
    const imageRegex = /\b\S+\.(png|jpg|jpeg|webp|gif)\b/gi;
    const foundImages = [];
    for (const imgPath of (msg.match(imageRegex) || [])) {
        try {
            const fullPath = path.resolve(process.cwd(), imgPath);
            if (fs.existsSync(fullPath)) {
                const ext    = path.extname(fullPath).toLowerCase().replace('.', '');
                const base64 = fs.readFileSync(fullPath).toString('base64');
                foundImages.push({
                    type: 'image_url',
                    image_url: { url: `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${base64}` },
                });
            }
        } catch {}
    }

    if (foundImages.length > 0) {
        msgRef.current = [...msgRef.current, new HumanMessage({ content: [{ type: 'text', text: msg }, ...foundImages] })];
    } else {
        msgRef.current = [...msgRef.current, new HumanMessage(msg)];
    }

    abortCtrlRef.current = new AbortController();

    try {
        const response = await _streamAgent(agent, msgRef, setStaticHistory, setStatus, setActiveTool,
            setThinkWord, setThinkStart, setTotalTokens, abortCtrlRef, askConfirm);

        if (response) {
            const text = typeof response === 'string' ? response : messageText(response);
            const cleaned = stripMarkdown(text);
            setStaticHistory(prev => [...prev, { type: 'assistant', text: cleaned }]);
            session.logInteraction('assistant', cleaned);
        }

        // Reset UI status immediately after response
        setStatus('idle'); setActiveTool(null); setThinkStart(null); setElapsed(0);

        // Run evolution analysis in background.
        // NOTE: session.save() returns a file PATH (string), not the recording
        // object. analyzeAndEvolve needs the actual data — pass it explicitly.
        (async () => {
            try {
                const recordingData = {
                    task:      session.taskQuery,
                    startTime: session.startTime,
                    endTime:   new Date().toISOString(),
                    status:    'success',
                    events:    session.events,
                };
                // Persist the recording to disk + SQLite as before
                await session.save('success');
                const evolution = await analyzeAndEvolve(recordingData, agent);
                if (evolution) {
                    addEvolution(evolution);
                    setStaticHistory(prev => [...prev, {
                        type: 'assistant',
                        text: `✨ Oportunidad de evolución detectada: ${evolution.skillName}\nMotivo: ${evolution.reason}\n¿Deseas aplicar esta mejora? (Usa /evolve para confirmar)`,
                    }]);
                }
            } catch (evolveErr) {
                console.error("Error in background evolution:", evolveErr);
            }
        })();

    } catch (err) {
        if (setLastError) setLastError(err);
        await _handleAgentError(err, agent, msgRef, setStaticHistory, setStatus, setActiveTool,
            setThinkWord, setThinkStart, setTotalTokens, abortCtrlRef, askConfirm,
            setAgent, setForceReAct, persistFlag, setLastError);
    } finally {
        setStatus('idle'); setActiveTool(null); setThinkStart(null); setElapsed(0);
    }
}

// ── Internos ──────────────────────────────────────────────────────────────────

async function _streamAgent(agent, msgRef, setStaticHistory, setStatus, setActiveTool,
    setThinkWord, setThinkStart, setTotalTokens, abortCtrlRef, askConfirm)
{
    const stream    = await agent.stream(
        { messages: msgRef.current },
        { recursionLimit: 30, signal: abortCtrlRef.current.signal }
    );
    const allChunks = [];
    let pendingTC   = null;

    for await (const chunk of stream) {
        allChunks.push(chunk);

        if (chunk.agent) {
            let last = chunk.agent.messages?.at(-1);
            if (last && (!last.tool_calls || last.tool_calls.length === 0)) {
                const salvaged = trySalvageToolCall(last);
                if (salvaged) last = salvaged;
            }
            if (last?.tool_calls?.length > 0) {
                const tc = last.tool_calls[0];
                pendingTC = { name: tc.name, args: tc.args };

                if (NEEDS_CONFIRM.has(tc.name)) {
                    let detail = '';
                    try { const a = tc.args; detail = a.path || a.command || a.filename || JSON.stringify(a).slice(0, 80); } catch {}
                    setStatus('idle');
                    const ok = await askConfirm(tc.name, detail);
                    if (!ok) {
                        setStaticHistory(prev => [...prev, { type: 'assistant', text: t('action_cancelled') }]);
                        setStatus('idle');
                        return null;
                    }
                }
                setStatus('running');
                setActiveTool({ name: tc.name, input: tc.args });
                setThinkWord(randWord()); setThinkStart(Date.now());
            } else {
                setStatus('thinking'); setActiveTool(null);
            }

            const usage = last?.response_metadata?.token_usage || last?.usage_metadata;
            if (usage) {
                const t = usage.total_tokens || (usage.input_tokens || 0) + (usage.output_tokens || 0);
                if (t) setTotalTokens(prev => prev + t);
            }
        }

        if (chunk.tools) {
            for (const tm of (chunk.tools.messages || [])) {
                if (tm.name && tm.content !== undefined) {
                    setStaticHistory(prev => [...prev, {
                        type: 'tool', name: tm.name,
                        input:  pendingTC?.name === tm.name ? pendingTC.args : null,
                        output: tm.content, running: false,
                    }]);
                    setActiveTool(null);
                    setStatus('thinking'); setThinkWord(randWord()); setThinkStart(Date.now());
                }
            }
        }
    }

    // Extraer respuesta final (AIMessage completo para manejar contenido multimodal/arrays)
    let finalAIMessage = null;
    for (let i = allChunks.length - 1; i >= 0; i--) {
        const nd = allChunks[i].agent || allChunks[i].tools;
        if (!nd?.messages) continue;
        for (let j = nd.messages.length - 1; j >= 0; j--) {
            const m = nd.messages[j];
            if (m instanceof AIMessage) {
                const text = messageText(m);
                if (text && text.trim()) {
                    finalAIMessage = m;
                    break;
                }
            }
        }
        if (finalAIMessage) break;
    }

    const allMsgs = [];
    for (const c of allChunks)
        for (const nk of ['agent', 'tools'])
            if (c[nk]?.messages) allMsgs.push(...c[nk].messages);
    msgRef.current = [...msgRef.current, ...allMsgs];

    return finalAIMessage;
}

async function _handleAgentError(err, agent, msgRef, setStaticHistory, setStatus, setActiveTool,
    setThinkWord, setThinkStart, setTotalTokens, abortCtrlRef, askConfirm,
    setAgent, setForceReAct, persistFlag, setLastError)
{
    if (err?.message?.includes('Recursion limit')) {
        setStaticHistory(prev => [...prev, { type: 'assistant', text: t('recursion_limit_error') }]);
        setStatus('idle');
        return;
    }
    if (isToolUnsupportedError(err)) {
        const salvaged = extractFailedGeneration(err);
        if (salvaged) {
            setStaticHistory(prev => [...prev, { type: 'assistant', text: salvaged }]);
            msgRef.current = [...msgRef.current, new AIMessage(salvaged)];
        }
        setStaticHistory(prev => [...prev, {
            type: 'assistant',
            text: salvaged
                ? t('react_activating')
                : t('no_tool_calling'),
        }]);
        try {
            const reactAgent = await buildAgent({ forceReAct: true });
            setAgent(reactAgent);
            setForceReAct(true);
            persistFlag('forceReAct', true);
            if (salvaged) return;
            setStatus('thinking'); setThinkWord(randWord()); setThinkStart(Date.now());
            const retryText = await _streamAgent(reactAgent, msgRef, setStaticHistory, setStatus,
                setActiveTool, setThinkWord, setThinkStart, setTotalTokens, abortCtrlRef, askConfirm);
            if (retryText) {
                setStaticHistory(prev => [...prev, { type: 'assistant', text: stripMarkdown(retryText) }]);
            }
        } catch (e) {
            if (e?.message?.includes('Recursion limit')) {
                setStaticHistory(prev => [...prev, { type: 'assistant', text: t('recursion_limit_react') }]);
            } else if (isRateLimitError(e)) {
                setStaticHistory(prev => [...prev, { type: 'assistant', text: `\u26a0\ufe0f Rate limit alcanzado. El modelo gratuito tiene request limits estrictos. Espera unos segundos e intenta de nuevo.` }]);
            } else {
                setStaticHistory(prev => [...prev, { type: 'assistant', text: t('critical_react_error', { error: e?.message || e }) }]);
            }
        }
    } else if (isRateLimitError(err)) {
        setStaticHistory(prev => [...prev, { type: 'assistant', text: `\u26a0\ufe0f Rate limit del proveedor. Espera unos segundos e intenta de nuevo.` }]);
    } else {
        setStaticHistory(prev => [...prev, { type: 'assistant', text: `❌ Error: ${err?.message || err}` }]);
    }
}

// ── Modo stream: tokens uno por uno (LLM directo, sin tools) ──────────────────

/**
 * Detecta y ejecuta tool calls "alucinados" en texto plano.
 *
 * En modo streaming usamos un LLM sin bindTools para garantizar streaming
 * token-a-token. Pero cuando el agente "quiere" llamar una tool (ej:
 * manage_memory para guardar el nombre del usuario), no puede — y alucina
 * el tool call como texto plano: un bloque JSON con name + args, o texto
 * como "Action: manage_memory Action Input: {...}".
 *
 * Esta función detecta esos patrones, ejecuta las tools reales de forma
 * segura (solo las que están en la whitelist), y devuelve el texto limpio
 * + los resultados de las tools ejecutadas.
 *
 * Whitelist: solo tools seguras y deterministas (manage_memory, read_file,
 * list_directory, list_skills, read_skill). NO ejecutamos run_shell,
 * create_file, edit_file, apply_patch, etc. — esas requieren confirmación
 * del usuario y deben ir por el flujo normal con tools nativas.
 */
const SAFE_HALLUCINATED_TOOLS = new Set([
    'manage_memory', 'read_file', 'list_directory', 'list_skills', 'read_skill',
]);

function _executeHallucinatedToolCalls(text) {
    if (!text || typeof text !== 'string') return { cleanedText: text || '', toolResults: [] };

    const toolResults = [];
    let cleanedText = text;

    // Patrón 1: bloque JSON con { "name": "tool_name", "args": {...} }
    // o { "name": "tool_name", "parameters": {...} } o { "tool": "...", "input": {...} }
    // Acepta variants con comillas dobles o sin comillas en las keys.
    const jsonBlockRegex = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/g;
    const matches = [...text.matchAll(jsonBlockRegex)];

    for (const match of matches) {
        const jsonStr = match[1];
        try {
            const parsed = JSON.parse(jsonStr);
            // Normalizar: buscar name/tool/action + args/parameters/input
            const toolName = parsed.name || parsed.tool || parsed.action || parsed.call;
            const toolArgs = parsed.args || parsed.parameters || parsed.input || parsed.arguments || {};

            if (toolName && SAFE_HALLUCINATED_TOOLS.has(toolName)) {
                const result = _runSafeTool(toolName, toolArgs);
                if (result !== null) {
                    toolResults.push({ name: toolName, args: toolArgs, output: result });
                    // Quitar el bloque JSON alucinado del texto.
                    cleanedText = cleanedText.replace(match[0], '');
                }
            }
        } catch {
            // No es JSON válido — ignorar.
        }
    }

    // Patrón 2: JSON suelto (sin code fence) que parezca un tool call.
    // Solo lo procesamos si NO encontramos ya en code fences, para evitar
    // doble ejecución. Buscamos { ... "name": "tool" ... } a nivel de línea.
    if (toolResults.length === 0) {
        const looseJsonRegex = /\{\s*"name"\s*:\s*"(\w+)"[\s\S]*?\}/g;
        const looseMatches = [...text.matchAll(looseJsonRegex)];
        for (const match of looseMatches) {
            const toolName = match[1];
            if (!SAFE_HALLUCINATED_TOOLS.has(toolName)) continue;
            try {
                const parsed = JSON.parse(match[0]);
                const toolArgs = parsed.args || parsed.parameters || parsed.input || parsed.arguments || {};
                const result = _runSafeTool(toolName, toolArgs);
                if (result !== null) {
                    toolResults.push({ name: toolName, args: toolArgs, output: result });
                    cleanedText = cleanedText.replace(match[0], '');
                }
            } catch {}
        }
    }

    // Limpiar espacios sobrantes tras quitar los bloques.
    cleanedText = cleanedText.replace(/\n{3,}/g, '\n\n').trim();

    return { cleanedText, toolResults };
}

/**
 * Ejecuta una tool segura con los args dados. Devuelve el output como string,
 * o null si la tool no es ejecutable / falla.
 */
function _runSafeTool(name, args) {
    try {
        switch (name) {
            case 'manage_memory': {
                const action = args.action;
                if (action === 'save') {
                    if (!args.key || args.value === undefined) return null;
                    addToMemory(args.key, String(args.value), {
                        project: args.project,
                        context: args.context,
                        ttlDays: args.ttlDays,
                    });
                    return `✅ Guardado en memoria: "${args.key}".`;
                }
                if (action === 'list') {
                    const mem = listMemory();
                    return mem ? `🧠 Memoria actual:\n${mem}` : '⚠️ Memoria vacía.';
                }
                return null;
            }
            // Las demás tools seguras (read_file, list_directory, list_skills,
            // read_skill) requieren acceso al sistema de tools de LangChain
            // que no tenemos aquí fácilmente. Por ahora las skippeamos — el
            // agente debería usar el modo normal (sin /stream) para esas.
            default:
                return null;
        }
    } catch (e) {
        return `❌ Error ejecutando ${name}: ${e.message}`;
    }
}

/**
 * Ejecuta un turno en modo STREAMING token-a-token.
 *
 * Construye un LLM "pelado" (sin bindTools) para garantizar que el proveedor
 * haga streaming de tokens. Algunos proveedores no soportan streaming cuando
 * hay tool-calling activo; por eso este modo bypassa el grafo LangGraph y
 * emite cada delta apenas llega.
 *
 * @param {string} msg   - Mensaje del usuario.
 * @param {object} ctx   - Contexto de la aplicación (igual que runAgentTurn).
 */
export async function runStreamTurn(msg, ctx) {
    const {
        msgRef,
        setStaticHistory, setStatus, setActiveTool,
        setThinkWord, setThinkStart, setElapsed,
        setStreamingText,
        abortCtrlRef, setLastError,
    } = ctx;

    if (!msg) return;

    // Construir el LLM pelado (sin tools) para garantizar streaming de tokens.
    let llm;
    try {
        const cfg = loadConfig();
        const provider = cfg.provider || 'groq';
        const model    = cfg.model    || 'qwen/qwen3-32b';
        const apiKey   = cfg.apiKey   || null;
        const baseUrl  = cfg.baseUrl  || null;
        const effort   = cfg.effort   || null;
        llm = await createLLM(provider, model, apiKey, baseUrl, effort, { toolsEnabled: false });
    } catch (e) {
        setStaticHistory(prev => [...prev, { type: 'assistant', text: `❌ No se pudo construir el LLM para streaming: ${e.message}` }]);
        return;
    }

    // Verificar si el LLM expone stream(). Todos los ChatModels de LangChain lo
    // hacen, pero lo comprobamos por si acaso.
    if (typeof llm.stream !== 'function') {
        setStaticHistory(prev => [...prev, {
            type: 'assistant',
            text: `⚠ Este proveedor/modelo no admite streaming de tokens. Usa el modo normal (sin /stream).`
        }]);
        return;
    }

    // IMPORTANTE: El user message se mete en staticHistory, PERO el texto
    // streaming va a `streamingText` (estado separado que se renderiza en la
    // zona activa, no en <Static>). Esto es porque <Static> congela cada item
    // tras renderizarlo una vez: si metemos el texto streaming ahí, solo se
    // vería el primer token (bug real que tuvimos).
    setStaticHistory(prev => [...prev, { type: 'user', text: msg }]);
    setStreamingText('');  // limpiar por si quedó de antes
    setThinkWord(t('think_1')); setThinkStart(Date.now()); setElapsed(0);
    setStatus('thinking'); setActiveTool(null);

    // Imagenes embebidas
    const imageRegex = /\b\S+\.(png|jpg|jpeg|webp|gif)\b/gi;
    const foundImages = [];
    for (const imgPath of (msg.match(imageRegex) || [])) {
        try {
            const fullPath = path.resolve(process.cwd(), imgPath);
            if (fs.existsSync(fullPath)) {
                const ext    = path.extname(fullPath).toLowerCase().replace('.', '');
                const base64 = fs.readFileSync(fullPath).toString('base64');
                foundImages.push({
                    type: 'image_url',
                    image_url: { url: `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${base64}` },
                });
            }
        } catch {}
    }

    if (foundImages.length > 0) {
        msgRef.current = [...msgRef.current, new HumanMessage({ content: [{ type: 'text', text: msg }, ...foundImages] })];
    } else {
        msgRef.current = [...msgRef.current, new HumanMessage(msg)];
    }

    abortCtrlRef.current = new AbortController();

    // Acumulador local para el texto completo.
    //
    // THROTTLING: No actualizamos streamingText en cada token (pueden ser
    // 50+ por segundo). Eso causaba parpadeo/flicker porque cada setStreamingText
    // dispara un re-render del componente App entero, y Ink tiene que re-escribir
    // toda la pantalla — incluyendo <Static> — lo que hace que la pantalla "salte"
    // hacia arriba y vuelva.
    //
    // Solución: flushear a streamingText cada 50ms como máximo. El último chunk
    // siempre se flushea al terminar el stream.
    let fullText = '';
    let lastFlush = 0;
    const FLUSH_INTERVAL_MS = 50;
    const flush = (force = false) => {
        const now = Date.now();
        if (force || now - lastFlush >= FLUSH_INTERVAL_MS) {
            setStreamingText(fullText);
            lastFlush = now;
        }
    };
    try {
        const cfg = loadConfig();
        const provider = cfg.provider || 'groq';
        const model    = cfg.model    || 'qwen/qwen3-32b';
        const baseSys  = buildSystemPrompt(provider, model, tools);
        // Añadir aviso de modo streaming: el agente NO tiene tools disponibles
        // en este turno, así que debe responder en lenguaje natural. Si quiere
        // guardar algo en memoria, puede incluir un bloque JSON con el formato
        // {"name":"manage_memory","args":{"action":"save","key":"...","value":"..."}}
        // y el post-procesador lo ejecutará. Para todo lo demás (leer archivos,
        // ejecutar comandos, etc.), debe pedir al usuario que desactive /stream.
        const streamSysContent = baseSys.content + `

⚠ MODO STREAMING ACTIVO: En este turno NO tienes acceso a tools. Responde en lenguaje natural, conciso.

EXCEPCIÓN — memoria: Si el usuario te da información que debas recordar (nombre, preferencia, decisión), incluye al final de tu respuesta un bloque JSON con este formato exacto y el post-procesador lo ejecutará:

\`\`\`json
{"name":"manage_memory","args":{"action":"save","key":"user_name","value":"Harry"}}
\`\`\`

Para cualquier otra tarea que requiera tools (leer/escribir archivos, ejecutar comandos, buscar), dile al usuario: "Desactiva /stream para esta tarea" y explica brevemente qué harías.`;
        const sysMsg   = new SystemMessage(streamSysContent);
        const messages = [sysMsg, ...msgRef.current];

        const stream = await llm.stream(messages, { signal: abortCtrlRef.current.signal });
        for await (const chunk of stream) {
            const piece = messageText(chunk);
            if (piece) {
                fullText += piece;
                flush();  // throttled — solo actualiza si pasaron 50ms
            }
        }
        flush(true);  // forzar flush del texto completo al terminar

        // POST-PROCESAMIENTO: el modo streaming usa un LLM sin tools, así que
        // cuando el agente "quiere" llamar una tool (ej: manage_memory para
        // guardar el nombre del usuario), no puede — y alucina el tool call
        // como texto plano (bloque JSON con name/args).
        // Detectamos esos patrones y ejecutamos las tools reales, luego
        // limpiamos el texto para que el usuario no vea el JSON alucinado.
        const { cleanedText, toolResults } = _executeHallucinatedToolCalls(fullText);
        if (toolResults.length > 0) {
            // Reemplazamos el texto mostrado con la versión limpia + resumen de tools ejecutadas.
            fullText = cleanedText;
            // Mostrar las tools ejecutadas como items de tipo 'tool' en el historial.
            for (const tr of toolResults) {
                setStaticHistory(prev => [...prev, {
                    type: 'tool', name: tr.name, input: tr.args, output: tr.output, running: false,
                }]);
            }
        }

        // Stream terminado: mover el texto a staticHistory y limpiar streamingText.
        if (fullText) {
            const cleaned = stripMarkdown(fullText);
            setStaticHistory(prev => [...prev, { type: 'assistant', text: cleaned }]);
            msgRef.current = [...msgRef.current, new AIMessage(fullText)];
        }
        setStreamingText('');
    } catch (err) {
        // Si había texto parcial, preservarlo en staticHistory.
        if (fullText) {
            const cleaned = stripMarkdown(fullText);
            setStaticHistory(prev => [...prev, { type: 'assistant', text: cleaned + '\n\n[streaming interrumpido]' }]);
            msgRef.current = [...msgRef.current, new AIMessage(fullText)];
        }
        setStreamingText('');
        if (err?.name === 'AbortError' || /aborted/i.test(err?.message || '')) {
            setStaticHistory(prev => [...prev, { type: 'assistant', text: t('execution_cancelled_user') }]);
        } else {
            if (setLastError) setLastError(err);
            // Detectar errores típicos de "streaming no soportado"
            const errMsg = (err?.message || '').toLowerCase();
            if (errMsg.includes('stream') || errMsg.includes('not supported') || errMsg.includes('does not support')) {
                setStaticHistory(prev => [...prev, {
                    type: 'assistant',
                    text: `⚠ El proveedor no admite streaming de tokens: ${err.message}\nUsa el modo normal (sin /stream).`
                }]);
            } else {
                setStaticHistory(prev => [...prev, { type: 'assistant', text: `❌ Error en streaming: ${err.message || err}` }]);
            }
        }
    } finally {
        setStatus('idle'); setActiveTool(null); setThinkStart(null); setElapsed(0);
        setStreamingText('');
    }
}

// ── Descarga de modelos HuggingFace ──────────────────────────────────────────

/**
 * Descarga un modelo de HuggingFace vía `huggingface_hub.commands.huggingface_cli`
 * e importa a Ollama. Llama a los callbacks para mostrar progreso en pantalla.
 */
export function downloadHFModel(modelName, { onProgress, onStatus, onDone, onError }) {
    const dlProc = spawn(
        'python3',
        ['-m', 'huggingface_hub.commands.huggingface_cli', 'download', modelName],
        { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HF_HUB_ENABLE_HF_TRANSFER: '1' } }
    );
    let dlOutput = '', cachePath = '';

    const parseDlProgress = (data) => {
        const text = data.toString();
        dlOutput  += text;
        const pct  = text.match(/(\d+)%/);
        if (pct) onProgress(Math.min(parseInt(pct[1]), 90));
        const line = text.trim().split('\n').pop() || '';
        if (line) onStatus(line.substring(0, 60));
    };

    dlProc.stdout.on('data', d => { cachePath += d.toString(); parseDlProgress(d); });
    dlProc.stderr.on('data', parseDlProgress);
    dlProc.on('error', () =>
        onError('python3 o huggingface-hub no encontrado. Instala con: pip install huggingface-hub')
    );
    dlProc.on('close', code => {
        if (code !== 0) {
            const msg = dlOutput.includes('not found')
                ? 'Modelo no encontrado en HuggingFace.'
                : `Error en descarga (código ${code}).`;
            onError(`${msg} Instala: pip install huggingface-hub`);
            return;
        }
        onProgress(90);
        onStatus('Importando modelo a Ollama...');

        const modelDir       = cachePath.trim();
        const ollamaName     = modelName.replace(/\//g, '-').toLowerCase();
        const modelfilePath  = path.join(os.tmpdir(), `Modelfile_${Date.now()}`);
        fs.writeFileSync(modelfilePath, `FROM ${modelDir}\n`);

        const createProc = spawn('ollama', ['create', ollamaName, '-f', modelfilePath], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let createOutput = '';
        createProc.stdout.on('data', d => { createOutput += d.toString(); });
        createProc.stderr.on('data', d => {
            createOutput += d.toString();
            const line = d.toString().trim().split('\n').pop() || '';
            if (line) onStatus(line.substring(0, 60));
        });
        createProc.on('close', code2 => {
            try { fs.unlinkSync(modelfilePath); } catch {}
            if (code2 === 0) { onProgress(100); onStatus('Modelo listo!'); onDone(ollamaName); }
            else onError(`Error al importar: ${createOutput.trim().substring(0, 50)}`);
        });
    });
}
