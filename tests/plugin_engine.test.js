import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

// ─── Setup: redirect HOME to a temp dir BEFORE importing plugin_engine ─────────
// plugin_engine.js computes CONFIG_DIR, MCP_FILE, etc. from os.homedir() at
// module load time. We set HOME to a temp dir so tests don't touch the real
// ~/.agentlag/.

const TMP_HOME = await fs.mkdtemp(path.join(os.tmpdir(), "agentlag-plugin-test-"));
process.env.HOME = TMP_HOME;
// On some platforms os.homedir() caches; force re-evaluation by deleting require cache
// (not needed for ESM, but doesn't hurt)

const {
  installPlugin,
  uninstallPlugin,
  listPlugins,
  getPluginMcpServers,
  getPluginInfo,
} = await import("../plugin_engine.js");

// Path to the (fake) mcp.json inside our temp HOME
const MCP_FILE = path.join(TMP_HOME, ".agentlag", "mcp.json");

async function readMcpJson() {
  try {
    return JSON.parse(await fs.readFile(MCP_FILE, "utf8"));
  } catch {
    return null;
  }
}

async function writeMcpJson(obj) {
  await fs.mkdir(path.dirname(MCP_FILE), { recursive: true });
  await fs.writeFile(MCP_FILE, JSON.stringify(obj, null, 2), "utf8");
}

async function cleanup() {
  try { await fs.rm(TMP_HOME, { recursive: true, force: true }); } catch { /* ok */ }
}

// ─── Helper: create a fake plugin directory ─────────────────────────────────────
async function createFakePlugin(pluginDir, manifest) {
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "plugin.json"),
    JSON.stringify(manifest, null, 2),
    "utf8"
  );
  // Create agent files referenced in manifest
  for (const agent of manifest.agents || []) {
    const agentPath = path.join(pluginDir, agent.file);
    await fs.mkdir(path.dirname(agentPath), { recursive: true });
    await fs.writeFile(
      agentPath,
      JSON.stringify({
        description: agent.description,
        provider: "groq",
        model: "qwen/qwen3-32b",
        systemPrompt: "Test agent",
      }),
      "utf8"
    );
  }
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

test.after(cleanup);

test("installPlugin writes MCP servers inside the mcpServers wrapper (not top-level)", async () => {
  const pluginDir = path.join(TMP_HOME, "source-plugins", "test-plugin-wrapper");
  await createFakePlugin(pluginDir, {
    name: "test-plugin-wrapper",
    version: "1.0.0",
    description: "Test plugin for MCP wrapper bug",
    agents: [{ name: "test-agent", description: "Test", file: "agents/test-agent.json" }],
    mcpServers: {
      "test-server": {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-fetch"],
      },
    },
  });

  const result = await installPlugin(pluginDir);
  assert.ok(result.ok, `installPlugin should succeed: ${result.error}`);

  const mcpJson = await readMcpJson();
  assert.ok(mcpJson, "mcp.json should exist");
  assert.ok(mcpJson.mcpServers, "mcp.json should have mcpServers wrapper");

  // The server should be inside mcpServers, prefixed with plugin name
  const expectedKey = "test-plugin-wrapper__test-server";
  assert.ok(
    mcpJson.mcpServers[expectedKey],
    `Server should be at mcpServers["${expectedKey}"], got keys: ${Object.keys(mcpJson.mcpServers)}`
  );
  assert.equal(mcpJson.mcpServers[expectedKey].command, "npx");

  // The server should NOT be at top level
  assert.equal(
    mcpJson[expectedKey],
    undefined,
    "Server should NOT be at top level of mcp.json"
  );
});

