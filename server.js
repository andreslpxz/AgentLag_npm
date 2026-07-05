// ─── server.js ────────────────────────────────────────────────────────────────
// Web server (Hono) for AgentLag — exposes chat (with SSE streaming),
// conversations, schedules, MCP servers, skills, plugins, providers.
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { stream as honoStream, streamSSE } from 'hono/streaming';
import { serveStatic } from '@hono/node-server/serve-static';
import { buildAgent, createLLM, loadConfig, buildSystemPrompt, messageText } from './agent.js';
import { HumanMessage, AIMessage, SystemMessage } from '@langchain/core/messages';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Scheduler } from './scheduler.js';
import { loadMcpConfig } from './mcp_utils.js';
import { listInstalledSkills } from './skills.js';
import { listPlugins, getActivePlugins } from './plugin_engine.js';
import { PROVIDERS, PROVIDER_MODELS } from './providers.js';
import { tools } from './tools.js';

const app = new Hono();
const CONFIG_DIR = path.join(os.homedir(), '.agentlag');
const PROJECT_SESSION_DIR = path.join(process.cwd(), '.agentlag', 'conversations');

if (!fs.existsSync(PROJECT_SESSION_DIR)) {
    fs.mkdirSync(PROJECT_SESSION_DIR, { recursive: true });
}

// ─── Agent cache: build once, reuse across requests ──────────────────────────
// The original server rebuilt the agent on every /api/chat call, which is slow.
let agent = null;
let agentBuildPromise = null;
async function getAgent() {
    if (agent) return agent;
    if (agentBuildPromise) return agentBuildPromise;
    agentBuildPromise = buildAgent().then(ag => { agent = ag; return ag; });
    return agentBuildPromise;
}

// Build a raw LLM (no tools) for streaming — bypasses LangGraph overhead.
let rawLlm = null;
async function getRawLlm() {
    if (rawLlm) return rawLlm;
    const cfg = loadConfig();
    const provider = cfg.provider || 'groq';
    const model    = cfg.model    || 'qwen/qwen3-32b';
    const apiKey   = cfg.apiKey   || null;
    const baseUrl  = cfg.baseUrl  || null;
    const effort   = cfg.effort   || null;
    rawLlm = await createLLM(provider, model, apiKey, baseUrl, effort, { toolsEnabled: false });
    return rawLlm;
}

const scheduler = new Scheduler(async (prompt) => {
    const ag = await getAgent();
    return await ag.invoke({ messages: [new HumanMessage(prompt)] });
});

app.use('/public/*', serveStatic({ root: './' }));

app.get('/', (c) => c.redirect('/public/index.html'));

// ─── Health / status ─────────────────────────────────────────────────────────
app.get('/api/status', (c) => {
    const cfg = loadConfig();
    return c.json({
        provider: cfg.provider || null,
        model:    cfg.model    || null,
        agentReady: !!agent,
        version: '1.1.11',
    });
});

// ─── Chat (non-streaming, keeps existing clients working) ────────────────────
app.post('/api/chat', async (c) => {
    const { message, history, conversationName } = await c.req.json();
    const ag = await getAgent();

    const messages = (history || []).map(m =>
        m.type === 'user' ? new HumanMessage(m.content) : new AIMessage(m.content)
    );
    messages.push(new HumanMessage(message));

    const result = await ag.invoke({ messages });
    const lastMsg = result.messages[result.messages.length - 1];

    // Auto-save conversation
    if (conversationName) {
        const filePath = path.join(PROJECT_SESSION_DIR, `${conversationName}.json`);
        const toSave = {
            name: conversationName,
            history: result.messages.map(m => ({
                type: m._getType(),
                content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
            }))
        };
        try { fs.writeFileSync(filePath, JSON.stringify(toSave, null, 2)); } catch {}
    }

    return c.json({
        content: typeof lastMsg.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg.content),
        messages: result.messages
    });
});

// ─── Chat (SSE streaming) — token by token ───────────────────────────────────
// Streams the assistant's response token-by-token. Falls back gracefully:
// if streaming isn't supported by the provider, emits one final chunk.
app.post('/api/chat/stream', async (c) => {
    const body = await c.req.json();
    const { message, history, conversationName } = body;

    return streamSSE(c, async (stream) => {
        const emit = (event, data) => stream.writeSSE({ event, data: JSON.stringify(data) });

        try {
            // Build messages from history + new message
            const messages = (history || []).map(m =>
                m.type === 'user' ? new HumanMessage(m.content) : new AIMessage(m.content)
            );
            messages.push(new HumanMessage(message));

            // Try raw LLM streaming (token-by-token). Bypasses LangGraph so we
            // get true token deltas instead of completed-tool-call chunks.
            const cfg = loadConfig();
            const provider = cfg.provider || 'groq';
            const model    = cfg.model    || 'qwen/qwen3-32b';
            const sysMsg   = buildSystemPrompt(provider, model, tools);
            const llm      = await getRawLlm();

            emit('start', { ok: true });

            let fullText = '';
            try {
                const llmStream = await llm.stream([sysMsg, ...messages]);
                for await (const chunk of llmStream) {
                    const piece = messageText(chunk);
                    if (piece) {
                        fullText += piece;
                        emit('token', { text: piece });
                    }
                }
            } catch (streamErr) {
                // If streaming fails (provider doesn't support it), fall back
                // to a non-streaming agent invocation and emit as one chunk.
                if (fullText) emit('token', { text: fullText });
                emit('note', { message: 'Streaming not supported by provider, using fallback.' });
                const ag = await getAgent();
                const result = await ag.invoke({ messages });
                const lastMsg = result.messages[result.messages.length - 1];
                const text = typeof lastMsg.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg.content);
                fullText = text;
                emit('token', { text });
            }

            emit('done', { fullText });

            // Auto-save conversation
            if (conversationName && fullText) {
                const filePath = path.join(PROJECT_SESSION_DIR, `${conversationName}.json`);
                const toSave = {
                    name: conversationName,
                    history: [
                        ...(history || []).map(m => ({ type: m.type, content: m.content })),
                        { type: 'user', content: message },
                        { type: 'assistant', content: fullText },
                    ]
                };
                try { fs.writeFileSync(filePath, JSON.stringify(toSave, null, 2)); } catch {}
            }
        } catch (err) {
            emit('error', { message: err?.message || String(err) });
        }
    });
});

