import { StateGraph, START, Annotation } from "@langchain/langgraph";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";
import { SystemMessage, HumanMessage, AIMessage, ToolMessage } from "@langchain/core/messages";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import os from "os";

// ─── Cargar .env ──────────────────────────────────────────────────────────────
const __agentDir = path.dirname(fileURLToPath(import.meta.url));
const { config } = createRequire(import.meta.url)("dotenv");
config({ path: path.join(__agentDir, ".env") });

import { tools } from "./tools.js";

// ─── Config persistida ────────────────────────────────────────────────────────
const CONFIG_FILE = path.join(os.homedir(), ".agentlag", "config.json");

function loadConfig() {
    try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); } catch { return {}; }
}

// ─── Estado del agente ────────────────────────────────────────────────────────
const AgentState = Annotation.Root({
    messages: Annotation({
        reducer: (x, y) => x.concat(y),
        default: () => [],
    }),
});

// ─── Crear LLM según proveedor ────────────────────────────────────────────────
async function createLLM(provider, model, apiKey, baseUrl) {
    switch (provider) {
        case "groq": {
            const { ChatGroq } = await import("@langchain/groq");
            return new ChatGroq({
                model,
                apiKey: apiKey || process.env.GROQ_API_KEY,
                temperature: 0.4,
                maxTokens: 3600,
            });
        }
        case "openai": {
            const { ChatOpenAI } = await import("@langchain/openai");
            return new ChatOpenAI({
                model,
                apiKey: apiKey || process.env.OPENAI_API_KEY,
                temperature: 0.4,
                maxTokens: 3600,
            });
        }
        case "anthropic": {
            const { ChatAnthropic } = await import("@langchain/anthropic");
            return new ChatAnthropic({
                model,
                apiKey: apiKey || process.env.ANTHROPIC_API_KEY,
                maxTokens: 3600,
            });
        }
        case "openrouter": {
            const { ChatOpenAI } = await import("@langchain/openai");
            return new ChatOpenAI({
                model,
                apiKey: apiKey || process.env.OPENROUTER_API_KEY,
                configuration: { baseURL: "https://openrouter.ai/api/v1" },
                temperature: 0.4,
                maxTokens: 3600,
            });
        }
        case "deepseek": {
            const { ChatOpenAI } = await import("@langchain/openai");
            return new ChatOpenAI({
                model,
                apiKey: apiKey || process.env.DEEPSEEK_API_KEY,
                configuration: { baseURL: "https://api.deepseek.com/v1" },
                temperature: 0.4,
                maxTokens: 3600,
            });
        }
        case "mistral": {
            const { ChatMistralAI } = await import("@langchain/mistralai");
            return new ChatMistralAI({
                model,
                apiKey: apiKey || process.env.MISTRAL_API_KEY,
                temperature: 0.4,
                maxTokens: 3600,
            });
        }
        case "nvidia": {
            const { ChatOpenAI } = await import("@langchain/openai");
            return new ChatOpenAI({
                model,
                apiKey: apiKey || process.env.NVIDIA_API_KEY,
                configuration: { baseURL: "https://integrate.api.nvidia.com/v1" },
                temperature: 0.4,
                maxTokens: 3600,
            });
        }
        case "huggingface": {
            // HuggingFace models are downloaded and served via Ollama
            const { ChatOllama } = await import("@langchain/ollama");
            return new ChatOllama({
                model,
                baseUrl: baseUrl || process.env.OLLAMA_BASE_URL || "http://localhost:11434",
                temperature: 0.4,
            });
        }
        case "ollama": {
            const { ChatOllama } = await import("@langchain/ollama");
            return new ChatOllama({
                model,
                baseUrl: baseUrl || process.env.OLLAMA_BASE_URL || "http://localhost:11434",
                temperature: 0.4,
            });
        }
        case "meta": {
            // Meta via Together o similar — por defecto Together
            const { ChatOpenAI } = await import("@langchain/openai");
            return new ChatOpenAI({
                model,
                apiKey: apiKey || process.env.TOGETHER_API_KEY || process.env.META_API_KEY,
                configuration: { baseURL: "https://api.together.xyz/v1" },
                temperature: 0.4,
                maxTokens: 3600,
            });
        }
        default:
            throw new Error(`Proveedor no soportado: "${provider}". Revisa ~/.agentlag/config.json`);
    }
}

