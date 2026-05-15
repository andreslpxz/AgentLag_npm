# AgentLag

AgentLag es un agente CLI interactivo para tareas de ingeniería de software.

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
