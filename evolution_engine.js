import { getSkills, saveSkill } from './skill_registry.js';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import fs from 'fs';

// ─── Hard guards to prevent hallucinogenic evolutions ───────────────────────
// The previous version of this module fed the LLM whatever was passed in
// (which in production was actually a file PATH string, not the recording
// object — see agent_runner.js). That made the LLM hallucinate skills, fix
// skills that didn't exist, and "capture" phantom behaviors from empty
// sessions. These guards reject bad input before we ever call the LLM.

const MIN_EVENTS_FOR_EVOLUTION = 3;        // need at least 3 events to mean anything
const MIN_TOOL_CALLS_FOR_CAPTURE = 2;     // capturing a skill needs real tool usage
const MAX_RECORDING_CHARS = 12000;        // cap to avoid token bloat / runaway cost

/**
 * Coerce whatever was passed in into a real recording object.
 * Accepts:
 *   - a recording object { task, events, ... }
 *   - a JSON string of such an object
 * Returns null if the input can't be coerced into something usable.
 */
function normalizeRecording(recording) {
    if (!recording) return null;

    // Already an object?
    if (typeof recording === 'object' && !Array.isArray(recording)) {
        return recording;
    }

    // A string? It might be JSON, or it might be a file path (the old bug).
    if (typeof recording === 'string') {
        const trimmed = recording.trim();

        // Looks like a JSON object?
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
            try { return JSON.parse(trimmed); } catch { return null; }
        }

        // Otherwise it's almost certainly a file path — try to load it.
        try {
            if (fs.existsSync(trimmed)) {
                const raw = fs.readFileSync(trimmed, 'utf8');
                return JSON.parse(raw);
            }
        } catch {
            // fallthrough
        }
        return null;
    }

    return null;
}

/**
 * Strip a recording down to the minimum signal the LLM needs to decide.
 * Removes verbose tool outputs and keeps only name + small args + small result.
 */
function summarizeRecording(rec) {
    const events = Array.isArray(rec.events) ? rec.events : [];
    const summarized = events.map(ev => {
        if (ev.type === 'tool_call' || ev.role === 'tool') {
            const argsStr   = safe_stringify(ev.args).slice(0, 400);
            const resultStr = safe_stringify(ev.result).slice(0, 400);
            return { type: 'tool_call', name: ev.name, args: argsStr, result: resultStr };
        }
        // user / assistant message
        const content = typeof ev.content === 'string' ? ev.content : safe_stringify(ev.content);
        return { role: ev.role || 'unknown', content: content.slice(0, 500) };
    });

    return {
        task:      (rec.task || rec.taskQuery || '').slice(0, 300),
        status:    rec.status || 'unknown',
        eventCount: events.length,
        events:    summarized,
    };
}

function safe_stringify(v) {
    try {
        return typeof v === 'string' ? v : JSON.stringify(v);
    } catch {
        return String(v);
    }
}

/**
 * Validate the LLM's suggested evolution against reality.
 * Returns the cleaned suggestion, or null if it should be rejected.
 */
