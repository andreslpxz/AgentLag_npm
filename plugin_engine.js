// ─── plugin_engine.js ──────────────────────────────────────────────────────────
// Complete plugin system for AgentLag: install, uninstall, list, search,
// activate/deactivate plugins, and format active plugins for the LLM prompt.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { runCommand } from './utils.js';

// ── Paths ──────────────────────────────────────────────────────────────────────

const CONFIG_DIR = path.join(os.homedir(), '.agentlag');
const AGENTS_DIR = path.join(CONFIG_DIR, 'agents');
const PLUGINS_DIR = path.join(CONFIG_DIR, 'plugins');
const PLUGINS_INSTALLED_DIR = path.join(PLUGINS_DIR, 'installed');
const MCP_FILE = path.join(CONFIG_DIR, 'mcp.json');
const MARKETPLACE_FILE = path.join(PLUGINS_DIR, 'marketplace.json');
const MARKETPLACE_URL =
  'https://raw.githubusercontent.com/andreslpxz/agentlag-plugins/main/index.json';

// ── Internal helpers ───────────────────────────────────────────────────────────

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

/**
 * Recursively copy a file or directory from src to dest.
 */
function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    ensureDir(dest);
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    ensureDir(path.dirname(dest));
    fs.copyFileSync(src, dest);
  }
}

/**
 * Remove a file or directory recursively.
 */
function rmRecursive(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    // already gone
  }
}

/**
 * Determine the GitHub clone URL from various source formats.
 * Returns null if the source does not look like a GitHub reference.
 */
function parseSource(source) {
  const trimmed = source.trim();

  // GitHub shorthand: "owner/repo"
  if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(trimmed)) {
    return { type: 'github', url: `https://github.com/${trimmed}.git` };
  }

  // Full GitHub URL (with or without .git)
  if (/^https?:\/\/github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+/.test(trimmed)) {
    const url = trimmed.endsWith('.git') ? trimmed : trimmed + '.git';
    return { type: 'github', url };
  }

  // Local path
  return { type: 'local', path: path.resolve(trimmed) };
}

/**
 * Validate that a plugin manifest has the required fields.
 */
function validateManifest(manifest) {
  const required = ['name', 'version'];
  for (const field of required) {
    if (!manifest[field]) {
      return `plugin.json is missing required field: "${field}"`;
    }
  }
  if (typeof manifest.name !== 'string' || /[^a-zA-Z0-9_.-]/.test(manifest.name)) {
    return 'plugin.json "name" must be a simple alphanumeric identifier (letters, digits, _, -, .)';
  }
  return null;
}

/**
 * Read and merge the existing mcp.json, then write it back.
 */
function readMcpConfig() {
  return readJson(MCP_FILE, {});
}

