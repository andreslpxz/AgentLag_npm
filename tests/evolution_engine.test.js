import test from "node:test";
import assert from "node:assert/strict";
import { analyzeAndEvolve } from "../evolution_engine.js";

// Mock LLM
const mockLlm = {
    invoke: async (messages) => {
        const humanMsg = messages.find(m => m.constructor.name === 'HumanMessage' || (m._getType && m._getType() === 'human'));
        // Fallback for simple mocks
        const targetMsg = humanMsg || messages[messages.length - 1];

        if (targetMsg.content && targetMsg.content.includes("recording_test")) {
            return { content: JSON.stringify({
                action: "CAPTURED",
                skillName: "test-skill",
                reason: "test reason",
                newContent: "test content",
                description: "test desc"
            }) };
        }
        return { content: "Invalid JSON" };
    }
};

const mockAgent = { llm: mockLlm };

test("analyzeAndEvolve returns suggestion on valid JSON", async () => {
    const recording = { id: "recording_test", steps: [] };
    const result = await analyzeAndEvolve(recording, mockAgent);
    assert.notStrictEqual(result, null, "Result should not be null");
    assert.strictEqual(result.action, "CAPTURED");
    assert.strictEqual(result.skillName, "test-skill");
});

test("analyzeAndEvolve returns null on invalid JSON", async () => {
    const recording = { id: "invalid", steps: [] };
    const result = await analyzeAndEvolve(recording, mockAgent);
    assert.strictEqual(result, null, "Result should be null for invalid recording/JSON");
});
