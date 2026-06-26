// ─── effort_models.js ────────────────────────────────────────────────────────
// Registry of all LLM models that support "effort" / "reasoning" / "thinking"
// level configuration, with the correct parameter name and valid levels for
// each (provider, model) pair.
//
// Sources: OpenAI / Azure OpenAI docs, Google Vertex AI docs (Gemini 3
// thinking_level, Gemini 2.5 thinking_budget), Anthropic Claude 4/5 adaptive
// thinking, xAI Grok, DeepSeek, Perplexity Sonar, Mistral Magistral (via
// LiteLLM proxy), Moonshot Kimi (via OpenRouter).
//
// `getEffortConfig(model, provider)` returns:
//   {
//     param:     string | null,        // the kwarg to set on the LLM, or null if not supported
//     levels:    string[] | 'numeric', // valid effort levels, or 'numeric' for budget-style
//     default:   string | number,      // the default level
//     applyTo:   (llm, level) => llm   // function that returns a new LLM with the level applied
//   }
// or `null` if the (model, provider) pair doesn't support effort.

// ─── Helper: normalize a model name for matching ────────────────────────────
function normalize(model) {
    return String(model || '').toLowerCase().trim();
}

// ─── OpenAI / Azure OpenAI ───────────────────────────────────────────────────
// Modern GPT-5.x / o-series use `reasoning_effort` (some use `reasoning.effort`
// via the Responses API, but LangChain's ChatOpenAI accepts `reasoning_effort`
// as a flat kwarg and translates it).
const OPENAI_EFFORT = {
    // ─── GPT-5.x family (Responses API: reasoning.effort) ───────────────────
    // LangChain ChatOpenAI accepts `reasoning_effort` and routes it.
    'gpt-5.5':         { param: 'reasoning_effort', levels: ['none', 'low', 'medium', 'high', 'xhigh'], default: 'medium' },
    'gpt-5.5-pro':     { param: 'reasoning_effort', levels: ['medium', 'high', 'xhigh'], default: 'high' },
    'gpt-5.4':         { param: 'reasoning_effort', levels: ['none', 'low', 'medium', 'high', 'xhigh'], default: 'none' },
    'gpt-5.4-pro':     { param: 'reasoning_effort', levels: ['medium', 'high', 'xhigh'], default: 'high' },
    'gpt-5.4-mini':    { param: 'reasoning_effort', levels: ['none', 'low', 'medium', 'high', 'xhigh'], default: 'none' },
    'gpt-5.4-nano':    { param: 'reasoning_effort', levels: ['none', 'low', 'medium', 'high', 'xhigh'], default: 'none' },
    'gpt-5.3-codex':   { param: 'reasoning_effort', levels: ['none', 'low', 'medium', 'high', 'xhigh'], default: 'medium' },
    'gpt-5.3-codex-spark': { param: 'reasoning_effort', levels: ['low', 'medium', 'high'], default: 'medium' },
    'gpt-5.2':         { param: 'reasoning_effort', levels: ['none', 'low', 'medium', 'high', 'xhigh'], default: 'medium' },
    'gpt-5.2-pro':     { param: 'reasoning_effort', levels: ['medium', 'high', 'xhigh'], default: 'high' },
    'gpt-5.2-codex':   { param: 'reasoning_effort', levels: ['none', 'low', 'medium', 'high', 'xhigh'], default: 'medium' },
    'gpt-5.1':         { param: 'reasoning_effort', levels: ['none', 'low', 'medium', 'high', 'xhigh'], default: 'none' },
    'gpt-5.1-chat':    { param: 'reasoning_effort', levels: ['none', 'low', 'medium', 'high'], default: 'none' },
    'gpt-5.1-codex':   { param: 'reasoning_effort', levels: ['none', 'low', 'medium', 'high'], default: 'medium' },
    'gpt-5.1-codex-max': { param: 'reasoning_effort', levels: ['low', 'medium', 'high', 'xhigh'], default: 'high' },
    'gpt-5-pro':       { param: 'reasoning_effort', levels: ['medium', 'high', 'xhigh'], default: 'high' },
    'gpt-5':           { param: 'reasoning_effort', levels: ['minimal', 'low', 'medium', 'high'], default: 'medium' },
    'gpt-5-mini':      { param: 'reasoning_effort', levels: ['minimal', 'low', 'medium', 'high'], default: 'medium' },
    'gpt-5-nano':      { param: 'reasoning_effort', levels: ['minimal', 'low', 'medium', 'high'], default: 'medium' },
    'gpt-5-codex':     { param: 'reasoning_effort', levels: ['minimal', 'low', 'medium', 'high'], default: 'medium' },
    // ─── o-series ──────────────────────────────────────────────────────────
    'o1':              { param: 'reasoning_effort', levels: ['low', 'medium', 'high'], default: 'medium' },
    'o1-preview':      { param: 'reasoning_effort', levels: ['low', 'medium', 'high'], default: 'medium' },
    'o1-mini':         { param: null, levels: [], default: null },           // effort is fixed
    'o3':              { param: 'reasoning_effort', levels: ['low', 'medium', 'high'], default: 'medium' },
    'o3-mini':         { param: 'reasoning_effort', levels: ['low', 'medium', 'high'], default: 'medium' },
    'o3-pro':          { param: 'reasoning_effort', levels: ['low', 'medium', 'high'], default: 'high' },
    'o4-mini':         { param: 'reasoning_effort', levels: ['low', 'medium', 'high'], default: 'medium' },
    'gpt-chat-latest': { param: 'reasoning_effort', levels: ['low', 'medium', 'high'], default: 'medium' },
};

