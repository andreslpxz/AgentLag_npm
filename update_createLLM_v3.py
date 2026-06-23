import sys

content = open('agent.js').read()

new_logic = r"""async function createLLM(provider, model, apiKey, baseUrl) {
    const info = getModelInfo(model);
    const commonOpts = {
        temperature: 0.4,
        maxTokens: info.outTokens || 8192
    };

    switch (provider) {
        case "google": {
            return new ChatGoogleGenerativeAI({
                modelName: model,
                apiKey: apiKey || process.env.GOOGLE_GENAI_API_KEY,
                ...commonOpts
            });
        }
        case "cohere": {
            return new ChatCohere({
                model,
                apiKey: apiKey || process.env.COHERE_API_KEY,
                ...commonOpts
            });
        }
        case "grok":
        case "together":
        case "cerebras":
        case "qwen":
        case "glm":
        case "perplexity": {
            const baseUrlMap = {
                grok: "https://api.x.ai/v1",
                together: "https://api.together.xyz/v1",
                cerebras: "https://api.cerebras.ai/v1",
                qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1",
                glm: "https://open.bigmodel.cn/api/paas/v4",
                perplexity: "https://api.perplexity.ai"
            };
            const envVars = {
                grok: "GROK_API_KEY",
                together: "TOGETHER_API_KEY",
                cerebras: "CEREBRAS_API_KEY",
                qwen: "QWEN_API_KEY",
                glm: "GLM_API_KEY",
                perplexity: "PERPLEXITY_API_KEY"
            };
            return new ChatOpenAI({
                model,
                apiKey: apiKey || process.env[envVars[provider]],
                configuration: { baseURL: baseUrlMap[provider] },
                ...commonOpts
            });
        }"""

content = content.replace('async function createLLM(provider, model, apiKey, baseUrl) {\n    switch (provider) {', new_logic)

with open('agent.js', 'w') as f:
    f.write(content)
