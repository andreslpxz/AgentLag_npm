// ─── orchestrator.js ─────────────────────────────────────────────────────────
// The Orchestrator: a JSON-Schema + StructuredOutputParser + RunnableLambda
// replacement for the legacy ReAct mode.
//
// Flow (per the user's spec):
//   1. INTERCEPT  — receive the user's question
//   2. CLASSIFY   — send a strict-JSON prompt to the LLM; StructuredOutputParser
//                   validates the response and tells us which tool to call (or
//                   "none" if no tool is needed).
//   3. VALIDATE   — if the JSON is malformed or the model couldn't decide,
//                   fall back to a normal chatbot response (no tool).
//   4. EXECUTE    — run the real tool (a JS function) safely, with try/catch.
//   5. SYNTHESIZE — inject the tool result into a fresh prompt along with the
//                   original question, ask the LLM to draft the final answer.
//
// This loop repeats up to MAX_ITERATIONS times if the synthesizer says another
// tool is needed (multi-step tasks), but each iteration is a strict 2-call
// pattern (classify + synthesize) — no open-ended ReAct rambling.

import { StructuredOutputParser } from "@langchain/core/output_parsers";
import {
    RunnableSequence,
    RunnableLambda,
    RunnablePassthrough,
} from "@langchain/core/runnables";
import {
    SystemMessage,
    HumanMessage,
    AIMessage,
    ToolMessage,
} from "@langchain/core/messages";
import { z } from "zod";
import { stripMarkdown, messageText } from "./agent.js";

const MAX_ITERATIONS = 8;   // hard cap — prevents runaway loops

// ─── 1. JSON Schema for the classifier output ────────────────────────────────
// The LLM must respond with either:
//   { "action": "none" }                              → no tool needed, respond directly
//   { "action": "call_tool", "name": "...", "args": {...}, "reason": "..." }
//   { "action": "final_answer", "answer": "..." }     → already have the answer, use this

const classifierSchema = z.object({
    action: z.enum(["none", "call_tool", "final_answer"])
        .describe("'none' = no tool needed, respond as a chatbot. 'call_tool' = execute a tool. 'final_answer' = the answer is already known, just use it."),
    name: z.string().optional().describe("Tool name. Required when action='call_tool'."),
    args: z.record(z.any()).optional().describe("Tool arguments as a JSON object. Required when action='call_tool'."),
    reason: z.string().optional().describe("One-sentence reason for the decision."),
    answer: z.string().optional().describe("The final answer. Required when action='final_answer'."),
});

const classifierParser = StructuredOutputParser.fromZodSchema(classifierSchema);

// ─── 2. Few-shot examples (the "translation" layer) ──────────────────────────
const FEW_SHOT_EXAMPLES = `Here are some examples of how to respond:

User: "Create a file called hello.txt with the content 'Hello World'"
{"action": "call_tool", "name": "create_file", "args": {"filePath": "hello.txt", "content": "Hello World"}, "reason": "User wants to create a file"}

User: "Read the package.json file"
{"action": "call_tool", "name": "read_file", "args": {"filePath": "package.json"}, "reason": "User wants to read a file"}

User: "What is the capital of France?"
{"action": "final_answer", "answer": "The capital of France is Paris.", "reason": "General knowledge, no tool needed"}

User: "Run npm test"
{"action": "call_tool", "name": "run_shell", "args": {"command": "npm test"}, "reason": "User wants to execute a shell command"}

User: "Search the web for the latest Node.js release"
{"action": "call_tool", "name": "web_search", "args": {"query": "latest Node.js release"}, "reason": "User wants a web search"}

User: "Thanks!"
{"action": "none", "reason": "Just a greeting, respond conversationally"}`;

// ─── 3. Build the classifier prompt ──────────────────────────────────────────
function buildClassifierPrompt(tools, history, userMessage) {
    const toolList = tools.map(t => `- ${t.name}: ${t.description}`).join('\n');
    const historyText = history.length > 0
        ? history.slice(-6).map(m => {
            const role = m._getType?.() || 'unknown';
            const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
            return `${role}: ${content.slice(0, 300)}`;
        }).join('\n')
        : '(no prior history)';

    return `You are a tool classifier. Given the user's message and the available tools, decide what to do.

AVAILABLE TOOLS:
${toolList}

CONVERSATION HISTORY (most recent 6 messages):
${historyText}

USER MESSAGE:
"${userMessage}"

${FEW_SHOT_EXAMPLES}

${classifierParser.getFormatInstructions()}

Respond with ONLY the JSON object. Do not add any commentary, markdown, or code fences.`;
}

