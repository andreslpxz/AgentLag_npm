import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { getModelInfo } from "./model_info.js";
import { getEffortConfig, validateEffortLevel } from "./effort_models.js";
import { createWrappedToolNode } from './agent_ext.js';
import { optimizeToolOutput } from './optimizer.js';
import { RecordingSession } from './recording_logger.js';
import { buildOrchestratorAgent } from './orchestrator.js';
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
import { AGENTS_DIR } from "./session.js";
import { getActivePlugins, formatPluginListForPrompt } from './plugin_engine.js';


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
async function createLLM(provider, model, apiKey, baseUrl, effortLevel, { toolsEnabled = true } = {}) {
    const info = getModelInfo(model);
    const commonOpts = {
        temperature: 0.4,
        maxTokens: info.outTokens || 8192
    };

    // ─── Look up effort config for this (model, provider) pair ───────────────
    // If effort is supported and a level was requested, we'll apply it after
    // constructing the base LLM via effortConfig.applyTo(llm, level).
    const effortConfig = effortLevel ? getEffortConfig(model, provider) : null;
    let resolvedEffortLevel = null;
    if (effortConfig && effortConfig.param && !effortConfig.fixed) {
        const validation = validateEffortLevel(model, provider, effortLevel);
        if (validation.ok) {
            resolvedEffortLevel = validation.normalized;
        } else {
            console.warn(`[Effort] ${validation.error} Falling back to default.`);
            resolvedEffortLevel = effortConfig.default;
        }
    }

    let llm;

    switch (provider) {
        case "google": {
            const googleOpts = { ...commonOpts };
            if (googleOpts.maxTokens) {
                googleOpts.maxOutputTokens = googleOpts.maxTokens;
                delete googleOpts.maxTokens;
            }
            llm = new ChatGoogleGenerativeAI({
                model: model,
                apiKey: apiKey || process.env.GOOGLE_GENAI_API_KEY,
                ...googleOpts
            });
            break;
        }
        case "cohere": {
            // IMPORTANT: @langchain/cohere v1.x calls Cohere's deprecated /v1/chat
            // endpoint, which Cohere now rejects for all modern Command models with
            //   BadRequestError 400: "this model is not supported with '/v1/chat',
            //   please use '/v2/chat' instead"
            // We use ChatOpenAI pointed at Cohere's OpenAI-compatible gateway:
            //   https://api.cohere.ai/compatibility/v1
            // which routes every model through /v2/chat internally and accepts
            // standard OpenAI-shaped requests (incl. tools/function-calling).
            const cohereBaseURL = baseUrl || "https://api.cohere.ai/compatibility/v1";
            const { ChatOpenAI: CohereOpenAI } = await import("@langchain/openai");
            llm = new CohereOpenAI({
                model,
                apiKey: apiKey || process.env.COHERE_API_KEY,
                configuration: { baseURL: cohereBaseURL },
                temperature: 0.4,
                maxTokens: info.outTokens || 8192,
            });
            break;
        }
        case "azure": {
            // Azure OpenAI — uses AzureOpenAI from @langchain/openai.
            // Required env:
            //   AZURE_OPENAI_API_KEY              - the API key
            //   AZURE_OPENAI_API_INSTANCE_NAME    - e.g. "my-resource"
            //   AZURE_OPENAI_API_DEPLOYMENT_NAME  - e.g. "gpt-4o-deployment"
            //   AZURE_OPENAI_API_VERSION          - e.g. "2024-08-01-preview" (optional)
            // The `model` parameter here is actually the deployment name.
            const { AzureOpenAI } = await import("@langchain/openai");
            const deploymentName = model || process.env.AZURE_OPENAI_API_DEPLOYMENT_NAME;
            const instanceName = process.env.AZURE_OPENAI_API_INSTANCE_NAME;
            const apiVersion = process.env.AZURE_OPENAI_API_VERSION || "2024-08-01-preview";
            if (!deploymentName) {
                throw new Error(
                    "Azure OpenAI requires a deployment name. Set AZURE_OPENAI_API_DEPLOYMENT_NAME " +
                    "in .env or pass it as the model name."
                );
            }
            if (!instanceName) {
                throw new Error(
                    "Azure OpenAI requires AZURE_OPENAI_API_INSTANCE_NAME in .env " +
                    "(e.g. 'my-resource' from https://my-resource.openai.azure.com)."
                );
            }
            llm = new AzureOpenAI({
                azureOpenAIApiDeploymentName: deploymentName,
                azureOpenAIApiInstanceName:   instanceName,
                azureOpenAIApiKey:            apiKey || process.env.AZURE_OPENAI_API_KEY,
                azureOpenAIApiVersion:        apiVersion,
                temperature: 0.4,
                maxTokens: info.outTokens || 8192,
            });
            break;
        }
        case "vertexai": {
            // Google Vertex AI — uses @langchain/google-vertexai's ChatVertexAI.
            // Auth: picks up Google Cloud default credentials (Application Default
            // Credentials). Run `gcloud auth application-default login` first, or
            // set GOOGLE_APPLICATION_CREDENTIALS to a service account JSON path.
            // Optional env:
            //   GOOGLE_CLOUD_PROJECT   - the GCP project ID
            //   GOOGLE_CLOUD_LOCATION  - e.g. "us-central1" (default)
            const { ChatVertexAI } = await import("@langchain/google-vertexai");
            const project  = process.env.GOOGLE_CLOUD_PROJECT || process.env.VERTEX_PROJECT;
            const location = process.env.GOOGLE_CLOUD_LOCATION || process.env.VERTEX_LOCATION || "us-central1";
            const vertexOpts = {
                model,
                location,
                temperature: 0.4,
                maxOutputTokens: info.outTokens || 8192,
            };
            if (project) vertexOpts.project = project;
            llm = new ChatVertexAI(vertexOpts);
            break;
        }
        case "bedrock": {
            // Amazon Bedrock — uses @langchain/aws ChatBedrockConverse.
            // Auth: picks up AWS default credential chain (env vars, ~/.aws/credentials,
            // IAM role, etc.). Set AWS_REGION or AWS_DEFAULT_REGION.
            const { ChatBedrockConverse } = await import("@langchain/aws");
            const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
            const bedrockOpts = {
                model,
                region,
                temperature: 0.4,
                maxTokens: info.outTokens || 8192,
            };
            // Only pass explicit credentials if provided — otherwise let the SDK
            // use its default credential chain (recommended for IAM roles).
            if (apiKey || process.env.AWS_ACCESS_KEY_ID) {
                bedrockOpts.credentials = {
                    accessKeyId:     apiKey || process.env.AWS_ACCESS_KEY_ID,
                    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
                    sessionToken:    process.env.AWS_SESSION_TOKEN,
                };
            }
            llm = new ChatBedrockConverse(bedrockOpts);
            break;
        }
        case "grok":
        case "together":
        case "cerebras":
        case "qwen":
        case "glm":
        case "perplexity": {
            const baseUrlMap = {
                grok: "https://api.x.ai/v1",
                together: "https://api.together.xyz/v1",
                cerebras: "https://api.cerebras.ai/v1",
                qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1",
                glm: "https://open.bigmodel.cn/api/paas/v4",
                perplexity: "https://api.perplexity.ai"
            };
            const envVars = {
                grok: "GROK_API_KEY",
                together: "TOGETHER_API_KEY",
                cerebras: "CEREBRAS_API_KEY",
                qwen: "QWEN_API_KEY",
                glm: "GLM_API_KEY",
                perplexity: "PERPLEXITY_API_KEY"
            };
            llm = new ChatOpenAI({
                model,
                apiKey: apiKey || process.env[envVars[provider]],
                configuration: { baseURL: baseUrl || baseUrlMap[provider] },
                ...commonOpts
            });
            break;
        }
        case "groq": {
            const { ChatGroq } = await import("@langchain/groq");
            llm = new ChatGroq({
                model,
                apiKey: apiKey || process.env.GROQ_API_KEY,
                temperature: 0.4,
                maxTokens: 8192,
            });
            break;
        }
        case "openai": {
            const { ChatOpenAI } = await import("@langchain/openai");
            llm = new ChatOpenAI({
                model,
                apiKey: apiKey || process.env.OPENAI_API_KEY,
                temperature: 0.4,
                maxTokens: 8192,
            });
            break;
        }
        case "anthropic": {
            const { ChatAnthropic } = await import("@langchain/anthropic");
            llm = new ChatAnthropic({
                model,
                apiKey: apiKey || process.env.ANTHROPIC_API_KEY,
                maxTokens: 8192,
            });
            break;
        }
        case "openrouter": {
            const { ChatOpenAI } = await import("@langchain/openai");
            const openRouterOpts = {
                model,
                apiKey: apiKey || process.env.OPENROUTER_API_KEY,
                configuration: {
                    baseURL: baseUrl || "https://openrouter.ai/api/v1",
                    defaultHeaders: {
                        "HTTP-Referer": "https://github.com/andreslpxz/AgentLag_npm",
                        "X-Title": "AgentLag",
                    },
                },
                temperature: 0.4,
                maxTokens: 8192,
            };
            // Solo pedir providers con function-calling cuando tools están habilitadas.
            // En modo ReAct/Orchestrator esto causaría 404 para modelos que no soportan tools.
            if (toolsEnabled) {
                openRouterOpts.modelKwargs = {
                    provider: { require_parameters: true },
                };
            }
            llm = new ChatOpenAI(openRouterOpts);
            break;
        }
        case "lightning": {
            const { ChatOpenAI } = await import("@langchain/openai");
            llm = new ChatOpenAI({
                model,
                apiKey: apiKey || process.env.LIGHTNING_API_KEY,
                configuration: { baseURL: baseUrl || "https://lightning.ai/api/v1" },
                temperature: 0.4,
                maxTokens: 8192,
            });
            break;
        }
        case "deepseek": {
            const { ChatOpenAI } = await import("@langchain/openai");
            llm = new ChatOpenAI({
                model,
                apiKey: apiKey || process.env.DEEPSEEK_API_KEY,
                configuration: { baseURL: baseUrl || "https://api.deepseek.com/v1" },
                temperature: 0.4,
                maxTokens: 8192,
            });
            break;
        }
        case "mistral": {
            const { ChatMistralAI } = await import("@langchain/mistralai");
            llm = new ChatMistralAI({
                model,
                apiKey: apiKey || process.env.MISTRAL_API_KEY,
                temperature: 0.4,
                maxTokens: 8192,
            });
            break;
        }
        case "nvidia": {
            const { ChatOpenAI } = await import("@langchain/openai");
            llm = new ChatOpenAI({
                model,
                apiKey: apiKey || process.env.NVIDIA_API_KEY,
                configuration: { baseURL: baseUrl || "https://integrate.api.nvidia.com/v1" },
                temperature: 0.4,
                maxTokens: 8192,
            });
            break;
        }
        case "huggingface":
        case "ollama": {
            const { ChatOllama } = await import("@langchain/ollama");
            llm = new ChatOllama({
                model,
                baseUrl: baseUrl || process.env.OLLAMA_BASE_URL || "http://localhost:11434",
                temperature: 0.4,
            });
            break;
        }
        case "meta": {
            const { ChatOpenAI } = await import("@langchain/openai");
            llm = new ChatOpenAI({
                model,
                apiKey: apiKey || process.env.TOGETHER_API_KEY || process.env.META_API_KEY,
                configuration: { baseURL: "https://api.together.xyz/v1" },
                temperature: 0.4,
                maxTokens: 8192,
            });
            break;
        }
        default:
            throw new Error(`Proveedor no soportado: "${provider}". Revisa ~/.agentlag/config.json`);
    }

    // ─── Apply effort config (if supported and requested) ────────────────────
    if (effortConfig && effortConfig.applyTo && resolvedEffortLevel) {
        try {
            llm = effortConfig.applyTo(llm, resolvedEffortLevel);
        } catch (err) {
            console.warn(`[Effort] Could not apply effort level "${resolvedEffortLevel}" to ${model}: ${err.message}`);
        }
    }

    return llm;
}

