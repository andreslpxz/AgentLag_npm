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