function writeMcpConfig(config) {
  writeJson(MCP_FILE, config);
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Install a plugin from a GitHub shorthand, URL, or local path.
 *
 * @param {string} source  - "owner/repo" | "https://github.com/..." | "/local/path"
 * @param {{ ctx?: object }} options
 * @returns {Promise<{ ok: boolean, plugin?: object, error?: string }>}
 */
export async function installPlugin(source, { ctx } = {}) {
  try {
    ensureDir(PLUGINS_DIR);
    ensureDir(PLUGINS_INSTALLED_DIR);
    ensureDir(AGENTS_DIR);

    // ── 1. Resolve source → temp directory with plugin files ─────────────────
    const parsed = parseSource(source);
    let pluginDir; // directory that contains plugin.json

    if (parsed.type === 'github') {
      const tmpBase = path.join(os.tmpdir(), 'agentlag-plugin-install');
      const tmpDir = fs.mkdtempSync(tmpBase);
      const result = await runCommand('git', ['clone', '--depth', '1', parsed.url, tmpDir]);
      if (!result.ok) {
        rmRecursive(tmpDir);
        return { ok: false, error: `git clone failed: ${result.output}` };
      }
      pluginDir = tmpDir;
    } else {
      // local path – plugin.json must exist directly inside
      pluginDir = parsed.path;
      if (!fs.existsSync(pluginDir)) {
        return { ok: false, error: `Local path does not exist: ${pluginDir}` };
      }
    }

    // ── 2. Read and validate plugin.json ────────────────────────────────────
    const manifestPath = path.join(pluginDir, 'plugin.json');
    if (!fs.existsSync(manifestPath)) {
      if (parsed.type === 'github') rmRecursive(pluginDir);
      return { ok: false, error: `plugin.json not found in ${pluginDir}` };
    }

    const manifest = readJson(manifestPath);
    const validationError = validateManifest(manifest);
    if (validationError) {
      if (parsed.type === 'github') rmRecursive(pluginDir);
      return { ok: false, error: validationError };
    }

    const pluginName = manifest.name;

    // ── 3. Copy agents (prefixed with plugin name) ─────────────────────────
    const agents = manifest.agents || [];
    for (const agent of agents) {
      const srcFile = path.join(pluginDir, agent.file);
      if (!fs.existsSync(srcFile)) continue;
      const destName = `${pluginName}__${path.basename(agent.file)}`;
      const destFile = path.join(AGENTS_DIR, destName);
      copyRecursive(srcFile, destFile);
    }

    // ── 4. Copy skills ─────────────────────────────────────────────────────
    const skillsDir = path.join(PLUGINS_INSTALLED_DIR, pluginName, 'skills');
    const skills = manifest.skills || [];
    for (const skill of skills) {
      const srcFile = path.join(pluginDir, skill.file);
      if (!fs.existsSync(srcFile)) continue;
      const destFile = path.join(skillsDir, skill.file);
      copyRecursive(srcFile, destFile);
    }

    // ── 5. Copy commands ───────────────────────────────────────────────────
    const commandsDir = path.join(PLUGINS_INSTALLED_DIR, pluginName, 'commands');
    const commands = manifest.commands || [];
    for (const cmd of commands) {
      const srcFile = path.join(pluginDir, cmd.handler);
      if (!fs.existsSync(srcFile)) continue;
      const destFile = path.join(commandsDir, cmd.handler);
      copyRecursive(srcFile, destFile);
    }

    // ── 6. Merge MCP servers ───────────────────────────────────────────────
    const mcpServers = manifest.mcpServers || {};
    if (Object.keys(mcpServers).length > 0) {
      const mcpConfig = readMcpConfig();
      for (const [serverName, serverConfig] of Object.entries(mcpServers)) {
        const key = `${pluginName}__${serverName}`;
        mcpConfig[key] = serverConfig;
      }
      writeMcpConfig(mcpConfig);
    }

    // ── 7. Save plugin metadata ────────────────────────────────────────────
    const metadata = {
      name: pluginName,
      version: manifest.version,
      description: manifest.description || '',
      author: manifest.author || '',
      repository: manifest.repository || source,
      installedAt: new Date().toISOString(),
      active: true,
      agents: agents.map(a => ({
        name: a.name,
        description: a.description || '',
        file: a.file,
        prefixedFile: `${pluginName}__${path.basename(a.file)}`,
      })),
      skills: skills.map(s => ({
        name: s.name,
        description: s.description || '',
        file: s.file,
      })),
      mcpServers: Object.keys(mcpServers).map(name => ({
        name,
        prefixedKey: `${pluginName}__${name}`,
      })),
      commands: commands.map(c => ({
        cmd: c.cmd,
        description: c.description || '',
        handler: c.handler,
      })),
    };

    writeJson(path.join(PLUGINS_DIR, `${pluginName}.json`), metadata);

    // ── 8. Clean up temp dir (only for git clones) ─────────────────────────
    if (parsed.type === 'github') {
      rmRecursive(pluginDir);
    }

    return { ok: true, plugin: metadata };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Uninstall a plugin by name.
 *
 * @param {string} name
 * @param {{ ctx?: object }} options
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function uninstallPlugin(name, { ctx } = {}) {
  try {
    const metaPath = path.join(PLUGINS_DIR, `${name}.json`);
    const meta = readJson(metaPath);
    if (!meta) {
      return { ok: false, error: `Plugin "${name}" is not installed.` };
    }

    // ── 1. Remove agents with the plugin prefix ────────────────────────────
    const prefix = `${name}__`;
    if (fs.existsSync(AGENTS_DIR)) {
      for (const file of fs.readdirSync(AGENTS_DIR)) {
        if (file.startsWith(prefix)) {
          rmRecursive(path.join(AGENTS_DIR, file));
        }
      }
    }

    // ── 2. Remove MCP servers with the plugin prefix ───────────────────────
    const mcpConfig = readMcpConfig();
    let mcpChanged = false;
    for (const key of Object.keys(mcpConfig)) {
      if (key.startsWith(prefix)) {
        delete mcpConfig[key];
        mcpChanged = true;
      }
    }
    if (mcpChanged) {
      writeMcpConfig(mcpConfig);
    }

    // ── 3. Remove plugin installed directory ───────────────────────────────
    rmRecursive(path.join(PLUGINS_INSTALLED_DIR, name));

    // ── 4. Remove plugin metadata ──────────────────────────────────────────
    rmRecursive(metaPath);

    // ── 5. Clear skills cache (imported from skills.js if available) ───────
    try {
      const { clearSkillsCache } = await import('./skills.js');
      clearSkillsCache();
    } catch {
      // skills module not available — ignore
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * List all installed plugins.
 *
 * @returns {Array<object>} Array of plugin metadata with `installed: true`.
 */
export function listPlugins() {
  ensureDir(PLUGINS_DIR);
  const files = fs.readdirSync(PLUGINS_DIR).filter(
    f => f.endsWith('.json') && f !== 'marketplace.json'
  );
  return files.map(f => {
    const meta = readJson(path.join(PLUGINS_DIR, f), {});
    return { ...meta, installed: true };
  });
}

/**
 * Get only the active (enabled) installed plugins.
 *
 * @returns {Array<object>}
 */
export function getActivePlugins() {
  return listPlugins().filter(p => p.active === true);
}

/**
 * Get the agent definitions for a specific installed plugin.
 *
 * @param {string} name  - Plugin name
 * @returns {Array<object>}
 */
export function getPluginAgents(name) {
  const meta = readJson(path.join(PLUGINS_DIR, `${name}.json`));
  if (!meta) return [];
  return meta.agents || [];
}

/**
 * Get the skill objects for a specific installed plugin by scanning its skills dir.
 *
 * @param {string} name  - Plugin name
 * @param {string} [cwd] - Working directory (unused by plugin skills, accepted for API consistency)
 * @returns {Array<object>}
 */
export function getPluginSkills(name, cwd) {
  const meta = readJson(path.join(PLUGINS_DIR, `${name}.json`));
  if (!meta) return [];

  const skillsBaseDir = path.join(PLUGINS_INSTALLED_DIR, name, 'skills');
  const skills = [];

  for (const skillDef of (meta.skills || [])) {
    const skillFile = path.join(skillsBaseDir, skillDef.file);
    if (!fs.existsSync(skillFile)) continue;

    const stat = fs.statSync(skillFile);
    // Only include SKILL.md files (or any .md in a skill directory)
    if (stat.isFile() && skillFile.endsWith('.md')) {
      try {
        const content = fs.readFileSync(skillFile, 'utf-8');
        skills.push({
          name: skillDef.name,
          description: skillDef.description || '',
          file: skillDef.file,
          absPath: skillFile,
          content,
        });
      } catch {
        // skip unreadable files
      }
    } else if (stat.isDirectory()) {
      // Skill is a directory — look for SKILL.md inside
      const skillMd = path.join(skillFile, 'SKILL.md');
      if (fs.existsSync(skillMd)) {
        try {
          const content = fs.readFileSync(skillMd, 'utf-8');
          skills.push({
            name: skillDef.name,
            description: skillDef.description || '',
            file: skillDef.file,
            absPath: skillMd,
            content,
          });
        } catch {
          // skip
        }
      }
    }
  }

  return skills;
}

/**
 * Get the MCP server configs registered by a specific plugin.
 *
 * @param {string} name - Plugin name
 * @returns {object}  Map of prefixed key → server config
 */
export function getPluginMcpServers(name) {
  const meta = readJson(path.join(PLUGINS_DIR, `${name}.json`));
  if (!meta) return {};

  const mcpConfig = readMcpConfig();
  const prefix = `${name}__`;
  const result = {};

  for (const [key, config] of Object.entries(mcpConfig)) {
    if (key.startsWith(prefix)) {
      result[key] = config;
    }
  }

  return result;
}

/**
 * Get the command definitions for a plugin.
 *
 * @param {string} name - Plugin name
 * @returns {Array<object>}
 */
export function getPluginCommands(name) {
  const meta = readJson(path.join(PLUGINS_DIR, `${name}.json`));
  if (!meta) return [];
  return meta.commands || [];
}

/**
 * Activate a plugin (set `active: true` in its metadata).
 *
 * @param {string} name - Plugin name
 * @returns {object|null} Updated plugin metadata, or null if not found.
 */
export function activatePlugin(name) {
  const metaPath = path.join(PLUGINS_DIR, `${name}.json`);
  const meta = readJson(metaPath);
  if (!meta) return null;
  meta.active = true;
  writeJson(metaPath, meta);
  return meta;
}

/**
 * Deactivate a plugin (set `active: false` in its metadata).
 *
 * @param {string} name - Plugin name
 * @returns {object|null} Updated plugin metadata, or null if not found.
 */
export function deactivatePlugin(name) {
  const metaPath = path.join(PLUGINS_DIR, `${name}.json`);
  const meta = readJson(metaPath);
  if (!meta) return null;
  meta.active = false;
  writeJson(metaPath, meta);
  return meta;
}

/**
 * Fetch (or return cached) marketplace index.
 *
 * @returns {Promise<Array<object>>}
 */
export async function refreshMarketplaceIndex() {
  ensureDir(PLUGINS_DIR);

  // Try fetching from remote
  try {
    const res = await fetch(MARKETPLACE_URL, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const data = await res.json();
      writeJson(MARKETPLACE_FILE, data);
      return data;
    }
  } catch {
    // fetch failed — fall through to cache
  }

  // Return cached version
  const cached = readJson(MARKETPLACE_FILE, []);
  return Array.isArray(cached) ? cached : [];
}

/**
 * Search the marketplace for plugins matching a query.
 *
 * @param {string} query
 * @returns {Promise<Array<object>>}
 */
export async function searchMarketplace(query) {
  const index = await refreshMarketplaceIndex();
  const q = query.toLowerCase().split(/[\s-_]+/).filter(Boolean);

  return index.filter(plugin => {
    const searchable = [
      plugin.name,
      plugin.description,
      plugin.author,
      ...(plugin.tags || []),
    ]
      .join(' ')
      .toLowerCase();
    return q.every(term => searchable.includes(term));
  });
}

/**
 * Get full metadata for an installed plugin.
 *
 * @param {string} name - Plugin name
 * @returns {object|null}
 */
export function getPluginInfo(name) {
  const meta = readJson(path.join(PLUGINS_DIR, `${name}.json`));
  return meta || null;
}

/**
 * Format all active plugins into a string suitable for inclusion in the
 * system prompt. Lists agents, skills, and MCP servers provided by each plugin.
 *
 * @param {string} [cwd] - Working directory (forwarded to getPluginSkills)
 * @returns {string}
 */
export function formatPluginListForPrompt(cwd) {
  const active = getActivePlugins();
  if (active.length === 0) return '';

  const sections = [];

  for (const plugin of active) {
    const lines = [];
    lines.push(`### Plugin: ${plugin.name} (v${plugin.version})`);
    if (plugin.description) lines.push(`> ${plugin.description}`);

    // Agents
    const agents = plugin.agents || [];
    if (agents.length > 0) {
      lines.push('');
      lines.push('**Agents:**');
      for (const a of agents) {
        lines.push(`- \`${a.name}\`: ${a.description || 'No description'}`);
      }
    }

    // Skills
    const skills = getPluginSkills(plugin.name, cwd);
    if (skills.length > 0) {
      lines.push('');
      lines.push('**Skills:**');
      for (const s of skills) {
        lines.push(`- \`${s.name}\`: ${s.description || 'No description'}`);
      }
    }

    // MCP Servers
    const mcpServers = getPluginMcpServers(plugin.name);
    const mcpKeys = Object.keys(mcpServers);
    if (mcpKeys.length > 0) {
      lines.push('');
      lines.push('**MCP Servers:**');
      for (const key of mcpKeys) {
        const srv = mcpServers[key];
        const cmd = srv.command || 'unknown';
        lines.push(`- \`${key}\`: ${cmd}`);
      }
    }

    // Commands
    const cmds = plugin.commands || [];
    if (cmds.length > 0) {
      lines.push('');
      lines.push('**Commands:**');
      for (const c of cmds) {
        lines.push(`- \`${c.cmd}\`: ${c.description || 'No description'}`);
      }
    }

    sections.push(lines.join('\n'));
  }

  const header = `## Active Plugins (${active.length})`;
  return header + '\n\n' + sections.join('\n\n') + '\n';
}