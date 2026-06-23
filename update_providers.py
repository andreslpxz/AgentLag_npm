import sys

content = open('providers.js').read()

new_providers = """    { id: 'google',      label: 'Google Gemini',  desc: 'Gemini 1.5 Pro / Flash' },
    { id: 'cohere',      label: 'Cohere',         desc: 'Command R+, Command R' },
    { id: 'grok',        label: 'xAI (Grok)',     desc: 'Grok-1, Grok-2' },
    { id: 'perplexity',  label: 'Perplexity',     desc: 'Sonar models with search' },
    { id: 'together',    label: 'Together AI',    desc: 'Llama, Qwen, Mistral gateway' },
    { id: 'cerebras',    label: 'Cerebras',       desc: 'Fastest Llama-3 inference' },
    { id: 'qwen',        label: 'Qwen (Alibaba)', desc: 'Qwen-2.5-72B, Qwen-VL' },
    { id: 'glm',         label: 'Zhipu (GLM)',    desc: 'GLM-4' },"""

content = content.replace("{ id: 'groq',", new_providers + "\n    { id: 'groq',")

new_models = """    google:      ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
    cohere:      ['command-r-plus', 'command-r'],
    grok:        ['grok-2', 'grok-1'],
    perplexity:  ['llama-3.1-sonar-large-128k-online', 'llama-3.1-sonar-small-128k-online'],
    together:    ['meta-llama/Llama-3-70b-chat-hf', 'mistralai/Mixtral-8x7b-Instruct-v0.1'],
    cerebras:    ['llama3.1-70b', 'llama3.1-8b'],
    qwen:        ['qwen-max', 'qwen-plus', 'qwen-turbo'],
    glm:         ['glm-4', 'glm-4-flash'],"""

content = content.replace("export const PROVIDER_MODELS = {", "export const PROVIDER_MODELS = {\n" + new_models)

with open('providers.js', 'w') as f:
    f.write(content)
