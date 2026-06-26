import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clearSkillsCache, listInstalledSkills } from "../skills.js";

async function writeSkill(root, name, description) {
  const dir = path.join(root, ".agents", "skills", name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${description}\n`,
    "utf8"
  );
}

test("listInstalledSkills caches disk reads until cache is cleared", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agentlag-skills-"));
  await writeSkill(cwd, "first", "first skill");

  const first = listInstalledSkills({ cwd });
  assert.deepEqual(first.filter(s => s.scope !== 'registry').map(skill => skill.name), ["first"]);

  await writeSkill(cwd, "second", "second skill");
  const cached = listInstalledSkills({ cwd });
  assert.deepEqual(cached.filter(s => s.scope !== 'registry').map(skill => skill.name), ["first"]);

  clearSkillsCache();
  const refreshed = listInstalledSkills({ cwd });
  assert.deepEqual(refreshed.filter(s => s.scope !== 'registry').map(skill => skill.name), ["first", "second"]);
});
