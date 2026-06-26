import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { addToMemory, getFromMemory, listMemory } from "../memory_utils.js";

test("memory entries include timestamps, project, context, and expiration", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentlag-memory-"));
  const memoryFile = path.join(dir, "memory.json");

  addToMemory("framework", "Express", {
    memoryFile,
    project: "api",
    context: "detected from package.json",
    ttlDays: 1,
  });

  const raw = JSON.parse(await fs.readFile(memoryFile, "utf8"));
  assert.equal(raw.version, 2);
  assert.equal(raw.entries.framework.value, "Express");
  assert.equal(raw.entries.framework.project, "api");
  assert.equal(raw.entries.framework.context, "detected from package.json");
  assert.match(raw.entries.framework.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(raw.entries.framework.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(raw.entries.framework.expiresAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(listMemory({ memoryFile }), /framework: Express \(project=api/);
});

test("legacy flat memory is normalized without losing values", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentlag-memory-"));
  const memoryFile = path.join(dir, "memory.json");
  await fs.writeFile(memoryFile, JSON.stringify({ editor: "vim" }), "utf8");

  assert.equal(getFromMemory("editor", { memoryFile }), "vim");
  assert.match(listMemory({ memoryFile }), /editor: vim \(project=legacy/);
});
