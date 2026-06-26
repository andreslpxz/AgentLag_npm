// ─── providers.js ─────────────────────────────────────────────────────────────
// Definición de proveedores LLM y sus modelos sugeridos.

export const PROVIDERS = [
        { id: 'google',      label: 'Google Gemini',  desc: 'Gemini 1.5 Pro / Flash' },
    { id: 'cohere',      label: 'Cohere',         desc: 'Command R+, Command A (v2 API)' },
    { id: 'grok',        label: 'xAI (Grok)',     desc: 'Grok-1, Grok-2' },
    { id: 'perplexity',  label: 'Perplexity',     desc: 'Sonar models with search' },
    { id: 'together',    label: 'Together AI',    desc: 'Llama, Qwen, Mistral gateway' },
    { id: 'cerebras',    label: 'Cerebras',       desc: 'Fastest Llama-3 inference' },
    { id: 'qwen',        label: 'Qwen (Alibaba)', desc: 'Qwen-2.5-72B, Qwen-VL' },
    { id: 'glm',         label: 'Zhipu (GLM)',    desc: 'GLM-4' },
    { id: 'groq',        label: 'Groq',           desc: 'Ultra-fast inference (LPU)' },
    { id: 'openai',      label: 'OpenAI',          desc: 'GPT-4o, o1, o3…' },
    { id: 'azure',       label: 'Azure OpenAI',    desc: 'GPT-4o, o1, o3 via Azure deployment' },
    { id: 'anthropic',   label: 'Anthropic',       desc: 'Claude Sonnet / Opus' },
    { id: 'openrouter',  label: 'OpenRouter',      desc: 'Multi-model gateway' },
    { id: 'lightning',   label: 'Lightning AI',    desc: 'OpenAI-compatible gateway' },
    { id: 'nvidia',      label: 'NVIDIA NIM',      desc: 'NVIDIA hosted models' },
    { id: 'deepseek',    label: 'DeepSeek',        desc: 'DeepSeek-V3 / R1' },
    { id: 'mistral',     label: 'Mistral AI',      desc: 'Mixtral, Mistral-Large' },
    { id: 'meta',        label: 'Meta (Llama)',    desc: 'Llama 3.x via API' },
    { id: 'vertexai',    label: 'Google Vertex AI', desc: 'Claude / Gemini / Llama via Vertex (Bearer token)' },
    { id: 'bedrock',     label: 'Amazon Bedrock',   desc: 'Claude / Llama / Titan via AWS Bedrock' },
    { id: 'ollama',      label: 'Ollama (local)',  desc: 'Local models, no API key' },
    { id: 'huggingface', label: 'HuggingFace',     desc: 'Download & run HF models via Ollama' },
];

export const PROVIDER_MODELS = {
    google:      ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
    // Cohere v2 only accepts the modern model IDs. Old "command-r-plus" / "command-r"
    // without a date suffix are routed by Cohere to the v1 endpoint, which is what
    // produced the "this model is not supported with '/v1/chat'" BadRequestError.
    // The "-08-2024" / "-10-2024" suffixes pin models that work with /v2/chat.
    cohere:      [
        'command-a-03-2025',
        'command-r-plus-08-2024',
        'command-r-08-2024',
        'command-r-10-2024',
        'command-r7b-12-2024',
    ],
    grok:        ['grok-2', 'grok-1'],
    perplexity:  ['llama-3.1-sonar-large-128k-online', 'llama-3.1-sonar-small-128k-online'],
    together:    ['meta-llama/Llama-3-70b-chat-hf', 'mistralai/Mixtral-8x7b-Instruct-v0.1'],
    cerebras:    ['llama3.1-70b', 'llama3.1-8b'],
    qwen:        ['qwen-max', 'qwen-plus', 'qwen-turbo'],
    glm:         ['glm-4', 'glm-4-flash'],
    groq:        ['qwen/qwen3-32b', 'llama-3.3-70b-versatile', 'mixtral-8x7b-32768', 'gemma2-9b-it'],
    openai:      ['gpt-4o', 'gpt-4o-mini', 'o1', 'o3-mini'],
    // Azure: the "model" is actually the deployment name you created in Azure.
    // The examples below use common deployment names; replace with your own.
    azure:       ['gpt-4o', 'gpt-4o-mini', 'o1', 'o3-mini', 'gpt-5', 'gpt-5-mini'],
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
    // Vertex AI: model IDs use the form vendor/model used by the Vertex OpenAI-compatible
    // endpoint (https://{LOCATION}-aiplatform.googleapis.com/v1/projects/.../endpoints/openapi).
    // The ChatOpenAI baseURL is constructed dynamically in agent.js createLLM().
    vertexai:    [
        'claude-3-5-sonnet-v2@20241022',
        'claude-3-7-sonnet@20250219',
        'gemini-1.5-pro-002',
        'gemini-2.0-flash-001',
        'meta/llama-3.1-405b-instruct-maas',
    ],
    // Amazon Bedrock: model IDs follow the Bedrock convention. The actual call goes
    // through @langchain/aws ChatBedrockConverse. If that package is not available,
    // agent.js falls back to the OpenAI-compatible Bedrock gateway (requires
    // a presigned URL helper or a third-party proxy) — see agent.js for details.
    bedrock:     [
        'anthropic.claude-3-5-sonnet-20241022-v2:0',
        'anthropic.claude-3-7-sonnet-20250219-v1:0',
        'anthropic.claude-3-haiku-20240307-v1:0',
        'meta.llama3-3-70b-instruct-v1:0',
        'amazon.nova-pro-v1:0',
        'amazon.nova-lite-v1:0',
        'amazon.nova-micro-v1:0',
    ],
    ollama:      ['llama3', 'mistral', 'qwen2', 'gemma2', 'phi3', 'codellama'],
    huggingface: [],
};
