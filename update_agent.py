import sys

content = open('agent.js').read()

# Add imports
new_imports = """import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatCohere } from "@langchain/cohere";
import { getModelInfo } from "./model_info.js";"""

if 'import { ChatAnthropic }' in content:
    content = content.replace('import { ChatAnthropic }', new_imports + '\nimport { ChatAnthropic }')

# Update buildLLM
old_build_llm = """function buildLLM(provider, model, apiKey, options = {}) {"""

new_llm_logic = r"""    const info = getModelInfo(model);
    const commonOpts = {
        maxTokens: options.maxTokens || info.outTokens || 4096,
        temperature: options.temperature ?? 0.7,
        ...options
    };

    if (provider === 'google') {
        return new ChatGoogleGenerativeAI({ apiKey, modelName: model, ...commonOpts });
    }
    if (provider === 'cohere') {
        return new ChatCohere({ apiKey, model, ...commonOpts });
    }
    if (provider === 'grok' || provider === 'together' || provider === 'cerebras' || provider === 'qwen' || provider === 'glm' || provider === 'perplexity') {
        const baseUrlMap = {
            grok: 'https://api.x.ai/v1',
            together: 'https://api.together.xyz/v1',
            cerebras: 'https://api.cerebras.ai/v1',
            qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
            glm: 'https://open.bigmodel.cn/api/paas/v4',
            perplexity: 'https://api.perplexity.ai'
        };
        return new ChatOpenAI({
            apiKey,
            modelName: model,
            configuration: { baseURL: baseUrlMap[provider] },
            ...commonOpts
        });
    }"""

if old_build_llm in content:
    content = content.replace(old_build_llm, old_build_llm + "\n" + new_llm_logic)

with open('agent.js', 'w') as f:
    f.write(content)
