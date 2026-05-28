import fs from 'fs';
import path from 'path';
import { saveRecording as saveToDb } from './skill_registry.js';

const RECORDINGS_DIR = path.join(process.cwd(), 'recordings');

if (!fs.existsSync(RECORDINGS_DIR)) {
    fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
}

export class RecordingSession {
    constructor(taskQuery) {
        this.taskQuery = taskQuery;
        this.startTime = new Date().toISOString();
        this.events = [];
    }

    logInteraction(role, content, metadata = {}) {
        this.events.push({
            timestamp: new Date().toISOString(),
            role,
            content,
            ...metadata
        });
    }

    logToolCall(name, args, result) {
        this.events.push({
            timestamp: new Date().toISOString(),
            type: 'tool_call',
            name,
            args,
            result
        });
    }

    async save(status = 'pending') {
        const data = {
            task: this.taskQuery,
            startTime: this.startTime,
            endTime: new Date().toISOString(),
            status,
            events: this.events
        };

        const fileName = `recording_${Date.now()}.json`;
        const filePath = path.join(RECORDINGS_DIR, fileName);

        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

        // Save to SQLite too
        saveToDb(this.taskQuery, data, status);

        return filePath;
    }
}
