import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { URL } from "url";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import fs from "fs";
import path from "path";
import os from "os";

const CONFIG_DIR = path.join(os.homedir(), ".agentlag");
const MCP_CONFIG_PATH = path.join(CONFIG_DIR, "mcp.json");

/**
 * Carga la configuración de MCP desde ~/.agentlag/mcp.json
 */
export function loadMcpConfig() {
    const config = { mcpServers: {} };

    // User config
    try {
        if (fs.existsSync(MCP_CONFIG_PATH)) {
            const userConfig = JSON.parse(fs.readFileSync(MCP_CONFIG_PATH, "utf8"));
            Object.assign(config.mcpServers, userConfig.mcpServers || {});
        }
    } catch (error) {
        console.error("❌ Error al cargar ~/.agentlag/mcp.json:", error.message);
    }

    // Project config
    const projectMcpPath = path.join(process.cwd(), ".agentlag", "mcp.json");
    try {
        if (fs.existsSync(projectMcpPath)) {
            const projectConfig = JSON.parse(fs.readFileSync(projectMcpPath, "utf8"));
            Object.assign(config.mcpServers, projectConfig.mcpServers || {});
        }
    } catch (error) {
        console.error("❌ Error al cargar ./.agentlag/mcp.json:", error.message);
    }

    return config;
}

/**
 * Conecta a un servidor MCP y devuelve sus herramientas convertidas a formato LangChain
 */
async function getToolsFromServers(mcpServers) {
    const allMcpTools = [];

    for (const [name, config] of Object.entries(mcpServers)) {
        try {
            let transport;
            if (config.type === 'http' || config.url) {
                transport = new SSEClientTransport(new URL(config.url));
            } else {
                transport = new StdioClientTransport({
                    command: config.command,
                    args: config.args || [],
                    env: { ...process.env, ...(config.env || {}) },
                });
            }

            const client = new Client(
                { name: "agentlag-client", version: "1.0.0" },
                { capabilities: { tools: {} } }
            );

            await client.connect(transport);
            const { tools } = await client.listTools();

            for (const t of tools) {
                // Convertir cada herramienta del MCP a una 'tool' de LangChain
                const langchainTool = tool(
                    async (input) => {
                        try {
                            const result = await client.callTool({
                                name: t.name,
                                arguments: input,
                            });
                            // El resultado del MCP suele tener una propiedad 'content' que es un array
                            if (result.isError) {
                                return `❌ Error en herramienta MCP ${t.name}: ${JSON.stringify(result.content)}`;
                            }
                            return result.content.map(c => c.text || JSON.stringify(c)).join("\n");
                        } catch (err) {
                            return `❌ Excepción ejecutando herramienta MCP ${t.name}: ${err.message}`;
                        }
                    },
                    {
                        name: t.name,
                        description: t.description || `Herramienta del servidor MCP ${name}`,
                        schema: t.inputSchema ? jsonSchemaToZod(t.inputSchema) : z.object({}),
                    }
                );
                allMcpTools.push(langchainTool);
            }

            // Nota: Aquí hay un reto. Si cerramos el transporte, no podremos llamar a la herramienta luego.
            // Para "solo cuando sea necesario", tendríamos que mantener la conexión abierta
            // o abrirla bajo demanda. Por simplicidad en esta fase, las mantendremos mientras el agente viva.
            // TODO: Mejorar la gestión del ciclo de vida si hay muchos servidores.

        } catch (error) {
            console.error(`❌ Error conectando al servidor MCP "${name}":`, error.message);
        }
    }

    return allMcpTools;
}

/**
 * Convierte un JSON Schema básico a un objeto Zod
 * Muy simplificado para herramientas comunes.
 */
function jsonSchemaToZod(schema) {
    if (!schema || schema.type !== "object") return z.object({}).passthrough();

    const shape = {};
    const properties = schema.properties || {};
    const required = schema.required || [];

    for (const [key, prop] of Object.entries(properties)) {
        let field;
        switch (prop.type) {
            case "string": field = z.string(); break;
            case "number": field = z.number(); break;
            case "integer": field = z.number().int(); break;
            case "boolean": field = z.boolean(); break;
            case "array": field = z.array(z.any()); break;
            case "object": field = z.object({}).passthrough(); break;
            default: field = z.any();
        }

        if (prop.description) field = field.describe(prop.description);
        if (!required.includes(key)) field = field.optional();

        shape[key] = field;
    }

    return z.object(shape);
}

/**
 * Obtiene todas las herramientas dinámicas del MCP
 */
export async function loadMcpTools() {
    const config = loadMcpConfig();
    if (!config.mcpServers || Object.keys(config.mcpServers).length === 0) {
        return [];
    }
    return await getToolsFromServers(config.mcpServers);
}
