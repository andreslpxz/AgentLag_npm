import sys

content = open('agent.js').read()

old_create = """async function createLLM(provider, model, apiKey, baseUrl) {
    if (provider === "ollama") {
        return new ChatOllama({ model, temperature: 0 });
    }
    if (provider === "huggingface") {
        return new ChatOllama({ model, temperature: 0 });
    }
    if (provider === "anthropic") {
        return new ChatAnthropic({ apiKey, modelName: model, temperature: 0 });
    }
    if (provider === "mistral") {
        return new ChatMistralAI({ apiKey, model, temperature: 0 });
    }
    if (provider === "groq") {
        return new ChatGroq({ apiKey, modelName: model, temperature: 0 });
    }
    if (provider === "deepseek") {
        return new ChatOpenAI({
            apiKey,
            modelName: model,
            configuration: { baseURL: "https://api.deepseek.com" },
            temperature: 0
        });
    }
    if (provider === "lightning") {
        return new ChatOpenAI({
            apiKey,
            modelName: model,
            configuration: { baseURL: "https://lightning.ai/api/v1" },
            temperature: 0
        });
    }
    if (provider === "nvidia") {
        return new ChatOpenAI({
            apiKey,
            modelName: model,
            configuration: { baseURL: "https://integrate.api.nvidia.com/v1" },
            temperature: 0
        });
    }
    if (provider === "openrouter") {
        return new ChatOpenAI({
            apiKey,
            modelName: model,
            configuration: { baseURL: "https://openrouter.ai/api/v1" },
            temperature: 0
        });
    }

    return new ChatOpenAI({ apiKey, modelName: model, temperature: 0 });
}"""

new_create = """async function createLLM(provider, model, apiKey, baseUrl) {
    const info = getModelInfo(model);
    const commonOpts = {
        temperature: 0,
        maxTokens: info.outTokens || 4096
    };

    // Configuración especial para razonamiento/thinking (ej: modelos o1 de OpenAI)
    if (info.thinking) {
        if (model.startsWith('o1') || model.startsWith('o3')) {
            // OpenAI o1/o3 no soportan temperature != 1 o 0 (según versión) ni max_tokens tradicional
            // commonOpts.maxCompletionTokens = info.outTokens;
            // delete commonOpts.temperature;
        }
    }

    if (provider === "ollama") {
        return new ChatOllama({ model, ...commonOpts });
    }
    if (provider === "huggingface") {
        return new ChatOllama({ model, ...commonOpts });
    }
    if (provider === "anthropic") {
        return new ChatAnthropic({ apiKey, modelName: model, ...commonOpts });
    }
    if (provider === "mistral") {
        return new ChatMistralAI({ apiKey, model, ...commonOpts });
    }
    if (provider === "groq") {
        return new ChatGroq({ apiKey, modelName: model, ...commonOpts });
    }
    if (provider === "google") {
        return new ChatGoogleGenerativeAI({ apiKey, modelName: model, ...commonOpts });
    }
    if (provider === "cohere") {
        return new ChatCohere({ apiKey, model, ...commonOpts });
    }

    const baseUrlMap = {
        deepseek: "https://api.deepseek.com",
        lightning: "https://lightning.ai/api/v1",
        nvidia: "https://integrate.api.nvidia.com/v1",
        openrouter: "https://openrouter.ai/api/v1",
        grok: "https://api.x.ai/v1",
        together: "https://api.together.xyz/v1",
        cerebras: "https://api.cerebras.ai/v1",
        qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        glm: "https://open.bigmodel.cn/api/paas/v4",
        perplexity: "https://api.perplexity.ai"
    };

    if (baseUrlMap[provider]) {
        return new ChatOpenAI({
            apiKey,
            modelName: model,
            configuration: { baseURL: baseUrlMap[provider] },
            ...commonOpts
        });
    }

    return new ChatOpenAI({ apiKey, modelName: model, ...commonOpts });
}"""

if old_create in content:
    content = content.replace(old_create, new_create)
    with open('agent.js', 'w') as f:
        f.write(content)
    print("Updated successfully")
else:
    print("Not found")
