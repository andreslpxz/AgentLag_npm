import sys

content = open('commands.js').read()

mcp_cmd = r"""        case '/mcp': {
            const parts = args?.trim().split(/\s+/);
            if (parts?.[0] === 'add-json') {
                const name = parts[1];
                let jsonStr = '';
                let scope = 'project';

                const remainder = parts.slice(2).join(' ');
                const scopeMatch = remainder.match(/--scope\s+(\w+)/);
                if (scopeMatch) {
                    scope = scopeMatch[1];
                    jsonStr = remainder.replace(scopeMatch[0], '').trim();
                } else {
                    jsonStr = remainder.trim();
                }

                if (jsonStr.startsWith("'") && jsonStr.endsWith("'")) jsonStr = jsonStr.slice(1, -1);
                if (jsonStr.startsWith('"') && jsonStr.endsWith('"')) jsonStr = jsonStr.slice(1, -1);

                try {
                    const serverConfig = JSON.parse(jsonStr);
                    const configDir = scope === 'user'
                        ? path.join(os.homedir(), '.agentlag')
                        : path.join(process.cwd(), '.agentlag');
                    const configPath = path.join(configDir, 'mcp.json');

                    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });

                    let mcpConfig = { mcpServers: {} };
                    if (fs.existsSync(configPath)) {
                        mcpConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                    }

                    mcpConfig.mcpServers[name] = serverConfig;
                    fs.writeFileSync(configPath, JSON.stringify(mcpConfig, null, 2));

                    say(`✅ Servidor MCP "${name}" añadido al scope ${scope}.`);
                    return true;
                } catch (e) {
                    say(`❌ Error: JSON inválido o problema al guardar: ${e.message}`);
                    return true;
                }
            }
            say('Uso: /mcp add-json <nombre> \'<json>\' [--scope user|project]');
            return true;
        }"""

insertion_point = "    switch (cmd) {"
if mcp_cmd not in content:
    content = content.replace(insertion_point, insertion_point + "\n" + mcp_cmd)

with open('commands.js', 'w') as f:
    f.write(content)
