// ─── agent_runner.js ──────────────────────────────────────────────────────────
// Lógica de invocación del agente: stream, retry en ReAct, descarga HF.
import fs   from 'fs';
import path from 'path';
import os   from 'os';
import { spawn } from 'child_process';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { buildAgent, stripMarkdown, trySalvageToolCall } from './agent.js';
import { RecordingSession } from './recording_logger.js';
import { analyzeAndEvolve } from './evolution_engine.js';
import { addEvolution } from './evolution_store.js';
import { isToolUnsupportedError, extractFailedGeneration } from './utils.js';

export const SPINNERS       = ['✻', '✼', '✽', '✾', '✿'];
export const THINKING_WORDS = ['Thinking','Reasoning','Analyzing','Computing','Marinating','Levitating','Pondering','Brewing'];
export const TOOL_ICONS     = { create_file:'●', read_file:'●', edit_file:'●', list_directory:'●', search_in_files:'●', show_diff:'●', apply_patch:'●', run_shell:'●', web_search:'●', list_skills:'●', read_skill:'●', find_skills:'●', add_skill:'●' };
export const NEEDS_CONFIRM  = new Set(['run_shell', 'create_file', 'edit_file', 'apply_patch', 'add_skill']);

export const randWord = () => THINKING_WORDS[Math.floor(Math.random() * THINKING_WORDS.length)];

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
    } = ctx;

    const session = new RecordingSession(msg);

    if (!agent) {
        setStaticHistory(prev => [...prev, { type: 'assistant', text: '❌ El agente aún no está inicializado.' }]);
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
        const responseText = await _streamAgent(agent, msgRef, setStaticHistory, setStatus, setActiveTool,
            setThinkWord, setThinkStart, setTotalTokens, abortCtrlRef, askConfirm);

        if (responseText) {
            const cleaned = stripMarkdown(responseText);
            setStaticHistory(prev => [...prev, { type: 'assistant', text: cleaned }]);
            session.logInteraction('assistant', cleaned);
        }

        // Reset UI status immediately after response
        setStatus('idle'); setActiveTool(null); setThinkStart(null); setElapsed(0);

        // Run evolution analysis in background
        (async () => {
            try {
                const recording  = await session.save('success');
                const evolution  = await analyzeAndEvolve(recording, agent);
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
        await _handleAgentError(err, agent, msgRef, setStaticHistory, setStatus, setActiveTool,
            setThinkWord, setThinkStart, setTotalTokens, abortCtrlRef, askConfirm,
            setAgent, setForceReAct, persistFlag);
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
                        setStaticHistory(prev => [...prev, { type: 'assistant', text: '⚠ Acción cancelada por el usuario.' }]);
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

    // Extraer respuesta final
    let responseText = '';
    for (let i = allChunks.length - 1; i >= 0; i--) {
        const nd = allChunks[i].agent || allChunks[i].tools;
        if (!nd?.messages) continue;
        for (let j = nd.messages.length - 1; j >= 0; j--) {
            const m = nd.messages[j];
            if (m instanceof AIMessage && typeof m.content === 'string' && m.content.trim()) {
                responseText = m.content.trim(); break;
            }
        }
        if (responseText) break;
    }

    const allMsgs = [];
    for (const c of allChunks)
        for (const nk of ['agent', 'tools'])
            if (c[nk]?.messages) allMsgs.push(...c[nk].messages);
    msgRef.current = [...msgRef.current, ...allMsgs];

    return responseText;
}

async function _handleAgentError(err, agent, msgRef, setStaticHistory, setStatus, setActiveTool,
    setThinkWord, setThinkStart, setTotalTokens, abortCtrlRef, askConfirm,
    setAgent, setForceReAct, persistFlag)
{
    if (err?.message?.includes('Recursion limit')) {
        setStaticHistory(prev => [...prev, { type: 'assistant', text: '❌ Error: Se ha alcanzado el límite de recursión (30 pasos). La tarea es demasiado compleja o el agente ha entrado en un bucle infinito.' }]);
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
                ? 'ℹ️ El proveedor falló al emitir tool calls; activando modo ReAct para los próximos turnos…'
                : '⚠️ El proveedor no expone tool calling para este modelo. Cambiando a modo ReAct…',
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
                setStaticHistory(prev => [...prev, { type: 'assistant', text: '❌ Error: Se ha alcanzado el límite de recursión (30 pasos) en modo ReAct.' }]);
            } else {
                setStaticHistory(prev => [...prev, { type: 'assistant', text: `❌ Error crítico al cambiar a ReAct: ${e?.message || e}` }]);
            }
        }
    } else {
        setStaticHistory(prev => [...prev, { type: 'assistant', text: `❌ Error: ${err?.message || err}` }]);
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
