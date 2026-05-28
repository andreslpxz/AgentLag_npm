import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';

const DB_PATH = path.join(os.homedir(), '.agentlag', 'openspace_skills.db');

// Asegurar que el directorio existe
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
}

const db = new Database(DB_PATH);

// Inicializar esquemas
db.exec(`
  CREATE TABLE IF NOT EXISTS skills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    diff TEXT,
    version_number INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (skill_id) REFERENCES skills (id)
  );

  CREATE TABLE IF NOT EXISTS metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_id INTEGER UNIQUE NOT NULL,
    applied_count INTEGER DEFAULT 0,
    success_count INTEGER DEFAULT 0,
    fail_count INTEGER DEFAULT 0,
    last_used DATETIME,
    FOREIGN KEY (skill_id) REFERENCES skills (id)
  );

  CREATE TABLE IF NOT EXISTS task_recordings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_query TEXT NOT NULL,
    recording_json TEXT NOT NULL,
    status TEXT, -- 'success', 'fail', 'pending'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

export function saveSkill(name, description, content) {
    const upsertSkill = db.prepare(`
        INSERT INTO skills (name, description, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(name) DO UPDATE SET
            description = excluded.description,
            updated_at = CURRENT_TIMESTAMP
    `);

    const info = upsertSkill.run(name, description);
    const skillId = info.lastInsertRowid || db.prepare('SELECT id FROM skills WHERE name = ?').get(name).id;

    // Get latest version number
    const lastVersion = db.prepare('SELECT MAX(version_number) as v FROM versions WHERE skill_id = ?').get(skillId).v || 0;

    db.prepare(`
        INSERT INTO versions (skill_id, content, version_number)
        VALUES (?, ?, ?)
    `).run(skillId, content, lastVersion + 1);

    // Initialize metrics if not exists
    db.prepare(`INSERT OR IGNORE INTO metrics (skill_id) VALUES (?)`).run(skillId);

    return skillId;
}

export function getSkills() {
    return db.prepare(`
        SELECT s.*, v.content, m.applied_count, m.success_count, m.fail_count
        FROM skills s
        JOIN versions v ON v.skill_id = s.id
        LEFT JOIN metrics m ON m.skill_id = s.id
        WHERE v.version_number = (SELECT MAX(version_number) FROM versions WHERE skill_id = s.id)
    `).all();
}

export function saveRecording(taskQuery, recordingData, status = 'pending') {
    return db.prepare(`
        INSERT INTO task_recordings (task_query, recording_json, status)
        VALUES (?, ?, ?)
    `).run(taskQuery, JSON.stringify(recordingData), status).lastInsertRowid;
}

export function updateMetric(skillName, success = true) {
    const skill = db.prepare('SELECT id FROM skills WHERE name = ?').get(skillName);
    if (!skill) return;

    if (success) {
        db.prepare(`UPDATE metrics SET applied_count = applied_count + 1, success_count = success_count + 1, last_used = CURRENT_TIMESTAMP WHERE skill_id = ?`).run(skill.id);
    } else {
        db.prepare(`UPDATE metrics SET applied_count = applied_count + 1, fail_count = fail_count + 1, last_used = CURRENT_TIMESTAMP WHERE skill_id = ?`).run(skill.id);
    }
}

export default db;
