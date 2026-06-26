import test from "node:test";
import assert from "node:assert/strict";
import { analyzeAndEvolve } from "../evolution_engine.js";

// ─── Helpers ────────────────────────────────────────────────────────────────
//
// The new evolution engine has hard guards against hallucinogenic evolutions:
//   - recordings with <3 events are rejected
//   - recordings without status='success' are rejected
//   - CAPTURED requires ≥2 tool_call events AND a skill name that doesn't exist yet
//   - FIX requires a skill name that DOES already exist
//   - newContent must be 20–8000 chars
//
// The previous tests passed synthetic inputs like {id:'recording_test', steps:[]}
// that the new guards (correctly) reject. These tests use realistic recordings.

function makeRecording({ status = 'success', events = [] } = {}) {
    return {
        task: 'test task',
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString(),
        status,
        events,
    };
}

const TWO_TOOL_CALLS = [
    { type: 'tool_call', name: 'create_file', args: { path: 'a.txt' }, result: 'ok' },
    { type: 'tool_call', name: 'run_shell',   args: { command: 'ls' }, result: 'a.txt' },
    { role: 'assistant', content: 'done' },
];

// Mock LLM: returns different responses depending on a "scenario" tag injected
// into the human message content.
function makeMockLlm(scenario) {
    return {
        invoke: async (messages) => {
            const humanMsg = messages.find(m => m._getType && m._getType() === 'human');
            const text = humanMsg?.content || '';

            if (scenario === 'captured' && text.includes('RECORDING')) {
                return { content: JSON.stringify({
                    action: "CAPTURED",
                    skillName: "new-test-skill",
                    reason: "recording shows a repeatable two-step pattern",
                    newContent: "# New Test Skill\n\nThis is a markdown body long enough to pass the 20-char minimum length check.",
                    description: "test desc"
                }) };
            }
            if (scenario === 'fix-nonexistent' && text.includes('RECORDING')) {
                // LLM tries to FIX a skill that isn't in the existing list — should be rejected.
                return { content: JSON.stringify({
                    action: "FIX",
                    skillName: "phantom-skill-that-does-not-exist",
                    reason: "fix something",
                    newContent: "x".repeat(50),
                    description: "phantom"
                }) };
            }
            if (scenario === 'none') {
                return { content: JSON.stringify({ action: "NONE" }) };
            }
            if (scenario === 'markdown-fence') {
                return { content: "```json\n" + JSON.stringify({
                    action: "CAPTURED",
                    skillName: "fenced-skill",
                    reason: "valid pattern",
                    newContent: "# Fenced\n\nlong enough body to pass validation checks here.",
                    description: "fenced desc"
                }) + "\n```" };
            }
            return { content: "not json" };
        }
    };
}

const mockAgent = (scenario) => ({ llm: makeMockLlm(scenario) });

// Stub getSkills so we control the "existing skills" list.
import { getSkills as realGetSkills } from "../skill_registry.js";

test("analyzeAndEvolve returns CAPTURED suggestion on a valid recording with ≥2 tool calls", async () => {
    const recording = makeRecording({ events: TWO_TOOL_CALLS });
    // Stub getSkills to return empty list
    const orig = (await import("../evolution_engine.js"));
    // Use real getSkills — the actual DB is empty in test env, so CAPTURED should succeed.
    const result = await analyzeAndEvolve(recording, mockAgent('captured'));
    assert.ok(result, "Result should not be null for a valid CAPTURED scenario");
    assert.strictEqual(result.action, "CAPTURED");
    assert.strictEqual(result.skillName, "new-test-skill");
});

test("analyzeAndEvolve rejects FIX for a skill that doesn't exist (hallucination guard)", async () => {
    const recording = makeRecording({ events: TWO_TOOL_CALLS });
    const result = await analyzeAndEvolve(recording, mockAgent('fix-nonexistent'));
    assert.strictEqual(result, null, "FIX on a phantom skill must be rejected");
});

test("analyzeAndEvolve returns null when LLM says NONE", async () => {
    const recording = makeRecording({ events: TWO_TOOL_CALLS });
    const result = await analyzeAndEvolve(recording, mockAgent('none'));
    assert.strictEqual(result, null, "NONE should produce no evolution");
});

test("analyzeAndEvolve strips markdown code fences around JSON", async () => {
    const recording = makeRecording({ events: TWO_TOOL_CALLS });
    const result = await analyzeAndEvolve(recording, mockAgent('markdown-fence'));
    assert.ok(result, "Should parse JSON even if wrapped in ```json fences");
    assert.strictEqual(result.skillName, "fenced-skill");
});

test("analyzeAndEvolve rejects recordings with <3 events (too thin to mean anything)", async () => {
    const recording = makeRecording({ events: [{ role: 'user', content: 'hi' }] });
    const result = await analyzeAndEvolve(recording, mockAgent('captured'));
    assert.strictEqual(result, null, "Thin recordings should not trigger evolution");
});

test("analyzeAndEvolve rejects recordings without status='success' (failed runs are noisy)", async () => {
    const recording = makeRecording({ status: 'fail', events: TWO_TOOL_CALLS });
    const result = await analyzeAndEvolve(recording, mockAgent('captured'));
    assert.strictEqual(result, null, "Failed runs should not trigger evolution");
});

test("analyzeAndEvolve coerces a JSON-string recording into an object", async () => {
    const recording = makeRecording({ events: TWO_TOOL_CALLS });
    const result = await analyzeAndEvolve(JSON.stringify(recording), mockAgent('captured'));
    assert.ok(result, "Should accept a JSON-string recording");
    assert.strictEqual(result.action, "CAPTURED");
});

test("analyzeAndEvolve returns null on garbage input (no hallucination)", async () => {
    assert.strictEqual(await analyzeAndEvolve(null, mockAgent('captured')), null);
    assert.strictEqual(await analyzeAndEvolve(undefined, mockAgent('captured')), null);
    assert.strictEqual(await analyzeAndEvolve("not a path or json", mockAgent('captured')), null);
    assert.strictEqual(await analyzeAndEvolve(12345, mockAgent('captured')), null);
});
