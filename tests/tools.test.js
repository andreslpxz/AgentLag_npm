import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { tools } from "../tools.js";
import { AGENTS_DIR } from "../session.js";

function toolByName(name) {
  const found = tools.find(item => item.name === name);
  assert.ok(found, `expected tool ${name}`);
  return found;
}

test("edit_file rejects ambiguous replacements", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentlag-tools-"));
  const filePath = path.join(dir, "sample.txt");
  await fs.writeFile(filePath, "same\nother\nsame\n", "utf8");

  const result = await toolByName("edit_file").invoke({
    filePath,
    oldText: "same",
    newText: "changed",
  });

  assert.match(String(result), /Reemplazo ambiguo/);
  assert.equal(await fs.readFile(filePath, "utf8"), "same\nother\nsame\n");
});

test("edit_file returns a diff for unique replacements", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentlag-tools-"));
  const filePath = path.join(dir, "sample.txt");
  await fs.writeFile(filePath, "alpha\nbeta\n", "utf8");

  const result = await toolByName("edit_file").invoke({
    filePath,
    oldText: "beta",
    newText: "gamma",
  });

  assert.match(String(result), /Diff:/);
  assert.match(String(result), /-beta/);
  assert.match(String(result), /\+gamma/);
  assert.equal(await fs.readFile(filePath, "utf8"), "alpha\ngamma\n");
});

test("search_in_files finds literal matches across a directory", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentlag-search-"));
  await fs.writeFile(path.join(dir, "a.js"), "function uniqueNeedle() {}\n", "utf8");
  await fs.writeFile(path.join(dir, "b.txt"), "nothing\n", "utf8");

  const result = await toolByName("search_in_files").invoke({
    pattern: "uniqueNeedle",
    dirPath: dir,
    literal: true,
  });

  assert.match(String(result), /a\.js:1:function uniqueNeedle/);
});

test("search_files was removed to avoid duplicate search tools", () => {
  assert.equal(tools.some(item => item.name === "search_files"), false);
  assert.ok(toolByName("search_in_files"));
});

test("apply_patch applies a unified diff via git apply", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentlag-patch-"));
  const filePath = path.join(dir, "patch.txt");
  await fs.writeFile(filePath, "old\n", "utf8");
  const previousCwd = process.cwd();
  process.chdir(dir);
  try {
    const result = await toolByName("apply_patch").invoke({
      patch: "diff --git a/patch.txt b/patch.txt\n--- a/patch.txt\n+++ b/patch.txt\n@@ -1 +1 @@\n-old\n+new\n",
    });
    assert.match(String(result), /Patch aplicado/);
    assert.equal(await fs.readFile(filePath, "utf8"), "new\n");
  } finally {
    process.chdir(previousCwd);
  }
});

test("web_search falls back when Tavily is not configured", async () => {
  const previousFetch = globalThis.fetch;
  const previousApiKey = process.env.TAVILY_API_KEY;
  delete process.env.TAVILY_API_KEY;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /api\.duckduckgo\.com/);
    return {
      ok: true,
      async json() {
        return {
          AbstractText: "AgentLag fallback result",
          AbstractURL: "https://example.com/agentlag",
          RelatedTopics: [],
        };
      },
    };
  };

  try {
    const result = await toolByName("web_search").invoke({ query: "agentlag" });
    assert.match(String(result), /DuckDuckGo/);
    assert.match(String(result), /AgentLag fallback result/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousApiKey === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = previousApiKey;
  }
});

test("show_diff reports tracked file changes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentlag-diff-"));
  await fs.writeFile(path.join(dir, "file.txt"), "before\n", "utf8");
  await toolByName("run_shell").invoke({ command: `git -C ${dir} init && git -C ${dir} add file.txt && git -C ${dir} -c user.email=a@example.com -c user.name=a commit -m init`, timeoutMs: 30000 });
  await fs.writeFile(path.join(dir, "file.txt"), "after\n", "utf8");

  const previousCwd = process.cwd();
  process.chdir(dir);
  try {
    const result = await toolByName("show_diff").invoke({ filePath: "file.txt" });
    assert.match(String(result), /-before/);
    assert.match(String(result), /\+after/);
  } finally {
    process.chdir(previousCwd);
  }
});

test("run_shell respects configurable timeout", async () => {
  const started = Date.now();
  const result = await toolByName("run_shell").invoke({
    command: "node -e \"setTimeout(()=>{}, 2000)\"",
    timeoutMs: 200,
  });

  assert.match(String(result), /timed out|SIGTERM|Error al ejecutar/i);
  assert.ok(Date.now() - started < 1500);
});

// ─── list_subagents / read_subagent ────────────────────────────────────────────
// Estas tools leen de AGENTS_DIR (~/.agentlag/agents/). Para testear de forma
// determinista creamos dos subagentes de prueba con prefijo "test-" en ese dir,
// los usamos durante los tests y los limpiamos al final. Si el directorio no
// existe, lo creamos (no afecta al behavior normal del agente).

const TEST_AGENT_USER = "test-listsubagents-user";
const TEST_AGENT_PLUGIN = "test-listsubagents-plugin__demo";

