# AgentLag

AgentLag es un agente CLI interactivo para tareas de ingeniería de software.

## Proveedores LLM

AgentLag soporta varios proveedores desde el wizard `/provider`, incluyendo Lightning AI.

Para usar Lightning AI:

1. Define `LIGHTNING_API_KEY` en `.env` o pega la key cuando el wizard la pida.
2. Selecciona `Lightning AI`.
3. Elige un modelo como `openai/gpt-5`, `openai/gpt-5-mini`, `openai/o3` o `lightning-ai/DeepSeek-V3.1`.

Lightning AI usa el endpoint OpenAI-compatible `https://lightning.ai/api/v1/chat/completions`.

## Skills

AgentLag puede leer skills instaladas desde:

- `.agents/skills/` del proyecto
- `~/.agents/skills/` global

Cada skill debe contener un `SKILL.md` con frontmatter `name` y `description`.

Comandos útiles:

```bash
/skills list
/skills read find-skills
/skills find image optimization
/skills add https://github.com/vercel-labs/skills --skill find-skills
```

También puede activarlas por lenguaje natural. Por ejemplo:

> AgentLag, necesito algo para optimizar imágenes en mi proyecto

Si la skill `find-skills` está instalada, AgentLag seguirá sus instrucciones, buscará en skills.sh con `npx skills find image optimization` y propondrá opciones antes de instalar.
