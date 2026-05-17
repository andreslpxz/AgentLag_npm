# Code Review Request - AgentLag Autonomy and Robustness

## Summary of Changes
1. **Tool Parsing Heuristics**: Refined `parseToolCall` in `agent.js` to handle raw JSON outputs from smaller models, correctly distinguishing between `create_file`, `edit_file`, and `read_file`.
2. **Enhanced System Prompts**: Updated `buildSystemPrompt` and `buildReActSystemPrompt` to instruct the agent to be more autonomous, proactive with skills, and deeply integrated with memory.
3. **Skill Selection Refinement**: Improved `skills.js` to be more inclusive in skill matching and increased the capacity for injected skill context.

## Files Modified
- `agent.js`
- `skills.js`

## Verification Done
- Created a mock testing script `parse_verify.js` to validate the new parsing logic against several test cases (raw JSON, standard ReAct, etc.). All tests passed.
- Verified file contents and structure.