function validateSuggestion(suggestion, existingSkillNames, summarized) {
    if (!suggestion || typeof suggestion !== 'object') return null;

    const action = String(suggestion.action || '').toUpperCase();
    if (!['FIX', 'CAPTURED', 'NONE'].includes(action)) return null;

    if (action === 'NONE') return null;

    const skillName = String(suggestion.skillName || '').trim();
    if (!skillName || skillName.length > 80) return null;
    if (!/^[a-z0-9-_:]+$/i.test(skillName)) return null;

    // FIX requires the skill to actually exist — otherwise the LLM is hallucinating
    // a fix for a phantom skill.
    if (action === 'FIX' && !existingSkillNames.includes(skillName)) {
        return null;
    }

    // CAPTURED requires that the recording actually contain real tool calls
    // — otherwise we're "capturing" a skill from an empty conversation.
    if (action === 'CAPTURED') {
        const toolCallCount = (summarized.events || []).filter(e => e.type === 'tool_call').length;
        if (toolCallCount < MIN_TOOL_CALLS_FOR_CAPTURE) return null;
        // Also reject if a skill with this exact name already exists — would
        // otherwise silently overwrite via saveSkill().
        if (existingSkillNames.includes(skillName)) return null;
    }

    const newContent = String(suggestion.newContent || '').trim();
    if (newContent.length < 20) return null;     // too short to be a real skill
    if (newContent.length > 8000) return null;   // too long, probably hallucinated

    const reason = String(suggestion.reason || '').trim();
    if (reason.length < 5) return null;

    const description = String(suggestion.description || reason).slice(0, 300);

    return {
        action,
        skillName,
        reason,
        newContent,
        description,
    };
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function analyzeAndEvolve(recording, agent) {
    const rec = normalizeRecording(recording);
    if (!rec) {
        // Silent: bad input is the caller's fault, not the user's.
        return null;
    }

    const skills = getSkills();
    const existingSkillNames = skills.map(s => s.name);

    // Bail out early if the recording has no meaningful signal — this is the
    // single biggest source of hallucinated evolutions.
    const eventCount = Array.isArray(rec.events) ? rec.events.length : 0;
    if (eventCount < MIN_EVENTS_FOR_EVOLUTION) {
        return null;
    }

    // Only consider evolutions for SUCCESSFUL runs — failed runs are noisy and
    // tend to produce "FIX" suggestions that miss the actual failure cause.
    if (rec.status && rec.status !== 'success') {
        return null;
    }

    const summarized = summarizeRecording(rec);
    const summarizedStr = safe_stringify(summarized).slice(0, MAX_RECORDING_CHARS);

    // Build a SHORT skills context — only names + descriptions, not full content.
    // Sending full content was burning tokens and inviting the LLM to "FIX"
    // things that weren't actually broken.
    const skillsContext = skills.length === 0
        ? '(no skills installed yet)'
        : skills.map(s => `- ${s.name}: ${s.description || '(no desc)'}`).join('\n');

    const prompt = `You are the OpenSpaceLag Evolution Engine. Your job is to decide whether the just-completed task reveals a reusable improvement.

Decide ONE of:
- CAPTURED: A NEW reusable skill can be extracted from the successful steps. Only do this if the task used ≥2 tool calls AND the steps form a clear, repeatable pattern that isn't already covered by an existing skill.
- FIX: An EXISTING skill (one from the list below) is demonstrably wrong or incomplete, AND this task's recording shows concrete evidence of the bug. Only do this if the skill name exists in the list.
- NONE: Don't touch anything. This is the right answer for most tasks — especially short ones, small talk, or one-off questions.

EXISTING SKILLS:
${skillsContext}

RECORDING (truncated):
${summarizedStr}

HARD RULES:
- If the recording is short, chatty, or doesn't show a clear repeatable pattern, return NONE.
- If you pick FIX, the skillName MUST be one of the existing skills listed above. Otherwise return NONE.
- If you pick CAPTURED, the new skillName MUST NOT already exist in the list above.
- Do NOT invent facts not present in the recording.
- newContent must be a complete SKILL.md body (markdown), 20–8000 chars.

Respond with ONLY a JSON object:
{
  "action": "FIX" | "CAPTURED" | "NONE",
  "skillName": "name-of-the-skill",
  "reason": "one-sentence justification grounded in the recording",
  "newContent": "full SKILL.md content (only required for FIX/CAPTURED)",
  "description": "short description (only required for CAPTURED)"
}`;

    try {
        const llm = agent?.llm || agent;
        if (!llm || typeof llm.invoke !== 'function') return null;

        const response = await llm.invoke([
            new SystemMessage("You are an expert in prompt engineering and skill design. You output ONLY the requested JSON — no prose, no markdown fences."),
            new HumanMessage(prompt)
        ]);

        const content = typeof response.content === 'string'
            ? response.content
            : safe_stringify(response.content);

        // Strip markdown code fences if the LLM wrapped the JSON
        const fenceMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
        const jsonSource = fenceMatch ? fenceMatch[1] : content;

        const match = jsonSource.match(/\{[\s\S]*\}/);
        if (!match) return null;

        let parsed;
        try {
            parsed = JSON.parse(match[0]);
        } catch {
            return null;
        }

        const validated = validateSuggestion(parsed, existingSkillNames, summarized);
        return validated;
    } catch (error) {
        console.error("Error in evolution analysis:", error);
        return null;
    }
}

export function applyEvolution(suggestion) {
    if (!suggestion || !suggestion.skillName) {
        throw new Error("Invalid evolution suggestion: missing skillName");
    }
    saveSkill(suggestion.skillName, suggestion.description, suggestion.newContent);
}
