import sys

content = open('mcp_utils.js').read()

new_imports = """import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";"""

content = content.replace('import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";', new_imports)

old_load = """export function loadMcpConfig() {
    try {
        if (!fs.existsSync(MCP_CONFIG_PATH)) return { mcpServers: {} };
        return JSON.parse(fs.readFileSync(MCP_CONFIG_PATH, "utf8"));
    } catch (error) {
        console.error("❌ Error al cargar mcp.json:", error.message);
        return { mcpServers: {} };
    }
}"""

new_load = """export function loadMcpConfig() {
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
}"""

content = content.replace(old_load, new_load)

old_transport = """            const transport = new StdioClientTransport({
                command: config.command,
                args: config.args || [],
                env: { ...process.env, ...(config.env || {}) },
            });"""

new_transport = """            let transport;
            if (config.type === 'http' || config.url) {
                transport = new SSEClientTransport(new URL(config.url));
            } else {
                transport = new StdioClientTransport({
                    command: config.command,
                    args: config.args || [],
                    env: { ...process.env, ...(config.env || {}) },
                });
            }"""

content = content.replace(old_transport, new_transport)

with open('mcp_utils.js', 'w') as f:
    f.write(content)
