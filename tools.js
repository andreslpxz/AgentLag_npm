import { tool } from "@langchain/core/tools";
import { z } from "zod";
import fs from "fs/promises";
import { exec } from "child_process";
import path from "path";
import { promisify } from "util";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import os from "os";
import { formatSkillsIndex, readSkill } from "./skills.js";

// Cargar .env desde el directorio del proyecto
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { config } = createRequire(import.meta.url)("dotenv");
config({ path: path.join(__dirname, ".env") });

const execPromise = promisify(exec);

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
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
      if (!content.includes(oldText)) {
        return `❌ No se encontró el texto a reemplazar en ${filePath}. Usa read_file primero para ver el contenido exacto.`;
      }
      const updated = content.replace(oldText, newText);
      await fs.writeFile(filePath, updated, "utf8");
      return `✅ Archivo editado: ${filePath}\n   Reemplazado ${oldText.split('\n').length} línea(s).`;
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
export const searchFiles = tool(
  async ({ pattern, dirPath = ".", fileGlob }) => {
    try {
      let cmd = `grep -rn --include='${fileGlob || '*'}' "${pattern}" "${dirPath}" 2>/dev/null | head -50`;
      const { stdout, stderr } = await execPromise(cmd, { timeout: 15000 });
      if (!stdout.trim()) return `⚠️ No se encontraron coincidencias para "${pattern}".`;
      return `🔍 Resultados para "${pattern}":\n${stdout}`;
    } catch (error) {
      if (error.code === 1) return `⚠️ No se encontraron coincidencias para "${pattern}".`;
      return `❌ Error al buscar: ${error.message}`;
    }
  },
  {
    name: "search_files",
    description: "Busca un patrón de texto en archivos del proyecto (como grep). Útil para encontrar funciones, variables, imports, o cualquier texto en el código.",
    schema: z.object({
      pattern: z.string().describe("Texto o regex a buscar"),
      dirPath: z.string().optional().default(".").describe("Directorio donde buscar (default: directorio actual)"),
      fileGlob: z.string().optional().describe("Filtrar por tipo de archivo (ej: '*.js', '*.py', '*.jsx')"),
    }),
  }
);

// ─────────────────────────────────────────────
// HERRAMIENTA: EJECUTAR SHELL
// ─────────────────────────────────────────────
export const runShell = tool(
  async ({ command }) => {
    try {
      const opts = { timeout: 60000 };
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
    description: "Ejecuta un comando en la terminal de Termux/Linux y devuelve su salida. Útil para instalar paquetes, ejecutar scripts, git, npm, compilar código, etc.",
    schema: z.object({
      command: z.string().describe("Comando de shell a ejecutar. Para cambiar directorio usa 'cd /ruta && comando'."),
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
      if (!apiKey) return "❌ Falta TAVILY_API_KEY en las variables de entorno.";

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
      return `❌ Error en búsqueda Tavily: ${error.message}`;
    }
  },
  {
    name: "web_search",
    description: "Busca información actualizada en internet usando Tavily AI Search. Úsalo para noticias, documentación, versiones de librerías, tutoriales, comparativas y cualquier pregunta sobre tecnología o el mundo real. Siempre devuelve fuentes reales con URLs.",
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
export const tools = [createFile, readFile, editFile, listDirectory, searchFiles, runShell, webSearch, listSkills, readSkillTool, findSkills, addSkill];
