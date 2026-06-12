import { tool } from "@langchain/core/tools";
import { z } from "zod";
import fs from "fs/promises";
import { exec, spawn } from "child_process";
import path from "path";
import { promisify } from "util";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import os from "os";
import { formatSkillsIndex, readSkill } from "./skills.js";
import { addToMemory, listMemory } from "./memory_utils.js";

// Cargar .env desde el directorio del proyecto
import { executeSubagents } from "./agent.js";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { config } = createRequire(import.meta.url)("dotenv");
config({ path: path.join(__dirname, ".env") });

const execPromise = promisify(exec);
const DEFAULT_SHELL_TIMEOUT_MS = 60000;
const MAX_SHELL_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_DIFF_CHARS = 12000;

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function countOccurrences(content, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while ((index = content.indexOf(needle, index)) !== -1) {
    count++;
    index += needle.length;
  }
  return count;
}

function clampTimeout(timeoutMs) {
  const parsed = Number(timeoutMs);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SHELL_TIMEOUT_MS;
  return Math.min(Math.floor(parsed), MAX_SHELL_TIMEOUT_MS);
}

async function buildFileDiff(filePath, before, after) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentlag-diff-"));
  const beforePath = path.join(tmpDir, "before");
  const afterPath = path.join(tmpDir, "after");
  await fs.writeFile(beforePath, before, "utf8");
  await fs.writeFile(afterPath, after, "utf8");
  try {
    const cmd = `diff -u --label ${shellQuote(`${filePath} (before)`)} --label ${shellQuote(`${filePath} (after)`)} ${shellQuote(beforePath)} ${shellQuote(afterPath)}`;
    const { stdout } = await execPromise(cmd, { timeout: 10000 });
    return stdout;
  } catch (error) {
    return error.stdout || "";
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

function formatDiff(diff) {
  if (!diff.trim()) return "Sin cambios.";
  if (diff.length <= MAX_DIFF_CHARS) return diff;
  return `${diff.slice(0, MAX_DIFF_CHARS)}\n... diff truncado (${diff.length - MAX_DIFF_CHARS} caracteres restantes).`;
}

function execWithInput(command, args, input, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      const error = new Error(`Command timed out after ${timeoutMs}ms`);
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    }, timeoutMs);

    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", error => {
      clearTimeout(timeout);
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
    child.on("close", code => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const error = new Error(`${command} exited with code ${code}`);
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    });
    child.stdin.end(input);
  });
}