// ─── 4. The classifier chain (single LLM call → parsed JSON) ─────────────────
function buildClassifierChain(llm) {
    return RunnableSequence.from([
        // Step 1: build the prompt and call the LLM
        RunnableLambda.from(async (input) => {
            const { tools, history, userMessage } = input;
            const prompt = buildClassifierPrompt(tools, history, userMessage);
            const response = await llm.invoke([
                new SystemMessage("You are a strict JSON-only tool classifier. You output ONLY valid JSON, no prose, no markdown fences."),
                new HumanMessage(prompt),
            ]);
            return { rawResponse: response, ...input };
        }),
        // Step 2: parse the LLM's response as strict JSON
        RunnableLambda.from(async (input) => {
            const content = typeof input.rawResponse.content === 'string'
                ? input.rawResponse.content
                : messageText(input.rawResponse);
            try {
                // Strip markdown fences if present
                const fenceMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
                const jsonSource = fenceMatch ? fenceMatch[1] : content;
                const jsonMatch = jsonSource.match(/\{[\s\S]*\}/);
                if (!jsonMatch) {
                    return { action: 'none', reason: 'No JSON found in LLM response', ...input };
                }
                const parsed = JSON.parse(jsonMatch[0]);
                // Validate against schema
                const validated = classifierSchema.parse(parsed);
                return { classification: validated, ...input };
            } catch (e) {
                // JSON malformed → fall back to direct chatbot response
                return { action: 'none', reason: `JSON parse failed: ${e.message}`, ...input };
            }
        }),
    ]);
}

// ─── 5. The executor (runs the actual tool) ──────────────────────────────────
function buildExecutor(tools, session) {
    const toolMap = {};
    for (const t of tools) toolMap[t.name] = t;

    return RunnableLambda.from(async (input) => {
        const classification = input.classification || { action: input.action };

        if (classification.action === 'none' || classification.action === 'final_answer') {
            return { ...input, toolResult: null, toolCall: null };
        }

        if (classification.action === 'call_tool') {
            const toolName = classification.name;
            const toolArgs = classification.args || {};
            const tool = toolMap[toolName];

            if (!tool) {
                return {
                    ...input,
                    toolResult: `Error: tool "${toolName}" is not available. Available tools: ${Object.keys(toolMap).join(', ')}`,
                    toolCall: { name: toolName, args: toolArgs, id: `orch_${Date.now()}` },
                };
            }

            try {
                const result = await tool.invoke(toolArgs);
                const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
                return {
                    ...input,
                    toolResult: resultStr.slice(0, 4000),   // cap to keep prompt manageable
                    toolCall: { name: toolName, args: toolArgs, id: `orch_${Date.now()}` },
                };
            } catch (err) {
                return {
                    ...input,
                    toolResult: `Error executing ${toolName}: ${err.message}`,
                    toolCall: { name: toolName, args: toolArgs, id: `orch_${Date.now()}` },
                };
            }
        }

        return { ...input, toolResult: null, toolCall: null };
    });
}

// ─── 6. The synthesizer (drafts the final answer using the tool result) ──────
function buildSynthesizer(llm, systemPromptText) {
    return RunnableLambda.from(async (input) => {
        const { tools, history, userMessage, classification, toolResult, toolCall } = input;

        // Case 1: LLM said "final_answer" — just use its answer
        if (classification?.action === 'final_answer' && classification.answer) {
            return new AIMessage({ content: classification.answer });
        }

        // Case 2: LLM said "none" — respond as a normal chatbot, no tool
        if (classification?.action === 'none' || !toolResult) {
            const messages = [
                new SystemMessage(systemPromptText),
                ...history,
                new HumanMessage(userMessage),
            ];
            const response = await llm.invoke(messages);
            return response;
        }

        // Case 3: a tool was executed — synthesize the final answer with its result
        const toolList = tools.map(t => `- ${t.name}: ${t.description}`).join('\n');
        const synthPrompt = `You are AgentLag. The user asked a question, and a tool was executed to help answer it. Using the tool's result, draft a clear, concise final response.

USER'S QUESTION:
${userMessage}

TOOL EXECUTED: ${toolCall.name}
TOOL ARGUMENTS: ${JSON.stringify(toolCall.args).slice(0, 500)}

TOOL RESULT:
${toolResult}

If the user might need another tool to fully complete their task, you may say so. Otherwise, just answer directly. Respond in the user's language. Do not add markdown formatting unless it improves readability.`;

        const messages = [
            new SystemMessage(systemPromptText),
            ...history,
            new HumanMessage(synthPrompt),
        ];
        const response = await llm.invoke(messages);

        // If the response looks like it wants another tool, the outer loop will
        // re-classify. Otherwise we return the synthesized answer.
        return response;
    });
}

// ─── 7. The full orchestrator loop ───────────────────────────────────────────
// This wraps the classifier → executor → synthesizer chain in a loop that
// allows up to MAX_ITERATIONS tool calls per turn. Each iteration is exactly
// 2 LLM calls (classify + synthesize), so it's much more predictable than
// open-ended ReAct.

