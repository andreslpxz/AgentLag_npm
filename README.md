# AgentLag

> Agente CLI interactivo para tareas de ingeniería de software. Multi-proveedor, autónomo y extensible mediante skills.

---

## ¿Qué es AgentLag?

AgentLag es un agente automo de terminal que actúa como dev de desarrollo. Puede leer y editar archivos, ejecutar comandos de shell, buscar en tu proyecto y recordar tus preferencias entre sesiones. Funciona con los principales proveedores de LLM y se adapta automáticamente a modelos que no soportan tool calling nativo mediante un modo ReAct de respaldo.

---

## Instalación

```bash
# Clona el repositorio
git clone https://github.com/andreslpxz/AgentLag_npm.git
cd AgentLag_npm

# Instala dependencias
npm install

# Instala globalmente (opcional)
npm link
```

### Requisitos

- Node.js 18+
- Una API key del proveedor que quieras usar

---

## Configuración

Copia el archivo de ejemplo y añade tu API key:

```bash
cp env.example .env
```

**Variables disponibles en `.env`:**

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

La configuración activa (proveedor y modelo elegidos) se persiste en `~/.agentlag/config.json`.

---

## Uso

```bash
# Inicia el agente
agentlag

# O directamente con tsx si no lo instalaste globalmente
npx tsx cli.jsx

# Modo de prueba interactivo para desarrollo
npm run devintest
```

Al iniciarse por primera vez, el wizard te pedirá que elijas un proveedor y modelo.

---

## Proveedores soportados

| Proveedor     | Comando de selección | Variable de entorno     |
|---------------|----------------------|-------------------------|
| Groq          | `/provider`          | `GROQ_API_KEY`          |
| OpenAI        | `/provider`          | `OPENAI_API_KEY`        |
| Anthropic     | `/provider`          | `ANTHROPIC_API_KEY`     |
| OpenRouter    | `/provider`          | `OPENROUTER_API_KEY`    |
| Mistral       | `/provider`          | `MISTRAL_API_KEY`       |
| DeepSeek      | `/provider`          | `DEEPSEEK_API_KEY`      |
| NVIDIA NIM    | `/provider`          | `NVIDIA_API_KEY`        |
| Lightning AI  | `/provider`          | `LIGHTNING_API_KEY`     |
| Together AI   | `/provider`          | `TOGETHER_API_KEY`      |
| Ollama        | `/provider`          | `OLLAMA_BASE_URL`       |

### Lightning AI

1. Define `LIGHTNING_API_KEY` en `.env` o pégala cuando el wizard la pida.
2. Selecciona `Lightning AI` en `/provider`.
3. Elige un modelo: `openai/gpt-5`, `openai/gpt-5-mini`, `openai/o3` o `lightning-ai/DeepSeek-V3.1`.

---

## Herramientas disponibles

AgentLag dispone de las siguientes herramientas que el modelo puede invocar de forma autónoma:

| Herramienta      | Descripción                                                  |
|------------------|--------------------------------------------------------------|
| `create_file`    | Crea o sobreescribe un archivo, incluyendo directorios intermedios |
| `read_file`      | Lee el contenido de un archivo con números de línea          |
| `edit_file`      | Edita un archivo mediante búsqueda y reemplazo de texto exacto |
| `list_directory` | Lista archivos y carpetas de un directorio (con opción recursiva) |
| `run_shell`      | Ejecuta comandos de shell en el directorio actual            |
| `read_skill`     | Lee e inyecta el contenido de una skill instalada            |
| `find_skills`    | Busca skills disponibles en skills.sh para una necesidad concreta |
| `manage_memory`  | Guarda o lista preferencias y datos del proyecto en memoria persistente |

---

## Sistema de Skills

AgentLag puede leer skills instaladas desde:

- `.agents/skills/` — skills locales del proyecto
- `~/.agents/skills/` — skills globales del usuario

Cada skill es una carpeta con un archivo `SKILL.md` que contiene frontmatter `name` y `description`. El agente las detecta automáticamente y las aplica cuando el contexto lo requiere.

### Comandos de skills

```bash
/skills list                                    # Lista las skills instaladas
/skills read <nombre>                           # Lee el contenido de una skill
/skills find <descripción>                      # Busca skills en skills.sh
/skills add <url-repo> --skill <nombre>         # Instala una skill desde GitHub
```

También puedes activarlas por lenguaje natural:

```
AgentLag, necesito algo para optimizar imágenes en mi proyecto
```

Si la skill `find-skills` está instalada, AgentLag buscará automáticamente en skills.sh y propondrá opciones antes de instalar.

---

## Memoria persistente

AgentLag recuerda preferencias entre sesiones. Los datos se almacenan en `~/.agentlag/memory.json`.

Puedes pedirle al agente que guarde información explícitamente:

```
Recuerda que este proyecto usa TypeScript estricto y Prettier con tab width 2
```

O listar lo que recuerda:

```
/memory list
```

---

## Comandos especiales del CLI

| Comando       | Acción                                      |
|---------------|---------------------------------------------|
| `/provider`   | Abre el wizard para cambiar proveedor/modelo |
| `/skills`     | Gestión de skills                           |
| `/memory`     | Gestión de memoria                          |
| `exit` / `q`  | Sale del agente                             |

---

## Modos de ejecución

### Modo Tools (predeterminado)
El agente usa las herramientas nativas del modelo (function calling). Disponible en la mayoría de modelos modernos de OpenAI, Anthropic, Groq y otros.

### Modo ReAct (respaldo automático)
Para modelos sin soporte de tool calling, el agente genera texto estructurado en formato `Thought / Action / Action Input` y lo parsea internamente. Se activa automáticamente o forzando `forceReAct: true` en la configuración.

---

## Estructura del proyecto

```
agentlag/
├── agent.js          # Lógica central del agente y grafo LangGraph
├── cli.jsx           # Interfaz de terminal (Ink + React)
├── tools.js          # Definición de herramientas disponibles
├── skills.js         # Sistema de descubrimiento y carga de skills
├── memory_utils.js   # Utilidades de memoria persistente
├── ollama_utils.js   # Utilidades para modelos Ollama
├── package.json
├── env.example       # Plantilla de variables de entorno
└── .agents/
    └── skills/       # Skills locales del proyecto
```

---

## Desarrollo y verificación

```bash
npm test
npm run devintest
```

- `npm test` ejecuta los tests automatizados con `node --test`.
- `npm run devintest` abre la CLI interactiva local para probar el agente manualmente.

---

## Ejemplos de uso

```
> Crea un endpoint Express que valide un JWT y devuelva el usuario

> Refactoriza la función parseConfig en src/config.ts para que sea async

> ¿Qué archivos del proyecto importan desde utils/db?

> Ejecuta los tests y dime si alguno falla

> Recuerda que usamos pnpm, no npm
```

---

## Contribuir

Las contribuciones son bienvenidas. Si quieres agregar un nuevo proveedor, añade un `case` en la función `createLLM` de `agent.js` siguiendo el patrón existente. Para nuevas herramientas, agrégalas en `tools.js` usando el helper `tool()` de LangChain con esquema Zod.

---

## Licencia

MIT

---

Hecho con 🔥 por DryInk 