// ─── Conversations ────────────────────────────────────────────────────────────
app.get('/api/conversations', (c) => {
    try {
        const files = fs.readdirSync(PROJECT_SESSION_DIR)
            .filter(f => f.endsWith('.json'))
            .map(f => {
                const stat = fs.statSync(path.join(PROJECT_SESSION_DIR, f));
                return {
                    name: path.basename(f, '.json'),
                    mtime: stat.mtime,
                    size:  stat.size,
                };
            })
            .sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
        return c.json(files);
    } catch (e) {
        return c.json([]);
    }
});

app.get('/api/conversations/:name', (c) => {
    const name = c.req.param('name');
    const filePath = path.join(PROJECT_SESSION_DIR, `${name}.json`);
    if (fs.existsSync(filePath)) {
        return c.json(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    }
    return c.json({ error: 'Not found' }, 404);
});

app.delete('/api/conversations/:name', (c) => {
    const name = c.req.param('name');
    const filePath = path.join(PROJECT_SESSION_DIR, `${name}.json`);
    try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        return c.json({ success: true });
    } catch (e) {
        return c.json({ success: false, error: e.message }, 500);
    }
});

app.post('/api/conversations/rename', async (c) => {
    const { oldName, newName } = await c.req.json();
    if (!oldName || !newName) return c.json({ error: 'oldName and newName required' }, 400);
    const oldPath = path.join(PROJECT_SESSION_DIR, `${oldName}.json`);
    const newPath = path.join(PROJECT_SESSION_DIR, `${newName}.json`);
    if (!fs.existsSync(oldPath)) return c.json({ error: 'Not found' }, 404);
    try {
        const data = JSON.parse(fs.readFileSync(oldPath, 'utf8'));
        data.name = newName;
        fs.writeFileSync(newPath, JSON.stringify(data, null, 2));
        fs.unlinkSync(oldPath);
        return c.json({ success: true });
    } catch (e) {
        return c.json({ error: e.message }, 500);
    }
});

// ─── Schedules ────────────────────────────────────────────────────────────────
app.post('/api/schedules', async (c) => {
    const { id, cronExp, prompt } = await c.req.json();
    try {
        scheduler.scheduleTask(id, cronExp, prompt);
        return c.json({ success: true });
    } catch (e) {
        return c.json({ success: false, error: e.message }, 400);
    }
});

app.get('/api/schedules', (c) => c.json(scheduler.listTasks()));

app.delete('/api/schedules/:id', (c) => {
    const id = c.req.param('id');
    scheduler.removeTask(id);
    return c.json({ success: true });
});

app.get('/api/logs/scheduler', (c) => {
    const EXECUTION_LOGS_FILE = path.join(process.cwd(), 'scheduler_logs.json');
    if (fs.existsSync(EXECUTION_LOGS_FILE)) {
        return c.json(JSON.parse(fs.readFileSync(EXECUTION_LOGS_FILE, 'utf8')));
    }
    return c.json([]);
});

// ─── MCP servers (read-only — list of configured MCP servers) ─────────────────
app.get('/api/mcp', (c) => {
    const cfg = loadMcpConfig();
    const servers = Object.entries(cfg?.mcpServers || {}).map(([name, def]) => ({
        name,
        command: def.command || null,
        args:    def.args || [],
        url:     def.url || null,
        type:    def.url ? 'url' : 'command',
    }));
    return c.json({ servers });
});

// ─── Skills (list installed skills) ──────────────────────────────────────────
app.get('/api/skills', (c) => {
    try {
        const skills = listInstalledSkills({ cwd: process.cwd() });
        return c.json({ skills });
    } catch (e) {
        return c.json({ skills: [], error: e.message });
    }
});

// ─── Plugins ──────────────────────────────────────────────────────────────────
app.get('/api/plugins', (c) => {
    try {
        const plugins = listPlugins();
        return c.json({ plugins });
    } catch (e) {
        return c.json({ plugins: [], error: e.message });
    }
});

// ─── Providers + models (for the UI) ─────────────────────────────────────────
app.get('/api/providers', (c) => c.json({ providers: PROVIDERS, models: PROVIDER_MODELS }));

// ─── Tools (list native tools) ────────────────────────────────────────────────
app.get('/api/tools', (c) => {
    return c.json({ tools: tools.map(t => ({ name: t.name, description: t.description })) });
});

// ─── Config (read-only subset — never expose apiKey) ─────────────────────────
app.get('/api/config', (c) => {
    const cfg = loadConfig();
    return c.json({
        provider: cfg.provider || null,
        model:    cfg.model    || null,
        effort:   cfg.effort   || null,
        forceReAct: !!cfg.forceReAct,
        focusMode:  !!cfg.focusMode,
        advisor:    !!cfg.advisor,
        language:   cfg.language || 'es',
    });
});

const port = process.env.PORT || 3000;
console.log(`AgentLag server running on http://localhost:${port}`);

// Pre-warm the agent in background so the first /api/chat is fast.
getAgent().catch(err => console.error('Agent pre-warm failed:', err.message));

serve({
    fetch: app.fetch,
    port
});
