import { test } from 'node:test';
import assert from 'node:assert';
import { Scheduler } from '../scheduler.js';

test('Scheduler catches invalid cron expression', async (t) => {
    const mockAgentRunner = async (prompt) => ({ messages: [] });
    const scheduler = new Scheduler(mockAgentRunner);

    assert.throws(() => {
        scheduler.scheduleTask('fail-task', 'invalid cron', 'prompt');
    }, /TypeError|Error/);
});

test('Scheduler adds valid cron expression', async (t) => {
    const mockAgentRunner = async (prompt) => ({ messages: [] });
    const scheduler = new Scheduler(mockAgentRunner);

    const id = scheduler.scheduleTask('ok-task', '* * * * *', 'prompt', false);
    assert.strictEqual(id, 'ok-task');
    assert.ok(scheduler.tasks.has('ok-task'));

    scheduler.removeTask('ok-task');
});
