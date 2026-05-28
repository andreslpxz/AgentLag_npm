import { test } from 'node:test';
import assert from 'node:assert';
import { saveSkill, getSkills } from '../skill_registry.js';
import { RecordingSession } from '../recording_logger.js';
import { optimizeToolOutput } from '../optimizer.js';

test('SQLite registry saves and retrieves skills', () => {
    const name = 'test_skill_' + Date.now();
    saveSkill(name, 'test desc', 'test content');
    const skills = getSkills();
    const found = skills.find(s => s.name === name);
    assert.ok(found);
    assert.strictEqual(found.content, 'test content');
});

test('Recording system saves to JSON and SQLite', async () => {
    const session = new RecordingSession('test task');
    session.logInteraction('user', 'hello');
    session.logToolCall('test_tool', { arg: 1 }, 'result');
    const path = await session.save('success');
    assert.ok(path.endsWith('.json'));
});

test('Optimizer truncates large output', () => {
    const largeOutput = 'A'.repeat(5000);
    const optimized = optimizeToolOutput(largeOutput);
    assert.ok(optimized.length < 5000);
    assert.ok(optimized.includes('truncados'));
});
