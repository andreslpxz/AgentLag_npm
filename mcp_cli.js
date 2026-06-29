// ─── mcp_cli.js ───────────────────────────────────────────────────────────────
// Helpers compartidos para gestionar servidores MCP desde FUERA de la TUI
// (subcomando `agentlag mcp ...`) y desde DENTRO (comando `/mcp ...`).
//
// Toda la configuración MCP vive en:
//   - Scope "user":    ~/.agentlag/mcp.json
//   - Scope "project": ./.agentlag/mcp.json
//
// La función loadMcpConfig() de mcp_utils.js ya fusiona ambos al arrancar el
// agente, así que aquí solo nos preocupamos de leer/escribir cada fichero.
import fs from 'fs';
import path from 'path';
import os from 'os';

export const USER_MCP_DIR = path.join(os.homedir(), '.agentlag');
export const USER_MCP_FILE = path.join(USER_MCP_DIR, 'mcp.json');

export function projectMcpDir(cwd = process.cwd()) {
    return path.join(cwd, '.agentlag');
}
export function projectMcpFile(cwd = process.cwd()) {
    return path.join(projectMcpDir(cwd), 'mcp.json');
}

/**
 * Devuelve la ruta al fichero mcp.json del scope pedido.
 * @param {'user'|'project'} scope
 * @param {string} [cwd]
 */
export function resolveMcpFile(scope, cwd = process.cwd()) {
    return scope === 'user' ? USER_MCP_FILE : projectMcpFile(cwd);
}

/**
 * Lee el mcp.json del scope indicado. Si no existe, devuelve { mcpServers: {} }.
 * No lanza: ante cualquier error de parseo devuelve estructura vacía y mete el
 * error en `__error` para que el caller pueda mostrarlo sin romper.
 */
export function readMcpConfig(scope, cwd = process.cwd()) {
    const file = resolveMcpFile(scope, cwd);
    if (!fs.existsSync(file)) return { mcpServers: {} };
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || !parsed.mcpServers) {
            return { mcpServers: {} };
        }
        return parsed;
    } catch (e) {
        return { mcpServers: {}, __error: e.message };
    }
}

/**
 * Escribe el mcp.json del scope indicado (crea el directorio si hace falta).
 */
export function writeMcpConfig(scope, config, cwd = process.cwd()) {
    const file = resolveMcpFile(scope, cwd);
    const dir  = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(config, null, 2));
}

/**
 * Añade (o sobrescribe) un servidor MCP en el scope indicado.
 *
 * Acepta dos formas para `server`:
 *   - { command, args, env? }            → servidor stdio
 *   - { url, type?: 'http' | 'sse' }     → servidor HTTP/SSE
 *
 * @param {object} params
 * @param {string} params.name            Nombre único del servidor.
 * @param {object} params.server          Definición del servidor.
 * @param {'user'|'project'} [params.scope='user']
 * @param {string} [params.cwd]           Directorio del proyecto (para scope='project').
 * @returns {{name:string, scope:string, file:string, overwritten:boolean}}
 */
export function addMcpServer({ name, server, scope = 'user', cwd }) {
    if (!name || typeof name !== 'string') {
        throw new Error('El nombre del servidor es obligatorio.');
    }
    if (!server || typeof server !== 'object') {
        throw new Error('La definición del servidor es obligatoria.');
    }
    // Validación mínima: necesita command o url.
    if (!server.command && !server.url) {
        throw new Error("El servidor necesita 'command' (stdio) o 'url' (http/sse).");
    }
    // Normalizamos.
    const clean = server.command
        ? { command: server.command, args: Array.isArray(server.args) ? server.args : [], ...(server.env ? { env: server.env } : {}) }
        : { url: server.url, ...(server.type ? { type: server.type } : {}) };

    const config = readMcpConfig(scope, cwd);
    const overwritten = Object.prototype.hasOwnProperty.call(config.mcpServers, name);
    config.mcpServers[name] = clean;
    writeMcpConfig(scope, config, cwd);

    return { name, scope, file: resolveMcpFile(scope, cwd), overwritten };
}

/**
 * Elimina un servidor MCP por nombre. No falla si no existe.
 * @returns {{name:string, scope:string, file:string, removed:boolean}}
 */