// ─── System prompt ────────────────────────────────────────────────────────────
function toolSummary(allTools) {
    const list = allTools || tools;
    return list.map(t => `- ${t.name.padEnd(14)} → ${t.description}`).join("\n");
}

export function messageText(message) {
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

function buildSystemPrompt(provider, model, allTools = null) {
    const isGroq = provider === 'groq';
    const toolInfo = (isGroq && allTools)
        ? "Usa las herramientas disponibles según sea necesario para completar la tarea."
        : toolSummary(allTools);

    return new SystemMessage(
        `Eres AgentLag, una herramienta CLI interactiva para tareas de ingeniería de software.
Modelo activo: ${model} (${provider}). Plataforma: ${process.platform}. Directorio actual: ${process.cwd()}.

🛠️ HERRAMIENTAS DISPONIBLES:
${toolInfo}

🧠 MEMORIA Y PREFERENCIAS:
${listMemory()}

REGLAS PARA MEMORIA:
- Consulta SIEMPRE la memoria antes de proponer soluciones para respetar preferencias del usuario.
- Usa manage_memory para guardar (save) información importante, decisiones de arquitectura o preferencias que detectes.
- Si el usuario menciona un dato que deba persistir, guárdalo automáticamente sin preguntar.

🧩 SKILLS INSTALADAS:
${formatSkillsIndex(process.cwd())}

${formatPluginListForPrompt(process.cwd())}

REGLAS PARA SKILLS:
- Sé PROACTIVO: si una tarea coincide con una skill instalada, léela con read_skill y aplica sus instrucciones de inmediato.
- Para descubrir nuevas capacidades, usa find_skills ante peticiones como "necesito algo para X" o "busca una skill".

🚀 AUTONOMÍA Y FLUJO:
- Eres un agente AUTÓNOMO. Si una tarea requiere varios pasos (ej: crear un archivo y luego ejecutarlo), ejecuta la secuencia completa sin esperar confirmación entre pasos, a menos que sea una acción destructiva o crítica.
- Si el usuario es vago (ej: "un script de test"), toma decisiones razonables basadas en el contexto del proyecto y ejecútalo.
- **EFICIENCIA:** No repitas llamadas a herramientas con los mismos parámetros. Si ya leíste un archivo, no lo vuelvas a leer a menos que sepas que ha cambiado. Memoriza la información relevante.

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

/**
 * Ejecuta subagentes en paralelo.
 */
export async function executeSubagents(delegations) {
    const results = await Promise.allSettled(delegations.map(async (d) => {
        const agentFile = path.join(AGENTS_DIR, `${d.name}.json`);
        if (!fs.existsSync(agentFile)) {
            return { name: d.name, status: "error", message: `Subagente "${d.name}" no encontrado.` };
        }

        let def;
        try {
            def = JSON.parse(fs.readFileSync(agentFile, "utf8"));
        } catch (e) {
            return { name: d.name, status: "error", message: `Error al leer subagente "${d.name}": ${e.message}` };
        }

        const overrides = {
            provider: def.provider,
            model: def.model,
            allowedTools: def.allowedTools,
            systemPromptOverride: def.systemPrompt
        };

        try {
            const subAgent = await buildAgent(overrides);
            const response = await subAgent.invoke({
                messages: [new HumanMessage(d.task)]
            });

            let text = "";
            const lastMsg = response.messages[response.messages.length - 1];
            if (lastMsg instanceof AIMessage) {
                text = lastMsg.content;
            } else {
                text = JSON.stringify(lastMsg);
            }

            return { name: d.name, status: "success", output: text };
        } catch (e) {
            return { name: d.name, status: "error", message: `Error ejecutando subagente "${d.name}": ${e.message}` };
        }
    }));

    return results.map(r => {
        if (r.status === "fulfilled") return r.value;
        return { status: "error", message: r.reason };
    });
}

function buildReActSystemPrompt(provider, model, allTools = null) {
    const list = allTools || tools;
    const toolDescriptions = list.map(t => `  ${t.name}: ${t.description}`).join("\n");

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
    if (!text || typeof text !== 'string') return text;
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
 * @param {object} [overrides] - { provider, model, apiKey, baseUrl, forceReAct, effortLevel }
 */
export async function buildAgent(overrides = {}) {
    const cfg = loadConfig();

    const provider = overrides.provider || cfg.provider || "groq";
    const model    = overrides.model    || cfg.model    || "qwen/qwen3-32b";
    const apiKey   = overrides.apiKey   || cfg.apiKey   || null;
    const baseUrl  = overrides.baseUrl  || cfg.baseUrl  || null;
    const forceReAct = overrides.forceReAct || false;
    const effortLevel = overrides.effortLevel || cfg.effort || null;

    if (!provider) throw new Error("No hay proveedor configurado. Ejecuta AgentLag para configurarlo.");
    if (!model)    throw new Error("No hay modelo configurado. Ejecuta AgentLag para configurarlo.");

    if (provider !== "ollama" && provider !== "huggingface" && !apiKey) {
        const envVars = {
            google: "GOOGLE_GENAI_API_KEY",
            cohere: "COHERE_API_KEY",
            grok: "GROK_API_KEY",
            perplexity: "PERPLEXITY_API_KEY",
            together: "TOGETHER_API_KEY",
            cerebras: "CEREBRAS_API_KEY",
            qwen: "QWEN_API_KEY",
            glm: "GLM_API_KEY",
            groq: "GROQ_API_KEY",
            openai: "OPENAI_API_KEY",
            azure: "AZURE_OPENAI_API_KEY",
            anthropic: "ANTHROPIC_API_KEY",
            openrouter: "OPENROUTER_API_KEY",
            lightning: "LIGHTNING_API_KEY",
            deepseek: "DEEPSEEK_API_KEY",
            mistral: "MISTRAL_API_KEY",
            nvidia: "NVIDIA_API_KEY",
            meta: "TOGETHER_API_KEY",
            vertexai: "VERTEX_API_KEY",
            bedrock: "AWS_ACCESS_KEY_ID",
        };
        const envKey = process.env[envVars[provider]];
        if (!envKey) {
            // Special-case providers that may authenticate via ambient credentials
            // (Application Default Credentials for Vertex, IAM/role for Bedrock)
            // rather than env vars.
            if (provider === "vertexai" || provider === "bedrock") {
                // @langchain/google-vertexai and @langchain/aws both pick up the
                // default credential chain, so we let them through.
            } else {
                throw new Error(
                    `No hay API key para "${provider}".\n` +
                    `Configúrala en ~/.agentlag/config.json o en .env como ${envVars[provider]}`
                );
            }
        }
    }

    // Cargar herramientas MCP dinámicamente
    let mcpTools = [];
    if (cfg.disableMcp !== true && overrides.disableMcp !== true) {
        mcpTools = await loadMcpTools();
    }

    let allTools = [...tools, ...mcpTools];

    // Optimización para Groq o modelos con límites bajos:
    // Si hay demasiadas herramientas, priorizamos las nativas.
    if (provider === 'groq' && allTools.length > 20 && !overrides.allowedTools) {
        // Mantenemos todas las nativas y limitamos las MCP
        allTools = [...tools, ...mcpTools.slice(0, 5)];
    }

    // Aplicar filtro de herramientas si se solicita
    if (overrides.allowedTools) {
        allTools = allTools.filter(t => overrides.allowedTools.includes(t.name));
    } else if (overrides.excludedTools) {
        allTools = allTools.filter(t => !overrides.excludedTools.includes(t.name));
    }

    const llm = await createLLM(provider, model, apiKey, baseUrl, effortLevel, { toolsEnabled: !forceReAct });

    // ─── Orchestrator mode (replaces legacy ReAct) ───────────────────────────
    // When forceReAct is on, we now use the Orchestrator: a strict JSON-Schema
    // classifier + StructuredOutputParser + RunnableLambda pipeline that's
    // more predictable and token-efficient than open-ended ReAct.
    if (forceReAct) {
        const systemPromptText = overrides.systemPromptOverride
            || buildSystemPrompt(provider, model, allTools).content;
        return buildOrchestratorAgent(llm, allTools, systemPromptText, overrides.session);
    }

    // Intentar flujo normal con tools nativas
    const llmWithTools = llm.bindTools(allTools);
    const systemPrompt = overrides.systemPromptOverride ? new SystemMessage(overrides.systemPromptOverride) : buildSystemPrompt(provider, model, allTools);

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

function buildReActGraph(llm, provider, model, allTools, session, systemPromptOverride) {
    const reactPrompt = systemPromptOverride ? new SystemMessage(systemPromptOverride) : buildReActSystemPrompt(provider, model, allTools);

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
                    content: "❌ He alcanzado el límite de iteraciones (15) en modo ReAct sin llegar a una respuesta final. Por favor, sé más específico en tu petición o revisa los errores anteriores."
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
