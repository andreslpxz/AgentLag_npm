export const MODEL_METADATA = {
    // OpenAI
    "gpt-4o": { maxTokens: 128000, outTokens: 4096, thinking: false },
    "gpt-4o-mini": { maxTokens: 128000, outTokens: 4096, thinking: false },
    "o1": { maxTokens: 200000, outTokens: 100000, thinking: true, thinkingLevel: "medium" },
    "o3-mini": { maxTokens: 200000, outTokens: 100000, thinking: true, thinkingLevel: "high" },

    // Anthropic
    "claude-3-5-sonnet-20241022": { maxTokens: 200000, outTokens: 8192, thinking: false },
    "claude-3-opus-20240229": { maxTokens: 200000, outTokens: 4096, thinking: false },

    // DeepSeek
    "deepseek-chat": { maxTokens: 64000, outTokens: 4096, thinking: false },
    "deepseek-reasoner": { maxTokens: 64000, outTokens: 8192, thinking: true },

    // Google Gemini
    "gemini-2.0-flash": { maxTokens: 1000000, outTokens: 8192, thinking: false },
    "gemini-2.0-pro-exp-02-05": { maxTokens: 2000000, outTokens: 8192, thinking: false },

    // Others
    "llama-3.3-70b-versatile": { maxTokens: 128000, outTokens: 4096, thinking: false },
};

export function getModelInfo(modelName) {
    // Intenta buscar exacto, luego por prefijo
    if (MODEL_METADATA[modelName]) return MODEL_METADATA[modelName];

    for (const [key, val] of Object.entries(MODEL_METADATA)) {
        if (modelName.includes(key)) return val;
    }

    return { maxTokens: 4096, outTokens: 1024, thinking: false }; // Default conservador
}