export function removeMcpServer({ name, scope = 'user', cwd }) {
    if (!name) throw new Error('El nombre del servidor es obligatorio.');
    const config = readMcpConfig(scope, cwd);
    const removed = Object.prototype.hasOwnProperty.call(config.mcpServers, name);
    if (removed) {
        delete config.mcpServers[name];
        writeMcpConfig(scope, config, cwd);
    }
    return { name, scope, file: resolveMcpFile(scope, cwd), removed };
}

/**
 * Lista los servidores de un scope. Devuelve un array de pares [name, def].
 * Si scope='all' recorre primero user y luego project (sin fusionar: si un
 * nombre existe en ambos, aparecerá dos veces marcando su scope).
 */
export function listMcpServers({ scope = 'all', cwd } = {}) {
    const out = [];
    const pushScope = (s) => {
        const cfg = readMcpConfig(s, cwd);
        for (const [name, def] of Object.entries(cfg.mcpServers || {})) {
            out.push({ name, def, scope: s, file: resolveMcpFile(s, cwd) });
        }
    };
    if (scope === 'all') {
        pushScope('user');
        pushScope('project');
    } else {
        pushScope(scope);
    }
    return out;
}

// ─── CLI router ───────────────────────────────────────────────────────────────
// runMcpCli(argv) parsea argv (sin el prefijo 'mcp') y ejecuta la acción.
// Devuelve un código de salida numérico (0 = OK, !=0 = error).

function usage(stream = process.stdout) {
    const msg = [
        'Uso: agentlag mcp <comando> [opciones]',
        '',
        'Comandos:',
        '  add <name> <command> [args...]           Añade un servidor MCP stdio.',
        '  add-url <name> <url> [--type http|sse]   Añade un servidor MCP HTTP/SSE.',
        "  add-json <name> '<json>'                 Añade un servidor desde JSON completo.",
        '  list [--scope user|project|all]          Lista los servidores configurados.',
        '  remove <name> [--scope user|project]     Elimina un servidor por nombre.',
        '',
        'Opciones comunes:',
        '  --scope user|project   Scope destino (default: user).',
        '  --cwd <path>           Directorio del proyecto (solo relevante para scope=project).',
        '  -h, --help             Muestra esta ayuda.',
        '',
        'Ejemplos:',
        '  agentlag mcp add playwright npx @playwright/mcp@latest',
        '  agentlag mcp add filesystem npx -y @modelcontextprotocol/server-filesystem /tmp',
        '  agentlag mcp add-url myapi https://mcp.example.com/sse --type sse',
        '  agentlag mcp list',
        '  agentlag mcp remove playwright',
    ].join('\n');
    stream.write(msg + '\n');
}

function parseScope(args) {
    const idx = args.indexOf('--scope');
    if (idx === -1) return { scope: 'user', rest: args };
    const val = args[idx + 1];
    if (!val || !['user', 'project', 'all'].includes(val)) {
        throw new Error("--scope debe ser 'user', 'project' o 'all'.");
    }
    return { scope: val, rest: [...args.slice(0, idx), ...args.slice(idx + 2)] };
}

function parseCwd(args) {
    const idx = args.indexOf('--cwd');
    if (idx === -1) return { cwd: undefined, rest: args };
    const val = args[idx + 1];
    if (!val) throw new Error('--cwd requiere un path.');
    return { cwd: val, rest: [...args.slice(0, idx), ...args.slice(idx + 2)] };
}

function stripQuotes(s) {
    if (typeof s !== 'string') return s;
    if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
        return s.slice(1, -1);
    }
    return s;
}

