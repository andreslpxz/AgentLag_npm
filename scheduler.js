import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import os from 'os';

const SCHEDULES_FILE = path.join(os.homedir(), '.agentlag', 'schedules.json');

export class Scheduler {
    constructor(agentRunner) {
        this.agentRunner = agentRunner;
        this.tasks = new Map();
        this.loadSchedules();
    }

    loadSchedules() {
        try {
            if (fs.existsSync(SCHEDULES_FILE)) {
                const data = JSON.parse(fs.readFileSync(SCHEDULES_FILE, 'utf8'));
                for (const item of data) {
                    this.scheduleTask(item.id, item.cronExp, item.prompt, false);
                }
            }
        } catch (error) {
            console.error('Error loading schedules:', error);
        }
    }

    saveSchedules() {
        try {
            const data = Array.from(this.tasks.values()).map(t => ({
                id: t.id,
                cronExp: t.cronExp,
                prompt: t.prompt
            }));
            const dir = path.dirname(SCHEDULES_FILE);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(data, null, 2));
        } catch (error) {
            console.error('Error saving schedules:', error);
        }
    }

    scheduleTask(id, cronExp, prompt, save = true) {
        if (this.tasks.has(id)) {
            this.tasks.get(id).cronJob.stop();
        }

        const cronJob = cron.schedule(cronExp, async () => {
            console.log(`[Scheduler] Running task ${id}: ${prompt}`);
            try {
                await this.agentRunner(prompt);
            } catch (error) {
                console.error(`[Scheduler] Error in task ${id}:`, error);
            }
        });

        this.tasks.set(id, { id, cronExp, prompt, cronJob });
        if (save) this.saveSchedules();
        return id;
    }

    removeTask(id) {
        if (this.tasks.has(id)) {
            this.tasks.get(id).cronJob.stop();
            this.tasks.delete(id);
            this.saveSchedules();
            return true;
        }
        return false;
    }

    listTasks() {
        return Array.from(this.tasks.values()).map(t => ({
            id: t.id,
            cronExp: t.cronExp,
            prompt: t.prompt
        }));
    }
}
