#!/usr/bin/env node
// ─── install-mcp.js ───────────────────────────────────────────────────────────
// Helper script para registrar los servidores MCP del plugin autonomous-ops
// en ~/.agentlag/mcp.json usando la estructura correcta { mcpServers: { ... } }
// que mcp_utils.js carga al arrancar el agente.
//
// ¿Por qué existe este script?
// El plugin_engine.js de AgentLag (a la fecha) escribe las keys de MCP servers
// a nivel top-level del archivo mcp.json (fuera del wrapper "mcpServers"),
// lo cual hace que mcp_utils.js NO los cargue. Este script hace el merge
// correctamente para que los MCPs realmente funcionen.
//
// Uso:
//   node scripts/install-mcp.js                  # instala todos los servers
//   node scripts/install-mcp.js --only firecrawl,slack   # instala solo algunos
//   node scripts/install-mcp.js --scope project   # escribe en ./.agentlag/mcp.json
//   node scripts/install-mcp.js --prefix          # agrega prefijo "autonomous-ops__"
//   node scripts/install-mcp.js --dry-run         # muestra qué haría sin escribir
//   node scripts/install-mcp.js --list            # lista servers disponibles
//
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, '..');
const MCP_REF_FILE = path.join(PLUGIN_ROOT, 'mcp', 'mcp-servers.json');

const argv = process.argv.slice(2);

function parseFlag(name) {
  const idx = argv.indexOf(name);
  if (idx === -1) return null;
  const val = argv[idx + 1];
  return val;
}

const onlyArg = parseFlag('--only');
const scopeArg = parseFlag('--scope');
const dryRun = argv.includes('--dry-run');
const listMode = argv.includes('--list');
const usePrefix = argv.includes('--prefix');

const PLUGIN_NAME = 'autonomous-ops';

// ── Resolver archivo mcp.json destino ─────────────────────────────────────────
function resolveTargetFile(scope) {
  if (scope === 'project') {
    return path.join(process.cwd(), '.agentlag', 'mcp.json');
  }
  return path.join(os.homedir(), '.agentlag', 'mcp.json');
}

// ── Cargar referencia de MCP servers ──────────────────────────────────────────
function loadMcpReference() {
  if (!fs.existsSync(MCP_REF_FILE)) {
    console.error(`❌ No se encontró ${MCP_REF_FILE}`);
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(MCP_REF_FILE, 'utf-8'));
  return raw.mcpServers || {};
}

// ── Limpiar propiedades metadata (_) del server config ────────────────────────
function cleanServerConfig(config) {
  const cleaned = {};
  for (const [key, value] of Object.entries(config)) {
    if (key.startsWith('_')) continue; // skip metadata
    cleaned[key] = value;
  }
  return cleaned;
}

// ── Listar servers disponibles ────────────────────────────────────────────────
if (listMode) {
  const servers = loadMcpReference();
  console.log('🔌 Servidores MCP disponibles en el plugin autonomous-ops:\n');
  for (const [name, config] of Object.entries(servers)) {
    const usage = config._usage || '';
    const optional = config._optional ? ' [opcional]' : '';
    const cmd = `${config.command} ${(config.args || []).join(' ')}`;
    console.log(`  • ${name}${optional}`);
    console.log(`      cmd: ${cmd}`);
    if (usage) console.log(`      uso:  ${usage}`);
  }
  console.log(`\nTotal: ${Object.keys(servers).length} servidor(es).`);
  console.log('\nPara instalar: node scripts/install-mcp.js [--only name1,name2] [--scope user|project] [--prefix]');
  process.exit(0);
}

// ── Instalación ───────────────────────────────────────────────────────────────
const allServers = loadMcpReference();
const onlyList = onlyArg ? onlyArg.split(',').map(s => s.trim()).filter(Boolean) : null;
const serversToInstall = onlyList
  ? Object.fromEntries(Object.entries(allServers).filter(([name]) => onlyList.includes(name)))
  : allServers;

