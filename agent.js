import { createWrappedToolNode } from './agent_ext.js';
import { optimizeToolOutput } from './optimizer.js';
import { RecordingSession } from './recording_logger.js';
import { StateGraph, START, Annotation } from "@langchain/langgraph";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";
import { SystemMessage, HumanMessage, AIMessage, ToolMessage } from "@langchain/core/messages";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import os from "os";
import { buildSkillContextForMessage, formatSkillsIndex } from "./skills.js";
import { loadMcpTools } from "./mcp_utils.js";
import { listMemory } from './memory_utils.js';


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
    reactIterations: Annotation({
        reducer: (_x, y) => y,
        default: () => 0,
    }),
    reactErrors: Annotation({
        reducer: (_x, y) => y,
        default: () => ({}),
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
                maxTokens: 8192,
            });
        }
        case "openai": {
            const { ChatOpenAI } = await import("@langchain/openai");
            return new ChatOpenAI({
                model,
                apiKey: apiKey || process.env.OPENAI_API_KEY,
                temperature: 0.4,
                maxTokens: 8192,
            });
        }
        case "anthropic": {
            const { ChatAnthropic } = await import("@langchain/anthropic");
            return new ChatAnthropic({
                model,
                apiKey: apiKey || process.env.ANTHROPIC_API_KEY,
                maxTokens: 8192,
            });
        }
        case "openrouter": {
            const { ChatOpenAI } = await import("@langchain/openai");
            return new ChatOpenAI({
                model,
                apiKey: apiKey || process.env.OPENROUTER_API_KEY,
                configuration: {
                    baseURL: "https://openrouter.ai/api/v1",
                    defaultHeaders: {
                        "HTTP-Referer": "https://github.com/andreslpxz/AgentLag_npm",
                        "X-Title": "AgentLag",
                    },
                },
                temperature: 0.4,
                maxTokens: 8192,
                // Pide a OpenRouter rutar solo a providers que soporten function-calling.
                modelKwargs: {
                    provider: { require_parameters: true },
                },
            });
        }
        case "lightning": {
            const { ChatOpenAI } = await import("@langchain/openai");
            return new ChatOpenAI({
                model,
                apiKey: apiKey || process.env.LIGHTNING_API_KEY,
                configuration: { baseURL: baseUrl || "https://lightning.ai/api/v1" },
                temperature: 0.4,
                maxTokens: 8192,
            });
        }
        case "deepseek": {
            const { ChatOpenAI } = await import("@langchain/openai");
            return new ChatOpenAI({
                model,
                apiKey: apiKey || process.env.DEEPSEEK_API_KEY,
                configuration: { baseURL: "https://api.deepseek.com/v1" },
                temperature: 0.4,
                maxTokens: 8192,
            });
        }
        case "mistral": {
            const { ChatMistralAI } = await import("@langchain/mistralai");
            return new ChatMistralAI({
                model,
                apiKey: apiKey || process.env.MISTRAL_API_KEY,
                temperature: 0.4,
                maxTokens: 8192,
            });
        }
        case "nvidia": {
            const { ChatOpenAI } = await import("@langchain/openai");
            return new ChatOpenAI({
                model,
                apiKey: apiKey || process.env.NVIDIA_API_KEY,
                configuration: { baseURL: "https://integrate.api.nvidia.com/v1" },
                temperature: 0.4,
                maxTokens: 8192,
            });
        }
        case "huggingface": {
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
            const { ChatOpenAI } = await import("@langchain/openai");
            return new ChatOpenAI({
                model,
                apiKey: apiKey || process.env.TOGETHER_API_KEY || process.env.META_API_KEY,
                configuration: { baseURL: "https://api.together.xyz/v1" },
                temperature: 0.4,
                maxTokens: 8192,
            });
        }
        default:
            throw new Error(`Proveedor no soportado: "${provider}". Revisa ~/.agentlag/config.json`);
    }
}

// ─── System prompt ────────────────────────────────────────────────────────────
function toolSummary() {
    return tools.map(t => `- ${t.name.padEnd(14)} → ${t.description}`).join("\n");
}

function messageText(message) {
    const content = message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .map(part => typeof part === "string" ? part : part?.text || "")
            .join("\n");
    }
    return "";
}

function latestUserText(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message instanceof HumanMessage) return messageText(message);
    }
    return "";
}

