import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { buildAgent } from './agent.js';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Scheduler } from './scheduler.js';
import { getExecutionLogs } from './bot.js';

const app = new Hono();
const CONFIG_DIR = path.join(os.homedir(), '.agentlag');
const PROJECT_SESSION_DIR = path.join(process.cwd(), '.agentlag', 'conversations');

if (!fs.existsSync(PROJECT_SESSION_DIR)) {
    fs.mkdirSync(PROJECT_SESSION_DIR, { recursive: true });
}

let agent;
const scheduler = new Scheduler(async (prompt) => {
    if (!agent) agent = await buildAgent();
    return await agent.invoke({ messages: [new HumanMessage(prompt)] });
});

app.use('/public/*', serveStatic({ root: './' }));

app.get('/', (c) => {
    return c.redirect('/public/index.html');
});

app.post('/api/chat', async (c) => {
    const { message, history, conversationName } = await c.req.json();
    if (!agent) agent = await buildAgent();

    const messages = (history || []).map(m =>
        m.type === 'user' ? new HumanMessage(m.content) : new AIMessage(m.content)
    );
    messages.push(new HumanMessage(message));

    const result = await agent.invoke({ messages });
    const lastMsg = result.messages[result.messages.length - 1];

    // Auto-save conversation
    if (conversationName) {
        const filePath = path.join(PROJECT_SESSION_DIR, `${conversationName}.json`);
        const toSave = {
            name: conversationName,
            history: result.messages.map(m => ({
                type: m._getType(),
                content: m.content
            }))
        };
        fs.writeFileSync(filePath, JSON.stringify(toSave, null, 2));
    }

    return c.json({
        content: lastMsg.content,
        messages: result.messages
    });
});

app.get('/api/conversations', (c) => {
    const files = fs.readdirSync(PROJECT_SESSION_DIR)
        .filter(f => f.endsWith('.json'))
        .map(f => ({
            name: path.basename(f, '.json'),
            mtime: fs.statSync(path.join(PROJECT_SESSION_DIR, f)).mtime
        }))
        .sort((a, b) => b.mtime - a.mtime);
    return c.json(files);
});

app.get('/api/conversations/:name', (c) => {
    const name = c.req.param('name');
    const filePath = path.join(PROJECT_SESSION_DIR, `${name}.json`);
    if (fs.existsSync(filePath)) {
        return c.json(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    }
    return c.json({ error: 'Not found' }, 404);
});

app.post('/api/schedules', async (c) => {
    const { id, cronExp, prompt } = await c.req.json();
    scheduler.scheduleTask(id, cronExp, prompt);
    return c.json({ success: true });
});

app.get('/api/schedules', (c) => {
    return c.json(scheduler.listTasks());
});

app.get('/api/logs/scheduler', (c) => {
    const logs = getExecutionLogs();
    return c.json(logs);
});

app.delete('/api/schedules/:id', (c) => {
    const id = c.req.param('id');
    scheduler.removeTask(id);
    return c.json({ success: true });
});

const port = process.env.PORT || 3000;
console.log(`Server is running on port ${port}`);

serve({
    fetch: app.fetch,
    port
});
