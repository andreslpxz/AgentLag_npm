import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { tools } from "../tools.js";

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