function buildSystemPrompt(provider, model) {
    return new SystemMessage(
        `Eres AgentLag, una herramienta CLI interactiva para tareas de ingeniería de software.
Modelo activo: ${model} (${provider}). Plataforma: ${process.platform}. Directorio actual: ${process.cwd()}.

🛠️ HERRAMIENTAS DISPONIBLES:
${toolSummary()}

🧠 MEMORIA Y PREFERENCIAS:
${listMemory()}

REGLAS PARA MEMORIA:
- Consulta SIEMPRE la memoria antes de proponer soluciones para respetar preferencias del usuario.
- Usa manage_memory para guardar (save) información importante, decisiones de arquitectura o preferencias que detectes.
- Si el usuario menciona un dato que deba persistir, guárdalo automáticamente sin preguntar.

🧩 SKILLS INSTALADAS:
${formatSkillsIndex(process.cwd())}

REGLAS PARA SKILLS:
- Sé PROACTIVO: si una tarea coincide con una skill instalada, léela con read_skill y aplica sus instrucciones de inmediato.
- Para descubrir nuevas capacidades, usa find_skills ante peticiones como "necesito algo para X" o "busca una skill".

🚀 AUTONOMÍA Y FLUJO:
- Eres un agente AUTÓNOMO. Si una tarea requiere varios pasos (ej: crear un archivo y luego ejecutarlo), ejecuta la secuencia completa sin esperar confirmación entre pasos, a menos que sea una acción destructiva o crítica.
- Si el usuario es vago (ej: "un script de test"), toma decisiones razonables basadas en el contexto del proyecto y ejecútalo.

📋 REGLAS DE COMPORTAMIENTO:
- Responde SIEMPRE en el idioma que use el usuario.
- Sé directo y conciso: normalmente 1-3 frases, sin preámbulos innecesarios.
- Sigue convenciones del proyecto: lee archivos cercanos antes de editar.
- No añadas comentarios en el código salvo que el usuario los pida.
- Nunca expongas secretos o API keys.
- Si algo falla, explica el error y propone la alternativa más concreta.
- Al terminar una tarea, resume solo el resultado esencial.

🎯 ESPECIALIDADES:
- Desarrollo Full-Stack de IA (Node.js, Python, React y Arquitecturas LangGraph)
- Despliegue Multiplataforma Ecosistémico (Android/Termux, Linux y Windows)
- Automatización Avanzada de Procesos (RPA, Scripts Multi-entorno y Control de Versiones)
- Resiliencia del Sistema (Autodepuración en Caliente y Resolución Autónoma de Errores)`
    );
}

// ─── ReAct System Prompt (para modelos sin soporte de tools) ──────────────────
function buildReActSystemPrompt(provider, model) {
    const toolDescriptions = tools.map(t => `  ${t.name}: ${t.description}`).join("\n");

    return new SystemMessage(
        `Eres AgentLag, una herramienta CLI interactiva para tareas de ingeniería de software.
Modelo activo: ${model} (${provider}). Plataforma: ${process.platform}. Directorio actual: ${process.cwd()}.

🛠️ HERRAMIENTAS DISPONIBLES:
${toolDescriptions}

🧠 MEMORIA Y PREFERENCIAS:
${listMemory()}

REGLAS PARA MEMORIA:
- Consulta la memoria para adaptar tus respuestas a las preferencias del usuario.
- Usa manage_memory para persistir datos relevantes (save) o listar (list).

🧩 SKILLS INSTALADAS:
${formatSkillsIndex(process.cwd())}

REGLAS PARA SKILLS:
- Aplica PROACTIVAMENTE las skills instaladas usando read_skill si el contexto lo requiere.

🚀 AUTONOMÍA Y FLUJO:
- Ejecuta secuencias de pasos completas. Si el usuario pide "crea un script y ejecútalo", usa create_file y luego run_shell en pasos sucesivos sin detenerte.
- Toma iniciativa: si falta información no crítica, elige la opción más estándar para el entorno actual.

📋 CÓMO USAR HERRAMIENTAS:
Cuando necesites usar una herramienta, responde EXACTAMENTE con este formato:

Thought: [tu razonamiento sobre qué hacer]
Action: [nombre_de_herramienta]
Action Input: {"param1": "valor1", "param2": "valor2"}

⚠️ REGLAS CRÍTICAS:
- NUNCA repitas la misma acción si ya falló.
- Máximo 15 pasos. El JSON de Action Input debe ser válido y en una sola línea.

📋 REGLAS DE COMPORTAMIENTO:
- Responde en el idioma del usuario, sé conciso y evita preámbulos.
- Sigue las convenciones del código existente.

🎯 ESPECIALIDADES:
- Node.js, Termux, Python, Scripts, Git.`
    );
}