// ─── System prompt ────────────────────────────────────────────────────────────
function buildSystemPrompt(provider, model) {
    return new SystemMessage(
        `Eres AgentLag, un asistente experto en desarrollo de software, gestión de archivos y terminal.
Corres en Termux (Android/Linux). Modelo activo: ${model} (${provider}).

🛠️ HERRAMIENTAS DISPONIBLES:
- create_file   → Crea o sobreescribe archivos con contenido completo.
- read_file     → Lee el contenido de un archivo con números de línea.
- list_directory → Lista archivos y carpetas (puede ser recursivo, omite node_modules/.git).
- run_shell     → Ejecuta cualquier comando en la terminal (npm, git, python, bash, etc.).
- web_search    → Busca en internet (Tavily AI) — resultados reales y actualizados.

📋 REGLAS DE COMPORTAMIENTO:
- Antes de usar una herramienta, explica brevemente qué vas a hacer.
- Si algo falla, analiza el error y propón alternativas concretas.
- Al terminar una tarea, haz un resumen breve de lo que hiciste.
- Para preguntas sobre tecnología, versiones o noticias recientes → usa web_search.
- Para crear proyectos: usa create_file para los archivos + run_shell para instalar/ejecutar.
- Responde SIEMPRE en el idioma que use el usuario.
- Sé preciso y conciso. Evita repeticiones innecesarias.
- Si el usuario pide ver un archivo largo, muestra solo las partes relevantes.

🎯 ESPECIALIDADES:
- Node.js, npm, LangChain/LangGraph, React, Python
- Desarrollo en Termux/Android (rutas como /data/data/com.termux/...)
- Scripts de automatización, bash, git
- Depuración y resolución de errores`
    );
}

// ─── ReAct System Prompt (para modelos sin soporte de tools) ──────────────────
function buildReActSystemPrompt(provider, model) {
    const toolDescriptions = tools.map(t => {
        const params = Object.entries(t.schema.shape).map(([k, v]) => {
            const desc = v._def?.description || v.description || '';
            return `    - ${k}: ${desc}`;
        }).join('\n');
        return `  ${t.name}: ${t.description}\n    Parámetros:\n${params}`;
    }).join('\n\n');

    return new SystemMessage(
        `Eres AgentLag, un asistente experto en desarrollo de software, gestión de archivos y terminal.
Corres en Termux (Android/Linux). Modelo activo: ${model} (${provider}).

🛠️ HERRAMIENTAS DISPONIBLES:
${toolDescriptions}

📋 CÓMO USAR HERRAMIENTAS:
Cuando necesites usar una herramienta, responde EXACTAMENTE con este formato:

Thought: [tu razonamiento sobre qué hacer]
Action: [nombre_de_herramienta]
Action Input: {"param1": "valor1", "param2": "valor2"}

Después de recibir el resultado (Observation), continúa razonando.
Cuando tengas la respuesta final y NO necesites más herramientas, responde normalmente SIN usar el formato Action/Action Input.

📋 REGLAS DE COMPORTAMIENTO:
- Antes de usar una herramienta, explica brevemente qué vas a hacer en Thought.
- Si algo falla, analiza el error y propón alternativas concretas.
- Al terminar una tarea, haz un resumen breve de lo que hiciste.
- Responde SIEMPRE en el idioma que use el usuario.
- Sé preciso y conciso. Evita repeticiones innecesarias.
- IMPORTANTE: El JSON de Action Input debe ser válido y estar en una sola línea.

🎯 ESPECIALIDADES:
- Node.js, npm, LangChain/LangGraph, React, Python
- Desarrollo en Termux/Android
- Scripts de automatización, bash, git
- Depuración y resolución de errores`
    );
}

// ─── Limpiar respuesta ReAct para el usuario ─────────────────────────────────
function cleanReActResponse(text) {
    if (!text || typeof text !== 'string') return text;
    let cleaned = text
        // Limpiar Thought con o sin markdown
        .replace(/^\*{0,2}Thought:?\*{0,2}\s*/im, '')
        .replace(/\n\*{0,2}Thought:?\*{0,2}\s*/gm, '\n')
        // Eliminar Action/Action Input/Observation residuales
        .replace(/\n\*{0,2}Action:?\*{0,2}[\s\S]*$/i, '')
        .replace(/\*{0,2}Observation:?\*{0,2}[\s\S]*$/im, '')
        .trim();
    // Limpiar markdown básico para terminal
    cleaned = stripMarkdown(cleaned);
    return cleaned || text;
}