// ─── Google Gemini ───────────────────────────────────────────────────────────
// Gemini 3.x uses `thinkingLevel` with discrete levels (case-insensitive on the
// SDK; we use UPPERCASE to match the official docs).
// Gemini 2.5.x uses `thinkingBudget` (numeric token budget, 0 to disable).
const GEMINI_EFFORT = {
    // ─── Gemini 3.x (thinking_level) ───────────────────────────────────────
    'gemini-3.5-flash':                { param: 'thinkingLevel', levels: ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'], default: 'MEDIUM' },
    'gemini-3.1-pro':                  { param: 'thinkingLevel', levels: ['LOW', 'MEDIUM', 'HIGH'], default: 'HIGH' },
    'gemini-3.1-flash-lite':           { param: 'thinkingLevel', levels: ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'], default: 'MINIMAL' },
    'gemini-3-flash':                  { param: 'thinkingLevel', levels: ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'], default: 'HIGH' },
    'gemini-3-pro':                    { param: 'thinkingLevel', levels: ['LOW', 'MEDIUM', 'HIGH'], default: 'HIGH' },
    'gemini-3.1-flash-lite-preview':   { param: 'thinkingLevel', levels: ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'], default: 'MEDIUM' },
    // ─── Gemini 2.5.x (thinking_budget — numeric) ──────────────────────────
    // Map our 5-level effort scale to numeric budgets:
    //   low=512, medium=2048, high=8192, xhigh=16384, max=24576
    'gemini-2.5-pro':                  { param: 'thinkingBudget', levels: 'numeric', default: 8192,
                                          budgetMap: { low: 512, medium: 2048, high: 8192, xhigh: 16384, max: 24576 } },
    'gemini-2.5-flash':                { param: 'thinkingBudget', levels: 'numeric', default: 2048,
                                          budgetMap: { low: 512, medium: 2048, high: 8192, xhigh: 16384, max: 24576 } },
};

// ─── Anthropic Claude ────────────────────────────────────────────────────────
// Claude 4/5 use `thinking: { type: 'enabled', budget_tokens: N }` (LangChain
// ChatAnthropic accepts a `thinking` object). We map effort levels to budget:
//   low=2000, medium=8000, high=16000, xhigh=24000, max=32000
// Claude 3.7 Sonnet supports the same `thinking` object.
const CLAUDE_EFFORT_BUDGETS = {
    low: 2000, medium: 8000, high: 16000, xhigh: 24000, max: 32000,
};

const CLAUDE_EFFORT = {
    'claude-fable-5':        { param: 'thinking', levels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], default: 'high' },
    'claude-mythos-5':       { param: 'thinking', levels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], default: 'high' },
    'claude-mythos-preview': { param: 'thinking', levels: ['none', 'minimal', 'low', 'medium', 'high', 'max'], default: 'medium' },
    'claude-opus-4.8':       { param: 'thinking', levels: ['low', 'medium', 'high', 'max'], default: 'high' },
    'claude-opus-4.7':       { param: 'thinking', levels: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'high' },
    'claude-opus-4.6':       { param: 'thinking', levels: ['low', 'medium', 'high', 'max'], default: 'high' },
    'claude-sonnet-4.6':     { param: 'thinking', levels: ['low', 'medium', 'high', 'max'], default: 'high' },
    'claude-opus-4-5':       { param: 'thinking', levels: ['low', 'medium', 'high', 'max'], default: 'high' },
    'claude-sonnet-4-5':     { param: 'thinking', levels: ['low', 'medium', 'high', 'max'], default: 'high' },
    'claude-opus-4-1':       { param: 'thinking', levels: ['low', 'medium', 'high'], default: 'medium' },
    'claude-3-7-sonnet':     { param: 'thinking', levels: ['low', 'medium', 'high'], default: 'medium' },
};

// ─── xAI Grok ────────────────────────────────────────────────────────────────
// Grok reasoning models accept `reasoning_effort` via the OpenAI-compatible API.
const GROK_EFFORT = {
    'grok-4.20-reasoning': { param: 'reasoning_effort', levels: ['low', 'medium', 'high'], default: 'medium' },
    'grok-4.3':            { param: 'reasoning_effort', levels: ['low', 'medium', 'high'], default: 'low' },
    'grok-3-mini':         { param: 'reasoning_effort', levels: ['low', 'medium', 'high'], default: 'low' },
};

// ─── Mistral Magistral ───────────────────────────────────────────────────────
// Native Mistral API doesn't have effort, but LiteLLM proxy injects system
// prompts. When going through OpenRouter, `reasoning_effort` is passed through.
const MISTRAL_EFFORT = {
    'magistral-medium-2506': { param: 'reasoning_effort', levels: ['low', 'medium', 'high'], default: 'medium', viaProxy: true },
    'magistral-small-2506':  { param: 'reasoning_effort', levels: ['low', 'medium', 'high'], default: 'low',  viaProxy: true },
    'mistral-medium-3-5':    { param: 'reasoning_effort', levels: ['low', 'medium', 'high'], default: 'medium', viaProxy: true },
};

// ─── Moonshot Kimi (via OpenRouter) ──────────────────────────────────────────
const KIMI_EFFORT = {
    'kimi-k2.6':         { param: 'reasoning_effort', levels: ['low', 'medium', 'high'], default: 'medium', viaProxy: true },
    'kimi-k2-thinking':  { param: 'reasoning_effort', levels: ['low', 'medium', 'high'], default: 'high',   viaProxy: true },
    'kimi-k2.5':         { param: 'reasoning_effort', levels: ['low', 'medium', 'high'], default: 'medium', viaProxy: true },
};

// ─── DeepSeek (via OpenRouter) ───────────────────────────────────────────────
const DEEPSEEK_EFFORT = {
    'deepseek-v4-pro':     { param: 'reasoning_effort', levels: ['low', 'medium', 'high', 'xhigh'], default: 'high',   viaProxy: true },
    'deepseek-v4-flash':   { param: 'reasoning_effort', levels: ['low', 'medium', 'high', 'xhigh'], default: 'medium', viaProxy: true },
    'deepseek-v3.2':       { param: 'reasoning_effort', levels: ['low', 'medium', 'high'], default: 'medium', viaProxy: true },
    'deepseek-v3.1-maas':  { param: 'reasoning_effort', levels: ['low', 'medium', 'high'], default: 'medium', viaProxy: true },
    // deepseek-reasoner is fixed — no effort config
};

// ─── Perplexity Sonar (via OpenRouter) ───────────────────────────────────────
const PERPLEXITY_EFFORT = {
    'sonar-reasoning-pro':   { param: 'reasoning_effort', levels: ['low', 'medium', 'high'], default: 'medium', viaProxy: true },
    'sonar-deep-research':   { param: 'reasoning_effort', levels: ['low', 'medium', 'high'], default: 'high',   viaProxy: true },
};

// ─── Open-source models (via pasarelas / OpenRouter) ─────────────────────────
const OSS_EFFORT = {
    'gpt-oss-120b': { param: 'reasoning_effort', levels: ['low', 'medium', 'high'], default: 'medium', viaProxy: true },
    'gpt-oss-20b':  { param: 'reasoning_effort', levels: ['low', 'medium', 'high'], default: 'low',   viaProxy: true },
};

// ─── Lookup table by provider ────────────────────────────────────────────────
// Maps provider ID → the registry to search for that provider's models.
const PROVIDER_REGISTRIES = {
    openai:      OPENAI_EFFORT,
    azure:       OPENAI_EFFORT,   // Azure OpenAI mirrors OpenAI's effort API
    google:      GEMINI_EFFORT,
    vertexai:    GEMINI_EFFORT,   // Vertex AI's Gemini models use the same params
    anthropic:   CLAUDE_EFFORT,
    grok:        GROK_EFFORT,
    mistral:     MISTRAL_EFFORT,
    openrouter:  { ...MISTRAL_EFFORT, ...KIMI_EFFORT, ...DEEPSEEK_EFFORT,
                   ...PERPLEXITY_EFFORT, ...OSS_EFFORT, ...CLAUDE_EFFORT,
                   ...GROK_EFFORT },  // OpenRouter passes reasoning_effort through
    lightning:   OPENAI_EFFORT,   // Lightning AI gateway mirrors OpenAI's API
    nvidia:      {},              // NVIDIA NIM doesn't expose effort
};

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Look up the effort config for a (model, provider) pair.
 *
 * @param {string} model    - The model name (e.g. "gpt-5", "gemini-3-pro", "claude-opus-4-5")
 * @param {string} provider - The provider ID (e.g. "openai", "google", "anthropic")
 * @returns {object|null}   - The effort config, or null if not supported.
 *
 * The returned config has shape:
 *   {
 *     param:    string | null,        // the kwarg name, or null if effort is fixed/unconfigurable
 *     levels:   string[] | 'numeric', // valid levels, or 'numeric' for budget-style
 *     default:  string | number,      // the default level
 *     applyTo:  (llm, level) => llm,  // returns a new LLM with the level applied
 *   }
 */
export function getEffortConfig(model, provider) {
    const norm = normalize(model);
    if (!norm) return null;

    const registry = PROVIDER_REGISTRIES[provider];
    if (!registry) return null;

    // Try exact match first
    let entry = registry[norm];

    // Then try prefix match (e.g. "gpt-5.5-2025-08-15" matches "gpt-5.5")
    if (!entry) {
        for (const [key, val] of Object.entries(registry)) {
            if (norm.startsWith(key)) {
                entry = val;
                break;
            }
        }
    }

    if (!entry) return null;
    if (entry.param === null) {
        // Effort is fixed for this model (e.g. o1-mini, deepseek-reasoner)
        return { param: null, levels: [], default: null, fixed: true };
    }

    // Build the applyTo function based on the param type
    let applyTo;
    if (entry.param === 'reasoning_effort') {
        // OpenAI / Azure / Grok / proxies — flat kwarg
        applyTo = (llm, level) => {
            if (!level) return llm;
            // ChatOpenAI accepts reasoning_effort directly
            try {
                return llm.bind({ reasoning_effort: level });
            } catch {
                // Fallback: mutate the modelKwargs
                const kwargs = llm.modelKwargs || {};
                kwargs.reasoning_effort = level;
                llm.modelKwargs = kwargs;
                return llm;
            }
        };
    } else if (entry.param === 'thinkingLevel') {
        // Google Gemini 3.x — UPPERCASE level string
        applyTo = (llm, level) => {
            if (!level) return llm;
            const upper = String(level).toUpperCase();
            try {
                // ChatGoogleGenerativeAI accepts thinkingLevel as a constructor param;
                // we re-create with the new value via bind (works in langchain >= 1.0)
                return llm.bind({ thinkingLevel: upper });
            } catch {
                return llm;
            }
        };
    } else if (entry.param === 'thinkingBudget') {
        // Google Gemini 2.5.x — numeric token budget
        applyTo = (llm, level) => {
            if (!level) return llm;
            // If level is a string, map it to a numeric budget via budgetMap
            let budget;
            if (typeof level === 'number') {
                budget = level;
            } else {
                budget = entry.budgetMap?.[String(level).toLowerCase()] ?? entry.default;
            }
            try {
                return llm.bind({ thinkingBudget: budget });
            } catch {
                return llm;
            }
        };
    } else if (entry.param === 'thinking') {
        // Anthropic Claude 4/5 — thinking object with budget_tokens
        applyTo = (llm, level) => {
            if (!level || level === 'none') {
                // Disable thinking
                try {
                    return llm.bind({ thinking: undefined });
                } catch {
                    return llm;
                }
            }
            const budget = CLAUDE_EFFORT_BUDGETS[String(level).toLowerCase()] ?? CLAUDE_EFFORT_BUDGETS.high;
            try {
                return llm.bind({
                    thinking: { type: 'enabled', budget_tokens: budget },
                });
            } catch {
                return llm;
            }
        };
    } else {
        // Generic fallback — just bind the param
        applyTo = (llm, level) => {
            if (!level) return llm;
            try {
                return llm.bind({ [entry.param]: level });
            } catch {
                return llm;
            }
        };
    }

    return {
        param:    entry.param,
        levels:   entry.levels,
        default:  entry.default,
        viaProxy: entry.viaProxy || false,
        applyTo,
    };
}

/**
 * Check if a (model, provider) pair supports effort configuration.
 */
export function supportsEffort(model, provider) {
    const cfg = getEffortConfig(model, provider);
    return cfg !== null && cfg.param !== null && !cfg.fixed;
}

/**
 * Return a human-readable description of the effort support for a model.
 */
export function describeEffortSupport(model, provider) {
    const cfg = getEffortConfig(model, provider);
    if (!cfg) return `${model} (${provider}) no admite configuración de esfuerzo.`;
    if (cfg.fixed) return `${model} (${provider}) tiene esfuerzo fijo (no configurable).`;
    if (cfg.levels === 'numeric') {
        return `${model} (${provider}) usa ${cfg.param} (presupuesto numérico de tokens). Niveles: low, medium, high, xhigh, max. Default: ${cfg.default}.`;
    }
    return `${model} (${provider}) usa ${cfg.param}. Niveles: ${cfg.levels.join(', ')}. Default: ${cfg.default}.`;
}

/**
 * Validate an effort level against the model's supported levels.
 * Returns {ok: true, normalized} or {ok: false, error}.
 */
export function validateEffortLevel(model, provider, level) {
    const cfg = getEffortConfig(model, provider);
    if (!cfg || cfg.param === null || cfg.fixed) {
        return { ok: false, error: `El modelo ${model} (${provider}) no admite configuración de esfuerzo.` };
    }
    if (cfg.levels === 'numeric') {
        // Accept our 5-level scale OR a raw number
        const validLevels = ['low', 'medium', 'high', 'xhigh', 'max'];
        if (typeof level === 'number') return { ok: true, normalized: level };
        const lower = String(level).toLowerCase();
        if (validLevels.includes(lower)) return { ok: true, normalized: lower };
        return { ok: false, error: `Nivel inválido "${level}". Válidos: ${validLevels.join(', ')} (o un número).` };
    }
    // Discrete levels — case-insensitive match
    const lower = String(level).toLowerCase();
    const match = cfg.levels.find(l => l.toLowerCase() === lower);
    if (match) return { ok: true, normalized: match };
    return { ok: false, error: `Nivel inválido "${level}" para ${model}. Válidos: ${cfg.levels.join(', ')}.` };
}

// ─── Export the full registry for introspection (e.g. /effort list) ──────────
export const EFFORT_REGISTRY = {
    openai:     OPENAI_EFFORT,
    azure:      OPENAI_EFFORT,
    google:     GEMINI_EFFORT,
    vertexai:   GEMINI_EFFORT,
    anthropic:  CLAUDE_EFFORT,
    grok:       GROK_EFFORT,
    mistral:    MISTRAL_EFFORT,
    openrouter: { ...MISTRAL_EFFORT, ...KIMI_EFFORT, ...DEEPSEEK_EFFORT,
                  ...PERPLEXITY_EFFORT, ...OSS_EFFORT, ...CLAUDE_EFFORT,
                  ...GROK_EFFORT },
    lightning:  OPENAI_EFFORT,
};