async function writeTestAgent(name, def) {
  await fs.mkdir(AGENTS_DIR, { recursive: true });
  await fs.writeFile(
    path.join(AGENTS_DIR, `${name}.json`),
    JSON.stringify(def),
    "utf8"
  );
}

async function cleanupTestAgents() {
  for (const name of [TEST_AGENT_USER, TEST_AGENT_PLUGIN]) {
    try { await fs.unlink(path.join(AGENTS_DIR, `${name}.json`)); } catch { /* ok */ }
  }
}

test("list_subagents and read_subagent are registered as tools", () => {
  assert.ok(toolByName("list_subagents"));
  assert.ok(toolByName("read_subagent"));
});

test("list_subagents returns installed agents including plugin-prefixed ones", async () => {
  await cleanupTestAgents();
  await writeTestAgent(TEST_AGENT_USER, {
    description: "User-defined test agent for list_subagents",
    provider: "groq",
    model: "qwen/qwen3-32b",
    systemPrompt: "You are a test agent.",
    allowedTools: ["read_file", "list_directory"],
  });
  await writeTestAgent(TEST_AGENT_PLUGIN, {
    description: "Plugin-installed test agent",
    provider: "openai",
    model: "gpt-4o",
    systemPrompt: "You are a plugin test agent.",
  });

  try {
    const result = await toolByName("list_subagents").invoke({});
    const out = String(result);

    assert.match(out, /Subagentes disponibles/);
    assert.match(out, new RegExp(TEST_AGENT_USER));
    assert.match(out, new RegExp(TEST_AGENT_PLUGIN));
    assert.match(out, /\[user\]/);
    assert.match(out, /\[plugin: test-listsubagents-plugin\]/);
    // Sanity: debe mencionar el provider y model de al menos uno
    assert.match(out, /groq/);
    assert.match(out, /qwen\/qwen3-32b/);
  } finally {
    await cleanupTestAgents();
  }
});

test("list_subagents handles missing agents directory gracefully", async () => {
  // Backup + remove temporal: si AGENTS_DIR existe, lo movemos a un tmp,
  // invocamos la tool (debe dar mensaje graceful), y restauramos.
  let backupPath = null;
  try {
    await fs.access(AGENTS_DIR);
    backupPath = path.join(os.tmpdir(), `agentlag-agents-backup-${Date.now()}`);
    await fs.rename(AGENTS_DIR, backupPath);
  } catch { /* no existía, nada que respaldar */ }

  try {
    const result = await toolByName("list_subagents").invoke({});
    assert.match(String(result), /No hay subagentes instalados|no existe/i);
  } finally {
    if (backupPath) {
      // Asegura que el dir destino no exista antes de restaurar
      try { await fs.rm(AGENTS_DIR, { recursive: true, force: true }); } catch { /* ok */ }
      await fs.rename(backupPath, AGENTS_DIR);
    }
  }
});

test("read_subagent returns full definition by short name (plugin-prefixed)", async () => {
  await cleanupTestAgents();
  await writeTestAgent(TEST_AGENT_PLUGIN, {
    description: "Plugin demo agent for read_subagent",
    provider: "openai",
    model: "gpt-4o",
    systemPrompt: "Detailed system prompt for the plugin demo agent.",
  });

  try {
    // Buscar por nombre corto "demo" — debe resolver a "test-listsubagents-plugin__demo"
    const result = await toolByName("read_subagent").invoke({ name: "demo" });
    const out = String(result);

    assert.match(out, /Subagente: test-listsubagents-plugin__demo/);
    assert.match(out, /source: plugin/);
    assert.match(out, /plugin: test-listsubagents-plugin/);
    assert.match(out, /provider: openai/);
    assert.match(out, /model: gpt-4o/);
    assert.match(out, /Detailed system prompt for the plugin demo agent\./);
    assert.match(out, /hereda todas las herramientas nativas/);
  } finally {
    await cleanupTestAgents();
  }
});

test("read_subagent returns full definition by fullName", async () => {
  await cleanupTestAgents();
  await writeTestAgent(TEST_AGENT_USER, {
    description: "User agent fullName test",
    provider: "groq",
    model: "qwen/qwen3-32b",
    systemPrompt: "System prompt for fullName lookup test.",
    allowedTools: ["read_file"],
  });

  try {
    const result = await toolByName("read_subagent").invoke({ name: TEST_AGENT_USER });
    const out = String(result);

    assert.match(out, new RegExp(`Subagente: ${TEST_AGENT_USER}`));
    assert.match(out, /source: user/);
    assert.match(out, /provider: groq/);
    assert.match(out, /allowedTools \(1\): read_file/);
    assert.match(out, /System prompt for fullName lookup test\./);
  } finally {
    await cleanupTestAgents();
  }
});

test("read_subagent reports not found for unknown name", async () => {
  const result = await toolByName("read_subagent").invoke({ name: "definitely-not-a-real-agent-xyz123" });
  assert.match(String(result), /no encontrado/i);
  assert.match(String(result), /list_subagents/i);
});