// ─── Limpiar respuesta ReAct para el usuario ─────────────────────────────────
function cleanReActResponse(text) {
    if (!text || typeof text !== 'string') return text;
    let cleaned = text
        .replace(/^\*{0,2}Thought:?\*{0,2}\s*/im, '')
        .replace(/\n\*{0,2}Thought:?\*{0,2}\s*/gm, '\n')
        .replace(/\n\*{0,2}Action:?\*{0,2}[\s\S]*$/i, '')
        .replace(/\*{0,2}Observation:?\*{0,2}[\s\S]*$/im, '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/^<think>[\s\S]*?(?=\n{2,}|Encontr|Puedo|¿|$)/i, '')
        .trim();
    cleaned = stripMarkdown(cleaned);
    return cleaned || text;
}

// ─── Limpiar markdown para terminal ───────────────────────────────────────────
export function stripMarkdown(text) {
    if (!text) return text;
    return text
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/\*(.+?)\*/g, '$1')
        .replace(/^\s*\*\s{3}/gm, '  • ')
        .replace(/^\s*\*\s/gm, '• ')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/`([^`]+)`/g, '$1');
}

// ─── Parsear tool call desde texto ReAct ──────────────────────────────────────
function parseToolCall(text, availableTools) {
    if (!text || typeof text !== "string") return null;

    const actionMatch = text.match(/\*{0,2}Action:?\*{0,2}\s*(\S+)/);
    if (actionMatch) {
        const name = actionMatch[1].replace(/\*+/g, "").trim();
        const validNames = availableTools.map(t => t.name);
        if (validNames.includes(name)) {
            const inputMatch = text.match(/\*{0,2}Action Input:?\*{0,2}\s*(\{[\s\S]*?\})/);
            if (inputMatch) {
                try {
                    const args = JSON.parse(inputMatch[1].trim());
                    return { name, args, id: `react_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` };
                } catch {}
            }
        }
    }

    try {
        const start = text.indexOf("{");
        const end = text.lastIndexOf("}");
        if (start !== -1 && end !== -1 && end > start) {
            const jsonStr = text.slice(start, end + 1);
            const parsed = JSON.parse(jsonStr);
            if (parsed.name && parsed.args && availableTools.some(t => t.name === parsed.name)) {
                return { name: parsed.name, args: parsed.args, id: `react_${Date.now()}` };
            }
            const toolName = parsed.tool || parsed.action || parsed.call;
            const toolArgs = parsed.parameters || parsed.args || parsed.input || parsed;
            if (toolName && availableTools.some(t => t.name === toolName)) {
                return { name: toolName, args: typeof toolArgs === "object" ? toolArgs : {}, id: `react_${Date.now()}` };
            }
            if (Object.keys(parsed).length > 0 && !parsed.name) {
                if (parsed.query && !parsed.command) return { name: "find_skills", args: parsed, id: `react_${Date.now()}` };
                if (parsed.command) return { name: "run_shell", args: parsed, id: `react_${Date.now()}` };
                if (parsed.oldText && (parsed.newText || parsed.new_text)) return { name: "edit_file", args: parsed, id: `react_${Date.now()}` };
                if ((parsed.filePath || parsed.path) && parsed.content) return { name: "create_file", args: parsed, id: `react_${Date.now()}` };
                if (parsed.filePath || parsed.path) return { name: "read_file", args: parsed, id: `react_${Date.now()}` };
            }
        }
    } catch {}

    return null;
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
            lightning: "LIGHTNING_API_KEY",
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

    // Cargar herramientas MCP dinámicamente
    const mcpTools = await loadMcpTools();
    let allTools = [...tools, ...mcpTools];

    // Aplicar filtro de herramientas si se solicita
    if (overrides.allowedTools) {
        allTools = allTools.filter(t => overrides.allowedTools.includes(t.name));
    } else if (overrides.excludedTools) {
        allTools = allTools.filter(t => !overrides.excludedTools.includes(t.name));
    }

    const llm = await createLLM(provider, model, apiKey, baseUrl);

    if (forceReAct) {
        return buildReActGraph(llm, provider, model, allTools, overrides.session);
    }

    // Intentar flujo normal con tools nativas
    const llmWithTools = llm.bindTools(allTools);
    const systemPrompt = buildSystemPrompt(provider, model);

    const callModel = async (state) => {
        const skillContext = buildSkillContextForMessage(latestUserText(state.messages), process.cwd());
        const messages  = skillContext
            ? [systemPrompt, new SystemMessage(skillContext), ...state.messages]
            : [systemPrompt, ...state.messages];
        const response  = await llmWithTools.invoke(messages);
        return { messages: [response] };
    };

    const toolNode = createWrappedToolNode(allTools, overrides.session);

    const workflow = new StateGraph(AgentState)
        .addNode("agent", callModel)
        .addNode("tools", toolNode)
        .addEdge(START, "agent")
        .addConditionalEdges("agent", toolsCondition)
        .addEdge("tools", "agent");

    const compiled = workflow.compile();
    compiled._agentMode = 'tools';
    compiled.llm = llm;
    return compiled;
}


// ─── ReAct Graph (para modelos sin soporte de tools) ──────────────────────────
const MAX_REACT_ITERATIONS = 15;

function buildReActGraph(llm, provider, model, allTools, session) {
    const reactPrompt = buildReActSystemPrompt(provider, model);

    const toolMap = {};
    for (const t of allTools) {
        toolMap[t.name] = t;
    }

    const callModelReAct = async (state) => {
        const iterationCount = (state.reactIterations || 0) + 1;
        const errorTracker = state.reactErrors || {};

        if (iterationCount > MAX_REACT_ITERATIONS) {
            return {
                messages: [new AIMessage({
                    content: "He alcanzado el límite de pasos. Aquí está lo que logré hacer hasta ahora. ¿Necesitas que continúe con algo específico?"
                })],
                reactIterations: 0,
                reactErrors: {},
            };
        }

        const processedMessages = state.messages.map(m => {
            if (m instanceof ToolMessage) {
                return new HumanMessage(`Observation: ${m.content}`);
            }
            return m;
        });

        const repeatedErrors = Object.entries(errorTracker)
            .filter(([, count]) => count >= 2)
            .map(([key]) => key);
        if (repeatedErrors.length > 0) {
            processedMessages.push(new HumanMessage(
                `ADVERTENCIA: Las siguientes herramientas han fallado múltiples veces: ${repeatedErrors.join(', ')}. NO las vuelvas a usar de la misma forma. Cambia de estrategia o da tu respuesta final SIN usar herramientas.`
            ));
        }

        const skillContext = buildSkillContextForMessage(latestUserText(processedMessages), process.cwd());
        const messages = skillContext
            ? [reactPrompt, new SystemMessage(skillContext), ...processedMessages]
            : [reactPrompt, ...processedMessages];
        const response = await llm.invoke(messages);

        const toolCall = parseToolCall(response.content, allTools);
        if (toolCall) {
            const aiMsg = new AIMessage({
                content: response.content,
                tool_calls: [{
                    name: toolCall.name,
                    args: toolCall.args,
                    id: toolCall.id,
                }],
            });
            return { messages: [aiMsg], reactIterations: iterationCount };
        }

        const cleaned = cleanReActResponse(response.content);
        return {
            messages: [new AIMessage({ content: cleaned })],
            reactIterations: 0,
            reactErrors: {},
        };
    };

    const originalToolNode = createWrappedToolNode(allTools, session);
    const trackedToolNode = async (state) => {
        const result = await originalToolNode.invoke(state);
        const nextErrors = { ...(state.reactErrors || {}) };
        const msgs = result.messages || [];
        for (const m of msgs) {
            if (m instanceof ToolMessage && m.content && typeof m.content === 'string') {
                if (m.content.includes('❌') || m.content.includes('Error')) {
                    const toolCallId = m.tool_call_id;
                    const lastAiMsg = state.messages.findLast(msg => msg.tool_calls?.length > 0);
                    if (lastAiMsg) {
                        const call = lastAiMsg.tool_calls.find(tc => tc.id === toolCallId);
                        if (call) {
                            const callKey = `${call.name}`;
                            nextErrors[callKey] = (nextErrors[callKey] || 0) + 1;
                        }
                    }
                }
            }
        }
        return { ...result, reactErrors: nextErrors };
    };

    const workflow = new StateGraph(AgentState)
        .addNode("agent", callModelReAct)
        .addNode("tools", trackedToolNode)
        .addEdge(START, "agent")
        .addConditionalEdges("agent", toolsCondition)
        .addEdge("tools", "agent");

    const compiled = workflow.compile();
    compiled._agentMode = 'react';
    compiled.llm = llm;
    return compiled;
}

export function trySalvageToolCall(message) {
    if (!message || typeof message.content !== 'string') return null;
    const call = parseToolCall(message.content, tools);
    if (call) {
        return {
            ...message,
            tool_calls: [call]
        };
    }
    return null;
}
