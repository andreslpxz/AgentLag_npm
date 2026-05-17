import fs from "fs";
import path from "path";
import os from "os";

const MAX_SKILL_CHARS = 2500;
const STOPWORDS = new Set([
  "para", "con", "una", "uno", "las", "los", "del", "que", "como", "cómo",
  "the", "and", "for", "with", "that", "this", "when", "user", "users",
  "skill", "skills", "agent", "helps", "help",
]);

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function tokenize(value) {
  return normalizeText(value)
    .split(/[^a-z0-9]+/i)
    .filter(token => token.length >= 3 && !STOPWORDS.has(token));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function skillRoots(cwd = process.cwd()) {
  return unique([
    path.join(cwd, ".agents", "skills"),
    path.join(os.homedir(), ".agents", "skills"),
  ]);
}

function parseSkillMarkdown(content, fallbackName) {
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---\n?/);
  const meta = {};
  if (frontmatter) {
    for (const line of frontmatter[1].split("\n")) {
      const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (match) meta[match[1]] = match[2].replace(/^['"]|['"]$/g, "").trim();
    }
  }
  return {
    name: meta.name || fallbackName,
    description: meta.description || "",
  };
}

export function listInstalledSkills({ includeContent = false, cwd = process.cwd() } = {}) {
  const found = [];
  const seen = new Set();

  for (const root of skillRoots(cwd)) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      let skillPath = path.join(root, entry.name, "SKILL.md");
      let content = "";
      try {
        content = fs.readFileSync(skillPath, "utf8");
      } catch {
        try {
          const nested = fs.readdirSync(path.join(root, entry.name), { withFileTypes: true });
          for (const child of nested) {
            if (!child.isDirectory()) continue;
            const nestedPath = path.join(root, entry.name, child.name, "SKILL.md");
            try {
              content = fs.readFileSync(nestedPath, "utf8");
              skillPath = nestedPath;
              break;
            } catch {}
          }
        } catch {}
        if (!content) continue;
      }

      const meta = parseSkillMarkdown(content, entry.name);
      const key = normalizeText(meta.name);
      if (seen.has(key)) continue;
      seen.add(key);

      const scope = root === path.join(cwd, ".agents", "skills") ? "project" : "global";
      found.push({
        name: meta.name,
        description: meta.description,
        path: skillPath,
        scope,
        ...(includeContent ? { content } : {}),
      });
    }
  }

  return found.sort((a, b) => a.name.localeCompare(b.name));
}

export function readSkill(name, cwd = process.cwd()) {
  const wanted = normalizeText(name);
  const skills = listInstalledSkills({ includeContent: true, cwd });
  const exact = skills.find(skill => normalizeText(skill.name) === wanted);
  const partial = skills.find(skill => normalizeText(skill.name).includes(wanted));
  return exact || partial || null;
}

function scoreSkillForMessage(skill, message) {
  const normalizedMessage = normalizeText(message);
  const normalizedName = normalizeText(skill.name);

  if (normalizedName && normalizedMessage.includes(normalizedName)) return 100;

  if (normalizedName === "find-skills") {
    const discoveryIntent =
      /\b(necesito algo|busca|buscar|encuentra|encontrar|instala|instalar|skill|skills|habilidad|extension|extensión)\b/.test(normalizedMessage) ||
      /\b(como|cómo)\s+(hago|puedo|hacer)\b/.test(normalizedMessage) ||
      /\b(can you|how do i|find a skill|is there a skill)\b/.test(normalizedMessage);
    if (discoveryIntent) return 95;
  }

  if (normalizedMessage.includes('mis skills') || normalizedMessage.includes('tus skills') || normalizedMessage.includes('que puedes hacer')) {
     if (normalizedName === 'find-skills') return 90;
  }

  const messageTokens = new Set(tokenize(message));
  const skillTokens = unique([...tokenize(skill.name), ...tokenize(skill.description)]);
  let score = 0;
  for (const token of skillTokens) {
    if (messageTokens.has(token)) score += 15;
  }

  const descriptionKeywords = tokenize(skill.description);
  for (const kw of descriptionKeywords) {
      if (normalizedMessage.includes(kw)) score += 5;
  }

  return score;
}

export function selectSkillsForMessage(message, { cwd = process.cwd(), limit = 3 } = {}) {
  return listInstalledSkills({ includeContent: true, cwd })
    .map(skill => ({ skill, score: scoreSkillForMessage(skill, message) }))
    .filter(item => item.score > 15)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(item => item.skill);
}

export function formatSkillsIndex(cwd = process.cwd()) {
  const skills = listInstalledSkills({ cwd });
  if (skills.length === 0) {
    return "No hay skills instaladas todavía. Puedes buscar en skills.sh con find_skills o instalar con add_skill.";
  }

  return skills
    .map(skill => `- ${skill.name} (${skill.scope}) → ${skill.description || "sin descripción"}\n  ${skill.path}`)
    .join("\n");
}

export function buildSkillContextForMessage(message, cwd = process.cwd()) {
  const selected = selectSkillsForMessage(message, { cwd });
  if (selected.length === 0) return null;

  const blocks = selected.map(skill => {
    const content = skill.content.length > MAX_SKILL_CHARS
      ? `${skill.content.slice(0, MAX_SKILL_CHARS)}\n\n[SKILL.md truncado: usa read_skill si necesitas el resto.]`
      : skill.content;
    return `<skill name="${skill.name}" scope="${skill.scope}" path="${skill.path}">\n${content}\n</skill>`;
  });

  return [
    "Skills activadas para esta petición. Sigue estrictamente estas instrucciones antes de responder o usar herramientas.",
    ...blocks,
  ].join("\n\n");
}
