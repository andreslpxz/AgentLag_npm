import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("memory entries include timestamps, project, context, and expiration", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentlag-memory-"));
  process.env.AGENTLAG_MEMORY_FILE = path.join(dir, "memory.json");
  const memory = await import(`../memory_utils.js?case=${Date.now()}`);

  memory.addToMemory("framework", "Express", {
    project: "api",
    context: "detected from package.json",
    ttlDays: 1,
  });

  const raw = JSON.parse(await fs.readFile(process.env.AGENTLAG_MEMORY_FILE, "utf8"));
  assert.equal(raw.version, 2);
  assert.equal(raw.entries.framework.value, "Express");
  assert.equal(raw.entries.framework.project, "api");
  assert.equal(raw.entries.framework.context, "detected from package.json");
  assert.match(raw.entries.framework.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(raw.entries.framework.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(raw.entries.framework.expiresAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(memory.listMemory(), /framework: Express \(project=api/);
});

test("legacy flat memory is normalized without losing values", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentlag-memory-"));
  process.env.AGENTLAG_MEMORY_FILE = path.join(dir, "memory.json");
  await fs.writeFile(process.env.AGENTLAG_MEMORY_FILE, JSON.stringify({ editor: "vim" }), "utf8");
  const memory = await import(`../memory_utils.js?case=${Date.now()}`);

  assert.equal(memory.getFromMemory("editor"), "vim");
  assert.match(memory.listMemory(), /editor: vim \(project=legacy/);
});
