// ─── providers.js ─────────────────────────────────────────────────────────────
// Definición de proveedores LLM y sus modelos sugeridos.

export const PROVIDERS = [
    { id: 'groq',        label: 'Groq',           desc: 'Ultra-fast inference (LPU)' },
    { id: 'openai',      label: 'OpenAI',          desc: 'GPT-4o, o1, o3…' },
    { id: 'anthropic',   label: 'Anthropic',       desc: 'Claude Sonnet / Opus' },
    { id: 'openrouter',  label: 'OpenRouter',      desc: 'Multi-model gateway' },
    { id: 'lightning',   label: 'Lightning AI',    desc: 'OpenAI-compatible gateway' },
    { id: 'nvidia',      label: 'NVIDIA NIM',      desc: 'NVIDIA hosted models' },
    { id: 'deepseek',    label: 'DeepSeek',        desc: 'DeepSeek-V3 / R1' },
    { id: 'mistral',     label: 'Mistral AI',      desc: 'Mixtral, Mistral-Large' },
    { id: 'meta',        label: 'Meta (Llama)',    desc: 'Llama 3.x via API' },
    { id: 'ollama',      label: 'Ollama (local)',  desc: 'Local models, no API key' },
    { id: 'huggingface', label: 'HuggingFace',     desc: 'Download & run HF models via Ollama' },
];

export const PROVIDER_MODELS = {
    groq:        ['qwen/qwen3-32b', 'llama-3.3-70b-versatile', 'mixtral-8x7b-32768', 'gemma2-9b-it'],
    openai:      ['gpt-4o', 'gpt-4o-mini', 'o1', 'o3-mini'],
    anthropic:   ['claude-sonnet-4-5', 'claude-opus-4', 'claude-haiku-4-5'],
    openrouter:  ['openai/gpt-4o', 'anthropic/claude-3-opus', 'meta-llama/llama-3-70b'],
    lightning:   [
        'openai/gpt-5', 'openai/gpt-5-mini', 'openai/o3',
        'anthropic/claude-sonnet-4-5-20250929',
        'lightning-ai/DeepSeek-V3.1', 'lightning-ai/llama-3.3-70b',
        'google/gemini-2.5-pro',
    ],
    nvidia:      ['meta/llama-3.1-70b-instruct', 'mistralai/mixtral-8x7b-instruct'],
    deepseek:    ['deepseek-chat', 'deepseek-reasoner'],
    mistral:     ['mistral-large-latest', 'mistral-medium', 'codestral-latest'],
    meta:        ['llama-3.3-70b', 'llama-3.1-405b'],
    ollama:      ['llama3', 'mistral', 'qwen2', 'gemma2', 'phi3', 'codellama'],
    huggingface: [],
};
