import { tool } from "@langchain/core/tools";
import { z } from "zod";
import fs from "fs/promises";
import { exec } from "child_process";
import path from "path";
import { promisify } from "util";
import { createRequire } from "module";
import { fileURLToPath } from "url";

// Cargar .env desde el directorio del proyecto
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { config } = createRequire(import.meta.url)("dotenv");
config({ path: path.join(__dirname, ".env") });

const execPromise = promisify(exec);

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
  async ({ dirPath, recursive }) => {
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
    description: "Lista los archivos y carpetas de un directorio. Puede ser recursivo (omite node_modules y .git).",
    schema: z.object({
      dirPath: z.string().describe("Ruta del directorio a listar"),
      recursive: z.boolean().describe("true para listar recursivamente (omite node_modules), false para solo el nivel actual"),
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
// EXPORTAR TODAS LAS HERRAMIENTAS
// ─────────────────────────────────────────────
export const tools = [createFile, readFile, listDirectory, runShell, webSearch];
