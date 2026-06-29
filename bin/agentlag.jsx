#!/usr/bin/env tsx
// ─── bin/agentlag.jsx ─────────────────────────────────────────────────────────
// Punto de entrada BINARIO del CLI (lo que npm linka como `agentlag`).
//
// Es un dispatcher MÍNIMO que decide entre dos caminos:
//
//   1. `agentlag mcp ...`  →  carga solo mcp_cli.js (ligero, sin React/ink)
//                             y ejecuta el subcomando. Sale con el código adecuado.
//
//   2. Cualquier otra invocación  →  carga dinámicamente cli.jsx (la TUI completa
//     con React/ink/langchain). Esto evita pagar el coste de importar todo el
//     stack pesado cuando el usuario solo quiere gestionar MCP.
//
// Esto hace que `agentlag mcp add ...` sea prácticamente instantáneo.

import { runMcpCli } from '../mcp_cli.js';

const argv = process.argv.slice(2);

if (argv.length > 0 && argv[0] === 'mcp') {
    const code = runMcpCli(argv.slice(1));
    process.exit(code ?? 0);
}

// No es subcomando `mcp`: arrancamos la TUI completa.
// Usamos import dinámico para que el dispatcher se mantenga ligero.
import('../cli.jsx').catch(err => {
    process.stderr.write(`❌ No se pudo arrancar AgentLag: ${err.message}\n`);
    process.exit(1);
});