export function runMcpCli(argv) {
    const args = (argv || []).slice();
    if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
        usage();
        return 0;
    }
    const sub = args[0];
    const rest = args.slice(1);

    try {
        if (sub === 'add') {
            // agentlag mcp add <name> <command> [args...] [--scope X] [--cwd P]
            const { scope: s1, rest: r1 } = parseScope(rest);
            const { scope, rest: r2 } = { scope: s1, rest: r1 }; // scope ya extraído
            // r2 ya sin --scope; ahora sacamos --cwd
            const { cwd, rest: r3 } = parseCwd(r2);
            const [name, command, ...serverArgs] = r3;
            if (!name || !command) {
                process.stderr.write('Uso: agentlag mcp add <name> <command> [args...]\n');
                return 1;
            }
            const server = { command, args: serverArgs.map(stripQuotes) };
            const res = addMcpServer({ name, server, scope: scope === 'all' ? 'user' : scope, cwd });
            process.stdout.write(
                `✅ Servidor MCP "${res.name}" añadido al scope ${res.scope}.\n` +
                `   ${res.overwritten ? '(sobrescrito)' : '(nuevo)'}  →  ${res.file}\n` +
                `   command: ${server.command} ${(server.args || []).join(' ')}\n`
            );
            return 0;
        }

        if (sub === 'add-url') {
            const { scope: s1, rest: r1 } = parseScope(rest);
            const { cwd, rest: r2 } = parseCwd(r1);
            // r2: <name> <url> [--type X]
            const name = r2[0];
            const url  = r2[1];
            if (!name || !url) {
                process.stderr.write('Uso: agentlag mcp add-url <name> <url> [--type http|sse]\n');
                return 1;
            }
            const typeIdx = r2.indexOf('--type');
            const type = typeIdx !== -1 ? r2[typeIdx + 1] : undefined;
            const server = { url, ...(type ? { type } : {}) };
            const res = addMcpServer({ name, server, scope: s1 === 'all' ? 'user' : s1, cwd });
            process.stdout.write(
                `✅ Servidor MCP "${res.name}" añadido al scope ${res.scope}.\n` +
                `   ${res.overwritten ? '(sobrescrito)' : '(nuevo)'}  →  ${res.file}\n` +
                `   url: ${url}${type ? ` (type=${type})` : ''}\n`
            );
            return 0;
        }

        if (sub === 'add-json') {
            const { scope, rest: r1 } = parseScope(rest);
            const { cwd, rest: r2 } = parseCwd(r1);
            const name = r2[0];
            const jsonStr = r2.slice(1).join(' ').trim();
            if (!name || !jsonStr) {
                process.stderr.write("Uso: agentlag mcp add-json <name> '<json>'\n");
                return 1;
            }
            let server;
            try {
                server = JSON.parse(stripQuotes(jsonStr));
            } catch (e) {
                process.stderr.write(`❌ JSON inválido: ${e.message}\n`);
                return 1;
            }
            const res = addMcpServer({ name, server, scope: scope === 'all' ? 'user' : scope, cwd });
            process.stdout.write(
                `✅ Servidor MCP "${res.name}" añadido al scope ${res.scope}.\n` +
                `   ${res.overwritten ? '(sobrescrito)' : '(nuevo)'}  →  ${res.file}\n` +
                `   def: ${JSON.stringify(server)}\n`
            );
            return 0;
        }

        if (sub === 'list') {
            const { scope, rest: r1 } = parseScope(rest);
            // --cwd no afecta realmente al listado user, pero lo aceptamos por consistencia.
            const { cwd } = parseCwd(r1);
            const servers = listMcpServers({ scope: scope === 'all' ? 'all' : scope, cwd });
            if (servers.length === 0) {
                process.stdout.write('🔌 No hay servidores MCP configurados.\n');
                return 0;
            }
            process.stdout.write('🔌 Servidores MCP configurados:\n');
            for (const s of servers) {
                const detail = s.def.url
                    ? `url: ${s.def.url}${s.def.type ? ` (type=${s.def.type})` : ''}`
                    : `${s.def.command || ''} ${(s.def.args || []).join(' ')}`;
                process.stdout.write(`  • [${s.scope}] ${s.name}: ${detail}\n`);
            }
            process.stdout.write(`\nTotal: ${servers.length} servidor(es).\n`);
            return 0;
        }

        if (sub === 'remove' || sub === 'rm') {
            const { scope, rest: r1 } = parseScope(rest);
            const { cwd, rest: r2 } = parseCwd(r1);
            const name = r2[0];
            if (!name) {
                process.stderr.write('Uso: agentlag mcp remove <name> [--scope user|project]\n');
                return 1;
            }
            const res = removeMcpServer({ name, scope: scope === 'all' ? 'user' : scope, cwd });
            if (res.removed) {
                process.stdout.write(`✅ Servidor MCP "${res.name}" eliminado del scope ${res.scope}.\n   →  ${res.file}\n`);
                return 0;
            }
            process.stderr.write(`⚠ No se encontró "${res.name}" en el scope ${res.scope}.\n   →  ${res.file}\n`);
            return 1;
        }

        process.stderr.write(`❌ Subcomando desconocido: ${sub}\n\n`);
        usage(process.stderr);
        return 1;
    } catch (e) {
        process.stderr.write(`❌ ${e.message}\n`);
        return 1;
    }
}
