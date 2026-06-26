import { ToolNode } from "@langchain/langgraph/prebuilt";
import { optimizeToolOutput } from './optimizer.js';

export function createWrappedToolNode(tools, session) {
    const node = new ToolNode(tools);
    return async (state) => {
        const result = await node.invoke(state);
        if (result.messages) {
            for (const msg of result.messages) {
                if (msg.content) {
                    const originalContent = msg.content;
                    msg.content = optimizeToolOutput(msg.content);
                    if (session) {
                        session.logToolCall(msg.name || 'unknown', {}, msg.content);
                    }
                }
            }
        }
        return result;
    };
}