async function fallbackWebSearch(query) {
  if (typeof fetch !== "function") {
    return "❌ No hay TAVILY_API_KEY y fetch no está disponible para fallback web.";
  }

  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1`;
  const response = await fetch(url, {
    headers: { "user-agent": "AgentLag/1.0 (+https://github.com/andreslpxz/AgentLag_npm)" },
  });
  if (!response.ok) {
    return `❌ Fallback web_search falló: HTTP ${response.status}`;
  }

  const data = await response.json();
  const lines = ["🔎 Resultados de fallback DuckDuckGo (sin Tavily):"];
  if (data.AbstractText) {
    lines.push(`💡 ${data.AbstractText}`);
    if (data.AbstractURL) lines.push(`🔗 ${data.AbstractURL}`);
  }

  const topics = [];
  for (const item of data.RelatedTopics || []) {
    if (item.Text && item.FirstURL) topics.push(item);
    for (const nested of item.Topics || []) {
      if (nested.Text && nested.FirstURL) topics.push(nested);
    }
  }

  for (const item of topics.slice(0, 5)) {
    lines.push(`- ${item.Text}`);
    lines.push(`  ${item.FirstURL}`);
  }

  return lines.length > 1
    ? lines.join("\n")
    : "⚠️ Fallback DuckDuckGo no devolvió resultados útiles para esta consulta.";
}

// ─────────────────────────────────────────────
// HERRAMIENTA: CREAR / SOBREESCRIBIR ARCHIVO
// ─────────────────────────────────────────────
export const createFile = tool(
  async ({ filePath, content }) => {
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content, "utf8");
      return `✅ Archivo creado/actualizado: ${filePath}`;
    } catch (error) {
      return `❌ Error al crear archivo: ${error.message}`;
    }
  },
  {
    name: "create_file",
    description: "Crea o sobreescribe un archivo con el contenido indicado. Crea directorios intermedios si no existen.",
    schema: z.object({
      filePath: z.string().describe("Ruta absoluta o relativa del archivo a crear"),
      content: z.string().describe("Contenido que tendrá el archivo"),
    }),
  }
);

// ─────────────────────────────────────────────
// HERRAMIENTA: LEER ARCHIVO
// ─────────────────────────────────────────────
export const readFile = tool(
  async ({ filePath }) => {
    try {
      const content = await fs.readFile(filePath, "utf8");
      const lines = content.split("\n").map((line, i) => `${i + 1}: ${line}`).join("\n");
      return `📄 ${filePath}:\n\n${lines}`;
    } catch (error) {
      return `❌ Error al leer archivo: ${error.message}`;
    }
  },
  {
    name: "read_file",
    description: "Lee y devuelve el contenido de un archivo existente con números de línea.",
    schema: z.object({
      filePath: z.string().describe("Ruta del archivo a leer"),
    }),
  }
);

// ─────────────────────────────────────────────
// HERRAMIENTA: LISTAR DIRECTORIO
// ─────────────────────────────────────────────
export const listDirectory = tool(
  async ({ dirPath, recursive = false }) => {
    try {
      const cmd = recursive
        ? `find "${dirPath}" -not -path "*/node_modules/*" -not -path "*/.git/*" | head -100`
        : `ls -la "${dirPath}"`;
      const { stdout, stderr } = await execPromise(cmd, { timeout: 15000 });
      return stdout || stderr || "📂 Directorio vacío.";
    } catch (error) {
      return `❌ Error al listar: ${error.message}`;
    }
  },
  {
    name: "list_directory",
    description: "Lista los archivos y carpetas de un DIRECTORIO (no un archivo). Usa . para el directorio actual.",
    schema: z.object({
      dirPath: z.string().describe("Ruta del DIRECTORIO a listar (ej: '.', '/home', 'src'). NO pases un archivo."),
      recursive: z.boolean().optional().default(false).describe("true para listar recursivamente"),
    }),
  }
);

// ─────────────────────────────────────────────
// HERRAMIENTA: EDITAR ARCHIVO (BUSCAR Y REEMPLAZAR)
// ─────────────────────────────────────────────
export const editFile = tool(
  async ({ filePath, oldText, newText }) => {
    try {
      const content = await fs.readFile(filePath, "utf8");
      const occurrences = countOccurrences(content, oldText);
      if (occurrences === 0) {
        return `❌ No se encontró el texto a reemplazar en ${filePath}. Usa read_file primero para ver el contenido exacto.`;
      }
      if (occurrences > 1) {
        return `❌ Reemplazo ambiguo: el texto aparece ${occurrences} veces en ${filePath}. Amplía oldText hasta que sea único.`;
      }
      const updated = content.replace(oldText, newText);
      await fs.writeFile(filePath, updated, "utf8");
      const diff = await buildFileDiff(filePath, content, updated);
      return `✅ Archivo editado: ${filePath}\n   Reemplazado ${oldText.split('\n').length} línea(s).\n\nDiff:\n${formatDiff(diff)}`;
    } catch (error) {
      return `❌ Error al editar: ${error.message}`;
    }
  },
  {
    name: "edit_file",
    description: "Edita un archivo reemplazando texto existente. Primero usa read_file para ver el contenido exacto, luego usa esta herramienta para hacer cambios quirúrgicos sin reescribir todo el archivo.",
    schema: z.object({
      filePath: z.string().describe("Ruta del archivo a editar"),
      oldText: z.string().describe("Texto EXACTO que existe en el archivo y será reemplazado"),
      newText: z.string().describe("Nuevo texto que reemplazará al antiguo"),
    }),
  }
);

// ─────────────────────────────────────────────
// HERRAMIENTA: BUSCAR EN ARCHIVOS (GREP)
// ─────────────────────────────────────────────
async function searchInFilesImpl({ pattern, dirPath = ".", fileGlob, literal = false, maxResults = 50 }) {
  try {
    const grepArgs = [
      "-RIn",
      "--exclude-dir=.git",
      "--exclude-dir=node_modules",
      "--exclude-dir=dist",
      "--exclude-dir=build",
    ];
    if (literal) grepArgs.push("-F");
    if (fileGlob) grepArgs.push(`--include=${shellQuote(fileGlob)}`);
    const limit = Math.min(Math.max(Number(maxResults) || 50, 1), 200);
    const cmd = `grep ${grepArgs.join(" ")} -- ${shellQuote(pattern)} ${shellQuote(dirPath)} 2>/dev/null | head -${limit}`;
    const { stdout, stderr } = await execPromise(cmd, { timeout: 15000 });
    if (!stdout.trim()) return `⚠️ No se encontraron coincidencias para "${pattern}".`;
    return `🔍 Resultados para "${pattern}":\n${stdout}`;
  } catch (error) {
    if (error.code === 1) return `⚠️ No se encontraron coincidencias para "${pattern}".`;
    return `❌ Error al buscar: ${error.message}`;
  }
}

export const searchInFiles = tool(
  searchInFilesImpl,
  {
    name: "search_in_files",
    description: "Busca texto literal o regex en archivos del proyecto completo. Útil para encontrar funciones, variables, imports o patrones sin leer archivos uno por uno.",
    schema: z.object({
      pattern: z.string().describe("Texto o regex a buscar"),
      dirPath: z.string().optional().default(".").describe("Directorio donde buscar"),
      fileGlob: z.string().optional().describe("Filtrar por glob, ej: '*.js'"),
      literal: z.boolean().optional().default(false).describe("true para búsqueda literal"),
      maxResults: z.number().int().positive().max(200).optional().default(50).describe("Máximo de resultados"),
    }),
  }
);

// ─────────────────────────────────────────────
// HERRAMIENTA: MOSTRAR DIFF
// ─────────────────────────────────────────────
export const showDiff = tool(
  async ({ filePath }) => {
    try {
      const fileArg = filePath ? ` -- ${shellQuote(filePath)}` : "";
      const { stdout, stderr } = await execPromise(`git diff --no-ext-diff --no-color${fileArg}`, { timeout: 15000 });
      const output = stdout || stderr || "";
      return output.trim() ? `Diff actual:\n${formatDiff(output)}` : "Sin cambios en git diff.";
    } catch (error) {
      return `❌ Error al mostrar diff: ${error.message}`;
    }
  },
  {
    name: "show_diff",
    description: "Muestra el diff git actual, opcionalmente limitado a un archivo. Úsala después de editar para revisar cambios exactos.",
    schema: z.object({
      filePath: z.string().optional().describe("Archivo opcional para limitar el diff"),
    }),
  }
);

// ─────────────────────────────────────────────
// HERRAMIENTA: APLICAR PATCH
// ─────────────────────────────────────────────
export const applyPatchTool = tool(
  async ({ patch, timeoutMs = 15000 }) => {
    try {
      const { stdout, stderr } = await execWithInput("git", ["apply", "--whitespace=fix", "-"], patch, clampTimeout(timeoutMs));
      return (stdout || stderr || "✅ Patch aplicado.").trim();
    } catch (error) {
      const output = [error.stdout, error.stderr].filter(Boolean).join("\n").trim();
      return `❌ Error aplicando patch: ${output || error.message}`;
    }
  },
  {
    name: "apply_patch",
    description: "Aplica un patch unificado con git apply. Útil para cambios multiarchivo preservando un diff explícito.",
    schema: z.object({
      patch: z.string().describe("Patch unificado completo"),
      timeoutMs: z.number().int().positive().max(MAX_SHELL_TIMEOUT_MS).optional().default(15000).describe("Timeout en milisegundos"),
    }),
  }
);

// ─────────────────────────────────────────────
// HERRAMIENTA: EJECUTAR SHELL
// ─────────────────────────────────────────────
export const runShell = tool(
  async ({ command, timeoutMs = DEFAULT_SHELL_TIMEOUT_MS }) => {
    try {
      const opts = { timeout: clampTimeout(timeoutMs) };
      const { stdout, stderr } = await execPromise(command, opts);
      let output = "";
      if (stdout) output += `STDOUT:\n${stdout}\n`;
      if (stderr) output += `STDERR:\n${stderr}`;
      return output.trim() || "✅ Comando ejecutado sin salida.";
    } catch (error) {
      return `❌ Error al ejecutar: ${error.message}`;
    }
  },
  {
    name: "run_shell",
    description: "Ejecuta un comando en la terminal de Termux/Linux y devuelve su salida. Acepta timeoutMs para comandos largos o peligrosos.",
    schema: z.object({
      command: z.string().describe("Comando de shell a ejecutar. Para cambiar directorio usa 'cd /ruta && comando'."),
      timeoutMs: z.number().int().positive().max(MAX_SHELL_TIMEOUT_MS).optional().default(DEFAULT_SHELL_TIMEOUT_MS).describe("Timeout configurable en ms (máx. 600000)."),
    }),
  }
);

// ─────────────────────────────────────────────
// HERRAMIENTA: BÚSQUEDA WEB (TAVILY)
// ─────────────────────────────────────────────
export const webSearch = tool(
  async ({ query }) => {
    try {
      const apiKey = process.env.TAVILY_API_KEY;
      if (!apiKey) return await fallbackWebSearch(query);

      const { tavily } = await import("@tavily/core");
      const client = tavily({ apiKey });

      const res = await client.search(query, {
        searchDepth: "basic",
        maxResults: 5,
        includeAnswer: true,
      });

      const lines = [];

      if (res.answer) {
        lines.push(`💡 Respuesta directa: ${res.answer}\n`);
      }

      if (res.results?.length > 0) {
        lines.push("🔍 Fuentes encontradas:");
        res.results.forEach((r, i) => {
          lines.push(`  ${i + 1}. ${r.title}`);
          lines.push(`     🔗 ${r.url}`);
          if (r.content) {
            lines.push(`     ${r.content.slice(0, 220).replace(/\n/g, " ")}…`);
          }
        });
      }

      return lines.length > 0
        ? lines.join("\n")
        : "⚠️ Tavily no devolvió resultados para esta consulta.";

    } catch (error) {
      const fallback = await fallbackWebSearch(query).catch(fallbackError => `❌ Fallback web_search falló: ${fallbackError.message}`);
      return `⚠️ Tavily falló (${error.message}).\n\n${fallback}`;
    }
  },
  {
    name: "web_search",
    description: "Busca información actualizada en internet. Usa Tavily si TAVILY_API_KEY existe y fallback público de DuckDuckGo si no hay key.",
    schema: z.object({
      query: z.string().describe("Consulta de búsqueda. Puede ser una pregunta completa o términos clave en cualquier idioma."),
    }),
  }
);

// ─────────────────────────────────────────────
// HERRAMIENTA: LISTAR SKILLS INSTALADAS
// ─────────────────────────────────────────────
export const listSkills = tool(
  async () => formatSkillsIndex(process.cwd()),
  {
    name: "list_skills",
    description: "Lista las skills instaladas en .agents/skills del proyecto y ~/.agents/skills globales.",
    schema: z.object({}),
  }
);

// ─────────────────────────────────────────────
// HERRAMIENTA: LEER UNA SKILL
// ─────────────────────────────────────────────
export const readSkillTool = tool(
  async ({ name }) => {
    const skill = readSkill(name, process.cwd());
    if (!skill) return `⚠️ No encontré la skill "${name}". Usa list_skills para ver las instaladas.`;
    return `📘 ${skill.name} (${skill.scope})\nRuta: ${skill.path}\n\n${skill.content}`;
  },
  {
    name: "read_skill",
    description: "Lee el SKILL.md completo de una skill instalada para seguir sus instrucciones.",
    schema: z.object({
      name: z.string().describe("Nombre de la skill instalada, por ejemplo find-skills"),
    }),
  }
);

// ─────────────────────────────────────────────
// HERRAMIENTA: BUSCAR SKILLS EN SKILLS.SH
// ─────────────────────────────────────────────
export const findSkills = tool(
  async ({ query }) => {
    try {
      const { stdout, stderr } = await execPromise(`npx -y skills find ${shellQuote(query)}`, { timeout: 60000 });
      return (stdout || stderr || "Sin resultados.").trim();
    } catch (error) {
      return `❌ Error buscando skills: ${error.message}`;
    }
  },
  {
    name: "find_skills",
    description: "Busca skills en skills.sh con `npx skills find`. Úsala cuando el usuario pida una capacidad tipo 'necesito algo para X' o 'busca una skill para X'.",
    schema: z.object({
      query: z.string().describe("Términos de búsqueda, por ejemplo 'image optimization'"),
    }),
  }
);

// ─────────────────────────────────────────────
// HERRAMIENTA: INSTALAR SKILLS
// ─────────────────────────────────────────────
export const addSkill = tool(
  async ({ source, skill, global = false, copy = false }) => {
    try {
      const args = ["-y", "skills", "add", source, "-y"];
      if (skill) args.push("--skill", skill);
      if (global) args.push("--global");
      if (copy) args.push("--copy");
      const cmd = `npx ${args.map(shellQuote).join(" ")}`;
      const targetDir = global ? path.join(os.homedir(), ".agents", "skills") : path.join(process.cwd(), ".agents", "skills");
      const before = await fs.readdir(targetDir).catch(() => []);
      const { stdout, stderr } = await execPromise(cmd, { timeout: 120000 });
      const after = await fs.readdir(targetDir).catch(() => []);
      const installed = after.filter(name => !before.includes(name));
      if (installed.length > 0) {
        for (const name of installed) {
          const installedSkill = readSkill(name, process.cwd());
          if (installedSkill?.content) {
            return `${(stdout || stderr || "✅ Skill instalada.").trim()}\n\n📘 SKILL.md instalado (${installedSkill.name}):\n${installedSkill.content}`;
          }
        }
      }
      return (stdout || stderr || "✅ Skill instalada.").trim();
    } catch (error) {
      return `❌ Error instalando skill: ${error.message}`;
    }
  },
  {
    name: "add_skill",
    description: "Instala una skill desde GitHub/skills.sh usando `npx skills add`. Requiere confirmación previa del usuario.",
    schema: z.object({
      source: z.string().describe("Fuente de la skill, por ejemplo 'vercel-labs/skills' o una URL de GitHub"),
      skill: z.string().optional().describe("Nombre concreto de la skill a instalar si el repositorio contiene varias"),
      global: z.boolean().optional().default(false).describe("true para instalar globalmente en ~/.agents/skills; false para el proyecto"),
      copy: z.boolean().optional().default(false).describe("true para copiar en vez de symlink"),
    }),
  }
);

// ─────────────────────────────────────────────
// EXPORTAR TODAS LAS HERRAMIENTAS
// ─────────────────────────────────────────────

export const manageMemory = tool(
  async ({ action, key, value, project, context, ttlDays }) => {
    try {
      if (action === 'save') {
        if (!key || !value) return "❌ Debes proporcionar clave (key) y valor (value) para guardar.";
        addToMemory(key, value, { project, context, ttlDays });
        return `✅ Guardado en memoria: "${key}" con timestamp y proyecto.`;
      }
      if (action === 'list') {
        const mem = listMemory();
        return mem ? `🧠 Memoria actual:\n${mem}` : "⚠️ La memoria está vacía.";
      }
      return "❌ Acción no válida. Usa 'save' o 'list'.";
    } catch (error) {
      return `❌ Error en memoria: ${error.message}`;
    }
  },
  {
    name: "manage_memory",
    description: "Guarda o recupera información importante en la memoria a largo plazo. Úsala para recordar preferencias del usuario, detalles del proyecto, o cualquier dato que deba persistir entre sesiones. Acciones: 'save' (requiere key y value) o 'list'.",
    schema: z.object({
      action: z.enum(['save', 'list']).describe("Acción a realizar: 'save' para guardar, 'list' para ver todo."),
      key: z.string().optional().describe("Clave del dato a guardar (ej: 'preferencia_estilo')"),
      value: z.string().optional().describe("Valor o contenido a recordar."),
      project: z.string().optional().describe("Proyecto o repo asociado a esta memoria."),
      context: z.string().optional().describe("Contexto breve de por qué se guardó."),
      ttlDays: z.number().positive().optional().describe("Días hasta expirar la entrada."),
    }),
  }
);

// Actualizar la lista de herramientas exportadas (sobrescribiendo la línea anterior si es necesario)
// Nota: como ya exporté 'tools' antes, voy a re-declararla al final del archivo.
// ─────────────────────────────────────────────
// HERRAMIENTA: VER IMAGEN
// ─────────────────────────────────────────────
export const verImage = tool(
  async ({ imagePath }) => {
    try {
      const fullPath = path.resolve(process.cwd(), imagePath);
      const ext = path.extname(fullPath).toLowerCase().replace(".", "");
      const supported = ["png", "jpg", "jpeg", "webp", "gif"];

      if (!supported.includes(ext)) {
        return `❌ Formato no soportado: ${ext}. Usa png, jpg, jpeg, webp o gif.`;
      }

      const stats = await fs.stat(fullPath);
      if (stats.size > 5 * 1024 * 1024) {
        return "❌ La imagen es demasiado grande (máx 5MB).";
      }

      const data = await fs.readFile(fullPath);
      const base64 = data.toString("base64");
      const mimeType = `image/${ext === "jpg" ? "jpeg" : ext}`;

      return `data:${mimeType};base64,${base64}`;
    } catch (error) {
      return `❌ Error al leer la imagen: ${error.message}`;
    }
  },
  {
    name: "ver_image",
    description: "Lee una imagen local y la devuelve en formato data URI (base64). Útil para que el agente pueda 'ver' archivos del proyecto.",
    schema: z.object({
      imagePath: z.string().describe("Ruta relativa al archivo de imagen (png, jpg, webp, gif)"),
    }),
  }
);


// ─────────────────────────────────────────────
// HERRAMIENTA: CONSULTAR GRAFO (L3/KUZU)
// ─────────────────────────────────────────────
export const queryGraph = tool(
  async ({ cypher }) => {
    try {
      const { kuzuClient } = await import('./kuzu_utils.js');
      const results = await kuzuClient.query(cypher);
      if (results.length === 0) return "✅ Consulta ejecutada. No se encontraron resultados.";
      return JSON.stringify(results, null, 2);
    } catch (error) {
      return `❌ Error en la consulta Cypher: ${error.message}`;
    }
  },
  {
    name: "query_graph",
    description: "Ejecuta una consulta Cypher en el Knowledge Graph L3 (Kuzu). Úsala para recuperar relaciones entre entidades, conceptos o historia del proyecto. Esquema: Entidad(nombre, tipo), RELACIONA(descripcion).",
    schema: z.object({
      cypher: z.string().describe("Consulta Cypher a ejecutar. Ejemplo: MATCH (a)-[r]->(b) RETURN a.nombre, r.descripcion, b.nombre"),
    }),
  }
);


// ─────────────────────────────────────────────
// HERRAMIENTA: DELEGAR A SUBAGENTES (PARALELO)
// ─────────────────────────────────────────────
export const delegateToSubagents = tool(
  async ({ delegations }) => {
    try {
      const results = await executeSubagents(delegations);
      const outputLines = ["🤖 Resultados de delegación paralela:"];

      results.forEach(res => {
        if (res.status === "success") {
          outputLines.push(`\n--- ✅ Subagente: ${res.name} ---\n${res.output}`);
        } else {
          outputLines.push(`\n--- ❌ Subagente: ${res.name} (Error) ---\n${res.message}`);
        }
      });

      return outputLines.join("\n");
    } catch (error) {
      return `❌ Error en delegación: ${error.message}`;
    }
  },
  {
    name: "delegate_to_subagents",
    description: "Delega múltiples tareas a diferentes subagentes para que se ejecuten en PARALELO. Úsala para tareas independientes que pueden resolverse simultáneamente (ej: análisis de varios archivos, chequeo de sintaxis y estilos, etc.).",
    schema: z.object({
      delegations: z.array(z.object({
        name: z.string().describe("Nombre del subagente (ej: syntax-checker)"),
        task: z.string().describe("Tarea específica para este subagente")
      })).min(1).describe("Lista de delegaciones a realizar en paralelo")
    }),
  }
);

// ─────────────────────────────────────────────
// HERRAMIENTA: BÚSQUEDA PROFUNDA (DEEP SEARCH)
// ─────────────────────────────────────────────
export const deepSearch = tool(
  async ({ topic, questions }) => {
    try {
      const results = [];
      const subQuestions = questions || [
        `¿Qué es ${topic}? definición y conceptos básicos`,
        `${topic} últimas novedades y avances recientes`,
        `${topic} aplicaciones prácticas y casos de uso`,
        `${topic} ventajas desventajas y limitaciones`,
        `${topic} herramientas frameworks y recursos recomendados`,
      ];

      for (const question of subQuestions.slice(0, 5)) {
        try {
          const content = await webSearch.invoke({ query: question });
          results.push({ question, content });
        } catch (e) {
          results.push({ question, content: `⚠️ Error: ${e.message}` });
        }
      }

      return JSON.stringify({
        topic,
        results,
        summary: `Se investigaron ${results.length} subtemas sobre "${topic}".`
      }, null, 2);
    } catch (error) {
      return `❌ Error en deep_search: ${error.message}`;
    }
  },
  {
    name: "deep_search",
    description: "Realiza una investigación exhaustiva sobre un tema complejo ejecutando múltiples búsquedas web. Devuelve una recopilación de datos de varios subtemas. Úsala cuando necesites un análisis profundo antes de dar una respuesta final.",
    schema: z.object({
      topic: z.string().describe("El tema principal de investigación"),
      questions: z.array(z.string()).optional().describe("Lista opcional de hasta 5 sub-preguntas específicas. Si no se proveen, se generarán automáticamente.")
    }),
  }
);

export const tools = [createFile, readFile, editFile, listDirectory, searchInFiles, showDiff, applyPatchTool, runShell, webSearch, listSkills, readSkillTool, findSkills, addSkill, manageMemory, verImage, queryGraph, delegateToSubagents, deepSearch];