// ─── Limpiar markdown para terminal ───────────────────────────────────────────
export function stripMarkdown(text) {
    if (!text) return text;
    return text
        .replace(/\*\*(.+?)\*\*/g, '$1')       // **bold** → bold
        .replace(/\*(.+?)\*/g, '$1')            // *italic* → italic
        .replace(/^\s*\*\s{3}/gm, '  • ')       // *   item → • item
        .replace(/^\s*\*\s/gm, '• ')            // * item → • item
        .replace(/^#{1,6}\s+/gm, '')            // # heading → heading
        .replace(/`([^`]+)`/g, '$1');            // `code` → code
}

// ─── Parsear tool call desde texto ReAct ──────────────────────────────────────
function parseToolCall(text) {
    if (!text || typeof text !== 'string') return null;

    // Soportar Action con o sin markdown: Action:, **Action:**, **Action:**
    const actionMatch = text.match(/\*{0,2}Action:?\*{0,2}\s*(\S+)/);
    if (!actionMatch) return null;

    const name = actionMatch[1].replace(/\*+/g, '').trim();
    const validNames = tools.map(t => t.name);
    if (!validNames.includes(name)) return null;

    // Soportar Action Input con o sin markdown
    const inputMatch = text.match(/\*{0,2}Action Input:?\*{0,2}\s*(\{[\s\S]*?\})/);
    if (!inputMatch) return null;

    try {
        const args = JSON.parse(inputMatch[1].trim());
        return { name, args, id: `react_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` };
    } catch {
        return null;
    }
}

// ─── buildAgent ───────────────────────────────────────────────────────────────
/**
 * Construye el agente.
 * @param {object} [overrides] - { provider, model, apiKey, baseUrl, forceReAct }
 */
export async function buildAgent(overrides = {}) {
    const cfg = loadConfig();

    const provider = overrides.provider || cfg.provider || "groq";
    const model    = overrides.model    || cfg.model    || "qwen/qwen3-32b";
    const apiKey   = overrides.apiKey   || cfg.apiKey   || null;
    const baseUrl  = overrides.baseUrl  || cfg.baseUrl  || null;
    const forceReAct = overrides.forceReAct || false;

    if (!provider) throw new Error("No hay proveedor configurado. Ejecuta AgentLag para configurarlo.");
    if (!model)    throw new Error("No hay modelo configurado. Ejecuta AgentLag para configurarlo.");

    if (provider !== "ollama" && provider !== "huggingface" && !apiKey) {
        const envVars = {
            groq: "GROQ_API_KEY", openai: "OPENAI_API_KEY",
            anthropic: "ANTHROPIC_API_KEY", openrouter: "OPENROUTER_API_KEY",
            deepseek: "DEEPSEEK_API_KEY", mistral: "MISTRAL_API_KEY",
            nvidia: "NVIDIA_API_KEY", meta: "TOGETHER_API_KEY",
        };
        const envKey = process.env[envVars[provider]];
        if (!envKey) {
            throw new Error(
                `No hay API key para "${provider}".\n` +
                `Configúrala en ~/.agentlag/config.json o en .env como ${envVars[provider]}`
            );
        }
    }

    const llm = await createLLM(provider, model, apiKey, baseUrl);

    if (forceReAct) {
        return buildReActGraph(llm, provider, model);
    }

    // Intentar flujo normal con tools nativas
    const llmWithTools = llm.bindTools(tools);
    const systemPrompt = buildSystemPrompt(provider, model);

    const callModel = async (state) => {
        const messages  = [systemPrompt, ...state.messages];
        const response  = await llmWithTools.invoke(messages);
        return { messages: [response] };
    };

    const toolNode = new ToolNode(tools);

    const workflow = new StateGraph(AgentState)
        .addNode("agent", callModel)
        .addNode("tools", toolNode)
        .addEdge(START, "agent")
        .addConditionalEdges("agent", toolsCondition)
        .addEdge("tools", "agent");

    const compiled = workflow.compile();
    compiled._agentMode = 'tools';
    return compiled;
}

// ─── ReAct Graph (para modelos sin soporte de tools) ──────────────────────────
function buildReActGraph(llm, provider, model) {
    const reactPrompt = buildReActSystemPrompt(provider, model);

    const toolMap = {};
    for (const t of tools) {
        toolMap[t.name] = t;
    }

    const callModelReAct = async (state) => {
        // Convertir ToolMessages a observaciones legibles por el modelo
        const processedMessages = state.messages.map(m => {
            if (m instanceof ToolMessage) {
                return new HumanMessage(`Observation: ${m.content}`);
            }
            return m;
        });

        const messages = [reactPrompt, ...processedMessages];
        const response = await llm.invoke(messages);

        const toolCall = parseToolCall(response.content);
        if (toolCall) {
            const aiMsg = new AIMessage({
                content: response.content,
                tool_calls: [{
                    name: toolCall.name,
                    args: toolCall.args,
                    id: toolCall.id,
                }],
            });
            return { messages: [aiMsg] };
        }

        // Respuesta final — limpiar formato ReAct
        const cleaned = cleanReActResponse(response.content);
        return { messages: [new AIMessage({ content: cleaned })] };
    };

    const toolNode = new ToolNode(tools);

    const workflow = new StateGraph(AgentState)
        .addNode("agent", callModelReAct)
        .addNode("tools", toolNode)
        .addEdge(START, "agent")
        .addConditionalEdges("agent", toolsCondition)
        .addEdge("tools", "agent");

    const compiled = workflow.compile();
    compiled._agentMode = 'react';
    return compiled;
}
