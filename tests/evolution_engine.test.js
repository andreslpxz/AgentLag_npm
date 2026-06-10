import test from "node:test";
import assert from "node:assert/strict";
import { analyzeAndEvolve } from "../evolution_engine.js";

// Mock LLM
const mockLlm = {
    invoke: async (messages) => {
        const humanMsg = messages.find(m => m._getType?.() === 'human' || m.content);
        if (humanMsg.content.includes("recording_test")) {
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
    assert.notStrictEqual(result, null);
    assert.strictEqual(result.action, "CAPTURED");
    assert.strictEqual(result.skillName, "test-skill");
});

test("analyzeAndEvolve returns null on invalid JSON", async () => {
    const recording = { id: "invalid", steps: [] };
    const result = await analyzeAndEvolve(recording, mockAgent);
    assert.strictEqual(result, null);
});