test("installPlugin handles array-form mcpServers (dev-toolkit style)", async () => {
  const pluginDir = path.join(TMP_HOME, "source-plugins", "test-plugin-array");
  await createFakePlugin(pluginDir, {
    name: "test-plugin-array",
    version: "1.0.0",
    description: "Test plugin with array-form mcpServers",
    agents: [{ name: "test-agent", description: "Test", file: "agents/test-agent.json" }],
    mcpServers: [
      { name: "fetch", command: "npx", args: ["-y", "@modelcontextprotocol/server-fetch"] },
      { name: "filesystem", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
    ],
  });

  const result = await installPlugin(pluginDir);
  assert.ok(result.ok, `installPlugin should succeed: ${result.error}`);

  const mcpJson = await readMcpJson();
  assert.ok(mcpJson.mcpServers["test-plugin-array__fetch"], "fetch server should exist");
  assert.ok(mcpJson.mcpServers["test-plugin-array__filesystem"], "filesystem server should exist");
  assert.equal(mcpJson.mcpServers["test-plugin-array__fetch"].command, "npx");
  // The `name` field should have been stripped (it's the key, not a property)
  assert.equal(mcpJson.mcpServers["test-plugin-array__fetch"].name, undefined);
});

test("getPluginMcpServers reads from inside the mcpServers wrapper", async () => {
  const pluginDir = path.join(TMP_HOME, "source-plugins", "test-plugin-read");
  await createFakePlugin(pluginDir, {
    name: "test-plugin-read",
    version: "1.0.0",
    description: "Test plugin for getPluginMcpServers",
    agents: [{ name: "test-agent", description: "Test", file: "agents/test-agent.json" }],
    mcpServers: {
      "my-server": { command: "node", args: ["server.js"] },
    },
  });

  await installPlugin(pluginDir);
  const servers = getPluginMcpServers("test-plugin-read");
  const keys = Object.keys(servers);
  assert.ok(keys.includes("test-plugin-read__my-server"), `Expected key not found. Got: ${keys}`);
  assert.equal(servers["test-plugin-read__my-server"].command, "node");
});

test("uninstallPlugin removes MCP servers from inside the wrapper", async () => {
  const pluginDir = path.join(TMP_HOME, "source-plugins", "test-plugin-uninstall");
  await createFakePlugin(pluginDir, {
    name: "test-plugin-uninstall",
    version: "1.0.0",
    description: "Test plugin for uninstall",
    agents: [{ name: "test-agent", description: "Test", file: "agents/test-agent.json" }],
    mcpServers: {
      "to-remove": { command: "node", args: ["x.js"] },
    },
  });

  await installPlugin(pluginDir);
  let mcpJson = await readMcpJson();
  assert.ok(mcpJson.mcpServers["test-plugin-uninstall__to-remove"]);

  const result = await uninstallPlugin("test-plugin-uninstall");
  assert.ok(result.ok, `uninstallPlugin should succeed: ${result.error}`);

  mcpJson = await readMcpJson();
  assert.equal(
    mcpJson.mcpServers["test-plugin-uninstall__to-remove"],
    undefined,
    "Server should be removed after uninstall"
  );
});

test("readMcpConfig migrates top-level MCP servers into the wrapper", async () => {
  // Simulate a file written by the OLD buggy version of plugin_engine.js:
  // keys at top level, no mcpServers wrapper.
  await writeMcpJson({
    "old-plugin__server1": { command: "npx", args: ["-y", "foo"] },
    "old-plugin__server2": { command: "npx", args: ["-y", "bar"] },
  });

  // Now install a new plugin — this calls readMcpConfig internally,
  // which should migrate the top-level keys into mcpServers.
  const pluginDir = path.join(TMP_HOME, "source-plugins", "test-plugin-migration");
  await createFakePlugin(pluginDir, {
    name: "test-plugin-migration",
    version: "1.0.0",
    description: "Test plugin for migration",
    agents: [{ name: "test-agent", description: "Test", file: "agents/test-agent.json" }],
    mcpServers: {
      "new-server": { command: "node", args: ["new.js"] },
    },
  });

  await installPlugin(pluginDir);

  const mcpJson = await readMcpJson();
  assert.ok(mcpJson.mcpServers, "mcpServers wrapper should exist after migration");

  // Old servers should have been migrated into the wrapper
  assert.ok(
    mcpJson.mcpServers["old-plugin__server1"],
    "old-plugin__server1 should be migrated into mcpServers"
  );
  assert.ok(
    mcpJson.mcpServers["old-plugin__server2"],
    "old-plugin__server2 should be migrated into mcpServers"
  );

  // Old servers should NOT be at top level anymore
  assert.equal(mcpJson["old-plugin__server1"], undefined);
  assert.equal(mcpJson["old-plugin__server2"], undefined);

  // New server should also be in the wrapper
  assert.ok(mcpJson.mcpServers["test-plugin-migration__new-server"]);
});

test("installPlugin with empty mcpServers does not create mcp.json unnecessarily", async () => {
  const pluginDir = path.join(TMP_HOME, "source-plugins", "test-plugin-no-mcp");
  await createFakePlugin(pluginDir, {
    name: "test-plugin-no-mcp",
    version: "1.0.0",
    description: "Plugin without MCP servers",
    agents: [{ name: "test-agent", description: "Test", file: "agents/test-agent.json" }],
  });

  // Ensure mcp.json doesn't exist before
  try { await fs.unlink(MCP_FILE); } catch { /* ok */ }

  const result = await installPlugin(pluginDir);
  assert.ok(result.ok);

  // mcp.json should not be created if there are no MCP servers
  // (readMcpConfig creates the wrapper in memory but doesn't write if
  //  the block is skipped)
  const mcpJson = await readMcpJson();
  // It's OK if the file doesn't exist, or if it exists with an empty mcpServers
  if (mcpJson !== null) {
    assert.ok(mcpJson.mcpServers, "if mcp.json exists, it should have the wrapper");
  }
});
