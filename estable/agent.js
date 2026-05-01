import { ChatGroq } from "@langchain/groq";
import { StateGraph, START, Annotation } from "@langchain/langgraph";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";
import { SystemMessage, AIMessage } from "@langchain/core/messages";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";

// Cargar .env (también aquí por si agent.js se usa directamente)
const __agentDir = path.dirname(fileURLToPath(import.meta.url));
const { config } = createRequire(import.meta.url)("dotenv");
config({ path: path.join(__agentDir, ".env") });

import { tools } from "./tools.js";

/**
 * Define el estado del agente
 */
const AgentState = Annotation.Root({
  messages: Annotation({
    reducer: (x, y) => x.concat(y),
    default: () => [],
  }),
});

/**
 * Construye y compila el grafo del agente.
 */
export async function buildAgent() {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("Falta GROQ_API_KEY en las variables de entorno.");
  }

  // qwen3-32b: excelente soporte de tool calling en Groq (2025)
  const llm = new ChatGroq({
    model: "qwen/qwen3-32b",
    apiKey: apiKey,
    temperature: 0.4,
    maxTokens: 3600,
  });

  const llmWithTools = llm.bindTools(tools);

  const SYSTEM_PROMPT = new SystemMessage(
    `Eres AgentLag, un asistente experto en desarrollo de software, gestión de archivos y terminal.
Corres en Termux (Android/Linux). Tienes acceso a las siguientes herramientas:

🛠️ HERRAMIENTAS:
- create_file: Crea o sobreescribe archivos con contenido.
- read_file: Lee el contenido de un archivo con números de línea.
- list_directory: Lista archivos y carpetas (puede ser recursivo).
- run_shell: Ejecuta cualquier comando en la terminal (npm, git, python, etc.).
- web_search: Busca en internet con Tavily AI Search — resultados reales, actualizados.

📋 CÓMO ACTUAR:
- Antes de usar una herramienta, explica brevemente qué vas a hacer.
- Si algo falla, analiza el error y propón alternativas.
- Al terminar una tarea, resume qué hiciste y el resultado.
- Para preguntas sobre tecnología, librerías, versiones o noticias → usa web_search.
- Cuando el usuario pida crear proyectos o código: crea los archivos reales con create_file + run_shell.
- Responde siempre en el idioma que use el usuario.
- Sé preciso y conciso. Evita repeticiones innecesarias.

🎯 ESPECIALIDADES:
- Node.js, npm, librerías de LangChain/LangGraph
- Desarrollo en Termux/Android
- Scripts de automatización y gestión de archivos`
  );

  const callModel = async (state) => {
    const messages = [SYSTEM_PROMPT, ...state.messages];
    const response = await llmWithTools.invoke(messages);
    return { messages: [response] };
  };

  const toolNode = new ToolNode(tools);

  const workflow = new StateGraph(AgentState)
    .addNode("agent", callModel)
    .addNode("tools", toolNode)
    .addEdge(START, "agent")
    .addConditionalEdges("agent", toolsCondition)
    .addEdge("tools", "agent");

  return workflow.compile();
}