if (onlyList) {
  const missing = onlyList.filter(n => !allServers[n]);
  if (missing.length > 0) {
    console.error(`❌ Servers no encontrados: ${missing.join(', ')}`);
    console.error(`   Disponibles: ${Object.keys(allServers).join(', ')}`);
    process.exit(1);
  }
}

const scope = scopeArg === 'project' ? 'project' : 'user';
const targetFile = resolveTargetFile(scope);

// Cargar config existente (o crear vacía con estructura correcta)
let existingConfig = { mcpServers: {} };
if (fs.existsSync(targetFile)) {
  try {
    const raw = JSON.parse(fs.readFileSync(targetFile, 'utf-8'));
    if (raw && typeof raw === 'object' && raw.mcpServers && typeof raw.mcpServers === 'object') {
      existingConfig = raw;
    } else {
      // El archivo existe pero no tiene la estructura { mcpServers: {...} }
      // Podría ser el caso del bug de plugin_engine.js (keys a top-level).
      // Preservamos esas keys migrándolas al wrapper mcpServers.
      console.warn(`⚠️  ${targetFile} no tiene la estructura { mcpServers: {...} }.`);
      console.warn(`   Migrando keys top-level al wrapper mcpServers (esto es seguro).\n`);
      existingConfig = { mcpServers: {} };
      for (const [key, value] of Object.entries(raw)) {
        if (key === 'mcpServers') continue;
        if (value && typeof value === 'object' && (value.command || value.url)) {
          existingConfig.mcpServers[key] = value;
        }
      }
    }
  } catch (e) {
    console.warn(`⚠️  Error parseando ${targetFile}: ${e.message}. Se creará uno nuevo.`);
    existingConfig = { mcpServers: {} };
  }
}

// Aplicar merge
const prefix = usePrefix ? `${PLUGIN_NAME}__` : '';
let added = 0;
let overwritten = 0;
const changes = [];

for (const [name, config] of Object.entries(serversToInstall)) {
  const cleanConfig = cleanServerConfig(config);
  const key = `${prefix}${name}`;
  const wasPresent = Object.prototype.hasOwnProperty.call(existingConfig.mcpServers, key);
  existingConfig.mcpServers[key] = cleanConfig;
  if (wasPresent) overwritten++;
  else added++;
  changes.push({ key, action: wasPresent ? 'overwritten' : 'added', cmd: `${cleanConfig.command} ${(cleanConfig.args || []).join(' ')}` });
}

// Mostrar cambios
console.log(`\n📦 Plugin: ${PLUGIN_NAME}`);
console.log(`🎯 Scope:  ${scope} → ${targetFile}`);
console.log(`🔑 Prefix: ${usePrefix ? `sí (${prefix})` : 'no'}\n`);
console.log('Cambios:');
for (const c of changes) {
  const icon = c.action === 'added' ? '➕' : '♻️';
  console.log(`  ${icon} ${c.key}  [${c.action}]`);
  console.log(`      ${c.cmd}`);
}
console.log(`\nResumen: ${added} nuevos, ${overwritten} sobrescritos, ${changes.length} total.`);

if (dryRun) {
  console.log('\n🟡 Dry-run activo: no se escribió ningún archivo.');
  process.exit(0);
}

// Escribir
fs.mkdirSync(path.dirname(targetFile), { recursive: true });
fs.writeFileSync(targetFile, JSON.stringify(existingConfig, null, 2) + '\n', 'utf-8');
console.log(`\n✅ Configuración MCP escrita en: ${targetFile}`);
console.log('\n📋 Próximos pasos:');
console.log('   1. Edita el archivo y reemplaza los placeholders REEMPLAZAR_CON_* con tus keys reales.');
console.log('   2. (Opcional) Exporta las mismas variables en tu shell para que npx las herede.');
console.log('   3. Reinicia AgentLag para que cargue los nuevos servers.');
console.log('   4. Verifica con: agentlag mcp list');