/**
 * Build an orchestrator-mode agent with the same interface as a compiled
 * LangGraph agent (so the rest of the codebase doesn't need to change).
 *
 * @param {object} llm              - The LLM instance (e.g. ChatOpenAI).
 * @param {array}  allTools         - The tool array.
 * @param {string} systemPromptText - The system prompt text (without wrapping in SystemMessage).
 * @param {object} [session]        - Optional session object for tool confirmations.
 * @returns {object} An agent with .invoke(), .stream(), .llm, ._agentMode.
 */
export function buildOrchestratorAgent(llm, allTools, systemPromptText, session) {
    const classifierChain = buildClassifierChain(llm);
    const executor = buildExecutor(allTools, session);
    const synthesizer = buildSynthesizer(llm, systemPromptText);

    // ── invoke() ──────────────────────────────────────────────────────────
    const invoke = async (input, options = {}) => {
        const messages = input.messages || [];
        const userMessage = messageText(messages[messages.length - 1]);
        const history = messages.slice(0, -1);
        const recursionLimit = options.recursionLimit || 30;

        const emittedMessages = [];
        let currentHistory = [...messages];
        let finalResponse = null;

        for (let iter = 0; iter < MAX_ITERATIONS && iter < recursionLimit; iter++) {
            // ── Step 1: Classify ──
            const classifyInput = {
                tools: allTools,
                history: currentHistory,
                userMessage,
            };
            const classifyResult = await classifierChain.invoke(classifyInput, options);
            const classification = classifyResult.classification || { action: classifyResult.action };

            // ── Step 2: Execute (if a tool was requested) ──
            const execResult = await executor.invoke({
                ...classifyResult,
                tools: allTools,
                history: currentHistory,
                userMessage,
            });

            // Emit a synthetic AIMessage with the tool_call so the UI shows it
            if (execResult.toolCall) {
                const aiMsgWithToolCall = new AIMessage({
                    content: '',
                    tool_calls: [{
                        name: execResult.toolCall.name,
                        args: execResult.toolCall.args,
                        id: execResult.toolCall.id,
                    }],
                });
                emittedMessages.push(aiMsgWithToolCall);
                currentHistory = [...currentHistory, aiMsgWithToolCall];

                // Emit the ToolMessage with the result
                const toolMsg = new ToolMessage({
                    content: execResult.toolResult,
                    tool_call_id: execResult.toolCall.id,
                    name: execResult.toolCall.name,
                });
                emittedMessages.push(toolMsg);
                currentHistory = [...currentHistory, toolMsg];
            }

            // ── Step 3: Synthesize ──
            const synthInput = {
                tools: allTools,
                history: currentHistory,
                userMessage,
                classification,
                toolResult: execResult.toolResult,
                toolCall: execResult.toolCall,
            };
            const synthResponse = await synthesizer.invoke(synthInput, options);

            // If the classifier said "none" or "final_answer", we're done.
            if (classification.action === 'none' || classification.action === 'final_answer') {
                finalResponse = synthResponse;
                break;
            }

            // If a tool was called, check if the synthesized response looks like
            // it needs another tool. Heuristic: if the response is short and ends
            // with a question or mentions needing more info, re-classify.
            const synthText = messageText(synthResponse);
            const needsMoreTools = /I need to (run|call|use|execute)|let me (run|call|search|check)|I'll (run|call|search)|another tool|next step/i.test(synthText)
                && synthText.length < 200;

            if (!needsMoreTools || !execResult.toolCall) {
                finalResponse = synthResponse;
                break;
            }

            // Otherwise, the synthesized response is an intermediate step —
            // emit it and loop again to see if another tool is needed.
            emittedMessages.push(synthResponse);
            currentHistory = [...currentHistory, synthResponse];
            finalResponse = synthResponse;
        }

        if (!finalResponse) {
            finalResponse = new AIMessage({
                content: "❌ El orquestador alcanzó el límite de iteraciones sin llegar a una respuesta final. Por favor, sé más específico.",
            });
        }

        // Emit the final response
        emittedMessages.push(finalResponse);

        return { messages: [...messages, ...emittedMessages] };
    };

    // ── stream() — emits chunks as the orchestrator works ────────────────
    const stream = async function* (input, options = {}) {
        // We can't truly stream the LLM tokens here (that would require
        // deeper integration), but we CAN emit structured chunks at each
        // phase boundary so the UI shows progress.
        const result = await invoke(input, options);
        for (const msg of result.messages.slice((input.messages || []).length)) {
            yield { messages: [msg] };
        }
    };

    return {
        invoke,
        stream,
        llm,
        _agentMode: 'orchestrator',
    };
}
