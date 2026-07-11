# autonomous-ops

> Plugin de AgentLag con **3 agentes autónomos**, **3 skills** y **12 servidores MCP** para revenue operations (SDR), cobranza/dunning y DevOps incident response.

---

## Tabla de contenidos

- [Visión general](#visión-general)
- [Arquitectura del plugin](#arquitectura-del-plugin)
- [Agentes incluidos](#agentes-incluidos)
- [Skills incluidas](#skills-incluidas)
- [Servidores MCP](#servidores-mcp)
- [Instalación](#instalación)
- [Configuración de credenciales](#configuración-de-credenciales)
- [Uso](#uso)
- [Notas técnicas](#notas-técnicas)

---

## Visión general

`autonomous-ops` empaqueta tres agentes autónomos diseñados para operar workflows completos sin supervisión continua, cada uno respaldado por un stack de MCPs (Model Context Protocol) que les da acceso a las APIs externas necesarias. Los agentes cubren tres dominios de operaciones críticos:

| Agente | Trabajo | APIs / MCPs |
| --- | --- | --- |
| **sdr-autonomo** | Prospección, personalización, follow-up y booking | Firecrawl, CRM (HubSpot/Salesforce), Gmail, Calendar, Slack |
| **cobranza-dunning** | Recuperación de pagos y reducción de churn | Stripe, Gmail, CRM, Slack, Postgres, Twilio (opcional) |
| **devops-incident-response** | Triage, contención, diagnóstico y PRs de fix | GitHub, Observability (Datadog/CloudWatch), Slack, Filesystem, Postgres, Kubernetes (opcional) |

Cada agente viene con un `systemPrompt` extenso que define su metodología, reglas de calidad, límites operativos y formato de comunicación, más una `SKILL.md` asociada con el playbook detallado del dominio.

---

## Arquitectura del plugin

```
autonomous-ops/
├── plugin.json                    # Manifest: agentes, skills, mcpServers
├── README.md                      # Este archivo
├── agents/
│   ├── sdr-autonomo.json          # SDR autónomo
│   ├── cobranza-dunning.json      # Cobranza / dunning
│   └── devops-incident-response.json  # DevOps incident response
├── skills/
│   ├── outbound-prospecting/SKILL.md   # Playbook de prospección outbound
│   ├── dunning-playbooks/SKILL.md      # Secuencias de dunning y retención
│   └── incident-response/SKILL.md      # Runbook de incident response
├── mcp/
│   └── mcp-servers.json           # Referencia canónica de 12 servidores MCP
└── scripts/
    └── install-mcp.js             # Helper para registrar MCPs en ~/.agentlag/mcp.json
```

El plugin sigue la convención de `examples/plugins/dev-toolkit` del repo AgentLag:

- `plugin.json` declara el manifest con `agents`, `skills` y `mcpServers`.
- Los agentes son JSON con `description`, `provider`, `model`, `systemPrompt` y opcionalmente `allowedTools`.
- Las skills son `SKILL.md` con frontmatter YAML (`name`, `description`) seguido de markdown.
- Los servidores MCP se declaran como objeto `{ "name": { command, args, env } }`.

---

## Agentes incluidos

### 1. `sdr-autonomo` — SDR autónomo

**Trabajo**: conducir prospects desde el primer contacto hasta una reunión agendada con un AE.

**Stack MCP**: Firecrawl (investigación), CRM (pipeline), Gmail (outreach), Calendar (booking), Slack (coordinación).

**Metodología** (resumida — ver `agents/sdr-autonomo.json` y `skills/outbound-prospecting/SKILL.md` para el detalle):

1. **Investigación** con Firecrawl: detectar trigger events, ICP fit, decision-makers.
2. **Personalización nivel 2-3**: cada email referencia un insight específico, no template genérico.
3. **Cadencia multi-canal** de 7-9 touchpoints en 14 días (email → email → call → email → Slack → email → breakup).
4. **Follow-up inteligente**: cada touch aporta valor nuevo, nunca "just following up".
5. **Booking rápido**: 2-3 horarios específicos, máximo 2 intercambios para cerrar.

**Límites**: máx 50 cold emails/día sin autorización, no cierra deals (solo agenda), respeta GDPR y unsubscribe.

### 2. `cobranza-dunning` — Cobranza / dunning

**Trabajo**: recuperar pagos vencidos y reducir churn (voluntario e involuntario).

**Stack MCP**: Stripe (facturación), Gmail (comunicación), CRM (customer record), Slack (escalar), Postgres (uso del producto), Twilio opcional (SMS).

**Metodología**:

1. **Clasificación del customer** antes de dunning:
   - Perfil A (churn involuntario puro): uso activo, fallo aislado → prioridad recuperación.
   - Perfil B (churn voluntario disfrazado): uso decayed + fallo pago → escalar a CS, no dunning.
   - Perfil C (signup nuevo sin payment): sospecha fraud → deadline corto.
2. **Secuencia escalada** D1 → D3 → D5 → D7 → D10 con tono y canal apropiados por etapa.
3. **Retención proactiva** para high-value customers (MRR > $500 o tenure > 6 meses): descuento one-time, pausa de cuenta, upgrade con mes gratis.
4. **Distinción data-driven**: consulta Postgres para detectar patrón de uso antes de escalar severidad.

**Límites**: nunca cobra dos veces, no reactiva sin payment method válido, refunds totales requieren aprobación humana.

### 3. `devops-incident-response` — DevOps / incident response

**Trabajo**: triage, contención, diagnóstico y PRs de fix ante incidentes.

**Stack MCP**: GitHub (código/PRs), Observability/Datadog (métricas/logs/traces), Slack (coordinación), Filesystem (edición de código), Postgres (data diagnosis), Kubernetes opcional (workloads).

**Framework de incident response** (5 fases):

1. **Triage** (< 5 min): clasificar SEV1-SEV4, declarar incident en Slack.
2. **Contención** (< 15 min): rollback, scale up, reiniciar, feature flag off, rate limit. Detener el sangrado antes de buscar root cause.
3. **Diagnóstico** (< 30 min para hipótesis): correlacionar deploys + métricas + logs, formular hipótesis, experimento confirmatorio.
4. **Fix**: branch `fix/INC-<id>-<desc>`, mínimo cambio, test que reproduzca el bug, PR con description completa + rollback plan.
5. **Postmortem** (5-7 días): timeline, root cause, action items con owners. Sin blame.

**Reglas críticas**: read-only por defecto, comunica antes de mutar, rollback > fix forward, escala a humano si > 15 min sin progreso.

---

## Skills incluidas

Cada skill es un `SKILL.md` con playbook detallado que el agente carga vía `read_skill` cuando necesita contexto profundo del dominio.

| Skill | Descripción | Agente |
| --- | --- | --- |
| `outbound-prospecting` | Definición de ICP, investigación con Firecrawl, estructura de email de cold outreach, cadencia multi-canal, personalización a escala, anti-patrones | sdr-autonomo |
| `dunning-playbooks` | Filosofía de dunning, clasificación de customers (perfiles A/B/C), secuencia estándar D1-D10, scripts de email por etapa, retención de high-value, métricas, compliance | cobranza-dunning |
| `incident-response` | Severidades SEV1-SEV4, roles (IC/Comms/Resolver/Scribe), 5 fases del incident, formato de updates en Slack, escalación, anti-patrones, template de postmortem | devops-incident-response |

---

## Servidores MCP

El plugin declara **12 servidores MCP** en `plugin.json` (con la estructura objeto que `plugin_engine.js` itera con `Object.entries`). La referencia canónica limpia está en `mcp/mcp-servers.json` (con la estructura `{ mcpServers: {...} }` que `mcp_utils.js` carga correctamente).

| MCP | Uso | Status |
| --- | --- | --- |
| `firecrawl` | Scraping de company sites, detección de trigger events | oficial (mendableai) |
| `crm` (HubSpot) | Contacts, companies, deals, activities | oficial (modelcontextprotocol) |
| `gmail` | Outreach y emails de dunning | oficial (modelcontextprotocol) |
| `calendar` | Booking de reuniones | oficial (modelcontextprotocol) |
| `slack` | Notificaciones y coordinación | oficial (modelcontextprotocol) |
| `stripe` | Invoices, reintentos, payment methods | oficial (modelcontextprotocol) |
| `postgres` | Estado de customers y data diagnosis | oficial (modelcontextprotocol) |
| `github` | Código, branches, PRs, issues | oficial (modelcontextprotocol) |
| `observability` (Datadog) | Métricas, logs, traces | oficial (modelcontextprotocol) |
| `filesystem` | Edición de código y runbooks | oficial (modelcontextprotocol) |
| `twilio` | SMS de dunning crítico | **opcional** |
| `kubernetes` | Inspección/reinicio de workloads | **opcional** |

> **Nota sobre disponibilidad de paquetes npm**: algunos `@modelcontextprotocol/server-*` (gmail, calendar, stripe, twilio, kubernetes, datadog) pueden estar en preview o ser community-maintained al momento de instalación. Si `npx -y <pkg>` falla, busca el nombre correcto en el repo oficial [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers) o en npm. El `mcp/mcp-servers.json` incluye el campo `_alternatives` donde aplica.

---

## Instalación

### Opción A — Instalación vía plugin engine de AgentLag (recomendada para agentes + skills)

```bash
# Desde el directorio raíz del repo AgentLag
agentlag plugin install ./examples/plugins/autonomous-ops

# O desde fuera del repo, pasando la ruta absoluta
agentlag plugin install /ruta/completa/a/AgentLag_npm/examples/plugins/autonomous-ops
```

Esto copia los 3 agentes a `~/.agentlag/agents/` (con prefijo `autonomous-ops__`) y las 3 skills a `~/.agentlag/plugins/installed/autonomous-ops/skills/`.

### Opción B — Registrar los MCP servers manualmente (recomendado para MCPs)

Debido a un bug en `plugin_engine.js` (escribe las keys MCP fuera del wrapper `mcpServers`), los MCP servers instalados vía `plugin install` **no se cargan automáticamente**. Usa el script helper incluido para registrarlos correctamente:

```bash
# Instalar TODOS los servers en scope user (~/.agentlag/mcp.json)
node examples/plugins/autonomous-ops/scripts/install-mcp.js

# Instalar solo los servers de un agente específico
node examples/plugins/autonomous-ops/scripts/install-mcp.js --only firecrawl,crm,gmail,calendar,slack

# Ver qué haría sin escribir nada
node examples/plugins/autonomous-ops/scripts/install-mcp.js --dry-run

# Listar servers disponibles
node examples/plugins/autonomous-ops/scripts/install-mcp.js --list

# Instalar en scope project (./.agentlag/mcp.json) en vez de user
node examples/plugins/autonomous-ops/scripts/install-mcp.js --scope project

# Agregar prefijo "autonomous-ops__" a las keys (evita colisiones con otros plugins)
node examples/plugins/autonomous-ops/scripts/install-mcp.js --prefix
```

### Opción C — Instalación manual

Copia los archivos a mano:

```bash
# Agentes (con prefijo para evitar colisiones)
cp examples/plugins/autonomous-ops/agents/*.json ~/.agentlag/agents/

# Renombrar con prefijo
mv ~/.agentlag/agents/sdr-autonomo.json ~/.agentlag/agents/autonomous-ops__sdr-autonomo.json
mv ~/.agentlag/agents/cobranza-dunning.json ~/.agentlag/agents/autonomous-ops__cobranza-dunning.json
mv ~/.agentlag/agents/devops-incident-response.json ~/.agentlag/agents/autonomous-ops__devops-incident-response.json

# Skills
mkdir -p ~/.agentlag/plugins/installed/autonomous-ops/skills
cp -r examples/plugins/autonomous-ops/skills/* ~/.agentlag/plugins/installed/autonomous-ops/skills/

# MCP servers — fusionar mcp/mcp-servers.json en ~/.agentlag/mcp.json
# (usa el script helper o hazlo a mano)
```

---

## Configuración de credenciales

Los placeholders `REEMPLAZAR_CON_*` en `plugin.json` y `mcp/mcp-servers.json` deben sustituirse con credenciales reales. Tienes dos caminos:

### Camino 1 — Editar el archivo mcp.json directamente

Después de correr `install-mcp.js`, edita `~/.agentlag/mcp.json` y reemplaza cada `REEMPLAZAR_CON_*` con el valor real:

```json
{
  "mcpServers": {
    "firecrawl": {
      "command": "npx",
      "args": ["-y", "firecrawl-mcp"],
      "env": { "FIRECRAWL_API_KEY": "fc-tu-key-real-aqui" }
    },
    ...
  }
}
```

### Camino 2 — Exportar variables de entorno en tu shell

`mcp_utils.js` hace `env: { ...process.env, ...(config.env || {}) }` al spawnar el proceso MCP. Esto significa que las variables que exportes en tu shell se heredan automáticamente. Puedes dejar el archivo con placeholders y exportar las reales:

```bash
# En ~/.bashrc o ~/.zshrc
export FIRECRAWL_API_KEY="fc-..."
export HUBSPOT_API_KEY="..."
export SLACK_BOT_TOKEN="xoxb-..."
export STRIPE_SECRET_KEY="sk_live_..."
export GITHUB_PERSONAL_ACCESS_TOKEN="ghp_..."
export DATADOG_API_KEY="..."
export DATADOG_APP_KEY="..."
export TWILIO_ACCOUNT_SID="AC..."
export TWILIO_AUTH_TOKEN="..."
export TWILIO_FROM_NUMBER="+15551234567"
export DATABASE_URL="postgresql://user:pass@host:5432/db"
```

Las variables exportadas tienen prioridad si las quitas del campo `env` del config. Si las dejas en ambos, el valor del archivo `env` sobreescribe al del shell.

### Credenciales OAuth (Gmail, Calendar)

Gmail y Google Calendar requieren OAuth credentials (no API keys simples):

1. Ve a [Google Cloud Console](https://console.cloud.google.com/).
2. Crea un proyecto, habilita Gmail API y Google Calendar API.
3. Crea OAuth 2.0 credentials (tipo Desktop App).
4. Descarga el JSON de credentials y guárdalo en `~/.agentlag/credentials/google.json`.
5. La primera vez que el MCP server corra, abrirá un browser para consent.

### Verificación

```bash
# Lista los servers MCP cargados
agentlag mcp list

# Deberías ver algo como:
# 🔌 Servidores MCP configurados:
#   • [user] firecrawl: npx -y firecrawl-mcp
#   • [user] crm: npx -y @modelcontextprotocol/server-hubspot
#   ...
```

---

## Uso

Una vez instalado el plugin y configurados los MCPs, los agentes se invocan como subagentes desde una sesión de AgentLag. El agente principal puede delegar tareas:

```
> Delega a sdr-autonomo: investiga la empresa acme.com, identifica 3 decision-makers y crea una secuencia de outreach de 5 touchpoints.
> Delega a cobranza-dunning: revisa las invoices vencidas de los últimos 7 días y aplica la secuencia de dunning correspondiente.
> Delega a devops-incident-response: la alerta de Datadog "API 5xx spike" acaba de dispararse, triagea y contiene.
```

Cada agente responderá con un resumen estructurado de qué hizo, qué registró en los sistemas correspondientes y qué sigue.

### Activar/desactivar el plugin

```bash
agentlag plugin list
agentlag plugin activate autonomous-ops
agentlag plugin deactivate autonomous-ops
agentlag plugin uninstall autonomous-ops
```

---

## Notas técnicas

### Por qué `allowedTools` no está definido en los agentes

Los agentes operativos (SDR, Cobranza, DevOps) necesitan acceso a las herramientas MCP dinámicas (Firecrawl, Stripe, GitHub, etc.) cuyos nombres se desconocen hasta runtime. El campo `allowedTools` de AgentLag funciona como **whitelist**: si lo defines, solo esas tools pasan. Por eso se omite en los 3 agentes — así heredan todas las tools nativas + todas las MCP disponibles.

### Bug conocido en `plugin_engine.js`

A la fecha de este plugin, el `plugin_engine.js` de AgentLag escribe las keys de MCP servers a **nivel top-level** de `~/.agentlag/mcp.json` (fuera del wrapper `mcpServers`), lo cual hace que `mcp_utils.js` no las cargue. El script `scripts/install-mcp.js` incluido aquí hace el merge correctamente dentro de `mcpServers` y además migra keys top-level preexistentes al wrapper (para no perder config anterior).

### Formato de `mcpServers` en `plugin.json`

Se usa el formato **objeto** (no array) porque `plugin_engine.js` itera con `Object.entries(manifest.mcpServers || {})`. El ejemplo `dev-toolkit` del repo usa formato array, lo cual es inconsistente con el engine y produce keys numéricas (`pluginName__0`) que no funcionan.

### Modelos y providers

Los 3 agentes usan `provider: "groq"` y `model: "qwen/qwen3-32b"` por defecto (igual que los agentes del plugin `dev-toolkit`). Puedes override-ear editando cada `.json` o cambiando el provider/model global con `/provider` en la sesión de AgentLag — pero el override del agent file toma precedencia al ejecutarse como subagente.

### Compatibilidad de paquetes MCP

Los nombres de paquetes npm pueden cambiar. Si `npx -y <pkg>` falla al cargar un server:

```bash
# Verifica si el paquete existe
npm view @modelcontextprotocol/server-gmail

# Busca alternativas
npm search mcp gmail
```

Alternativamente, muchos MCP servers tienen versión Docker o Python. Revisa el repo oficial [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers) para la lista actualizada.

---

## Licencia

MIT — heredada del repo AgentLag principal.
