# AgentLag

> Interactive CLI agent for software engineering tasks. Multi-provider, autonomous, and extensible through skills.

---

## What is AgentLag?

AgentLag is an autonomous terminal agent that acts as your development partner. It can read and edit files, execute shell commands, search through your project, and remember your preferences across sessions. It works with major LLM providers and automatically adapts to models that don't support native tool calling through a backup ReAct mode.

---

## Installation

```bash
# Clone the repository
git clone https://github.com/andreslpxz/AgentLag_npm.git
cd AgentLag_npm

# Install dependencies
npm install

# Install globally (optional)
npm link
```

### Requirements

- Node.js 18+
- An API key from the provider you wish to use

---

## Configuration

Copy the example file and add your API key:

```bash
cp env.example .env
```

**Available variables in `.env`:**

```env
ANTHROPIC_API_KEY=sk-...
OPENAI_API_KEY=sk-...
GROQ_API_KEY=gsk_...
OPENROUTER_API_KEY=sk-or-...
MISTRAL_API_KEY=...
DEEPSEEK_API_KEY=...
NVIDIA_API_KEY=...
LIGHTNING_API_KEY=...
TOGETHER_API_KEY=...
OLLAMA_BASE_URL=http://localhost:11434
```

The active configuration (chosen provider and model) is persisted in `~/.agentlag/config.json`.

---

## Usage

```bash
# Start the agent
agentlag

# Or directly with tsx if not installed globally
npx tsx cli.jsx

# Interactive test mode for development
npm run devintest
```

On first startup, a wizard will ask you to choose a provider and model.

---

## Supported Providers

| Provider      | Selection Command | Environment Variable    |
|---------------|-------------------|-------------------------|
| Groq          | `/provider`        | `GROQ_API_KEY`          |
| OpenAI        | `/provider`        | `OPENAI_API_KEY`        |
| Anthropic     | `/provider`        | `ANTHROPIC_API_KEY`     |
| OpenRouter    | `/provider`        | `OPENROUTER_API_KEY`    |
| Mistral       | `/provider`        | `MISTRAL_API_KEY`       |
| DeepSeek      | `/provider`        | `DEEPSEEK_API_KEY`      |
| NVIDIA NIM    | `/provider`        | `NVIDIA_API_KEY`        |
| Lightning AI  | `/provider`        | `LIGHTNING_API_KEY`     |
| Together AI   | `/provider`        | `TOGETHER_API_KEY`      |
| Ollama        | `/provider`        | `OLLAMA_BASE_URL`       |

### Lightning AI

1. Define `LIGHTNING_API_KEY` in `.env` or paste it when the wizard asks.
2. Select `Lightning AI` in `/provider`.
3. Choose a model: `openai/gpt-4o`, `openai/o3`, or `lightning-ai/DeepSeek-V3`.

---

## Available Tools

AgentLag has the following tools that the model can invoke autonomously:

| Tool             | Description                                                  |
|------------------|--------------------------------------------------------------|
| `create_file`    | Creates or overwrites a file, including intermediate directories |
| `read_file`      | Reads a file's content with line numbers                     |
| `edit_file`      | Edits a file via exact search and replace                    |
| `list_directory` | Lists files and folders (with recursive option)              |
| `run_shell`      | Executes shell commands in the current directory             |
| `read_skill`     | Reads and injects the content of an installed skill          |
| `find_skills`    | Searches for available skills in skills.sh                   |
| `manage_memory`  | Saves or lists project data in persistent memory             |
| `query_graph`    | Runs Cypher queries against the L3 Knowledge Graph           |

---

## Advanced Features

### 🚀 Evolution Engine
AgentLag analyzes successful task recordings and proposes new skills or improvements to existing ones.
- `/evolve list`: See pending evolutions.
- `/evolve apply <index>`: Apply a specific evolution.
- `/consolidate`: Extract entities and relations from session history into the L3 Graph.

### 🧠 Knowledge Graph L3
Uses **Kuzu DB** to build a graph of entities and relations from your project, allowing the agent to have deep historical context.

### 🛠 Skill System
AgentLag can read installed skills from:
- `.agents/skills/` — Local project skills
- `~/.agents/skills/` — Global user skills

---



---

## Contributing

Contributions are welcome. If you want to add a new provider, add a `case` in the `createLLM` function in `agent.js`. For new tools, add them to `tools.js` using the LangChain `tool()` helper with a Zod schema.

---

## License

MIT

---

Made with 🔥 by DryInk
