---
name: incident-response
description: Runbooks de incident response: severidades, roles, contención, diagnóstico y postmortem sin blame
---

# Incident Response Runbook

## Principios fundacionales

El incident response es una disciplina que mezcla técnica y comunicación. Cuatro principios gobiernan todo lo demás:

1. **Availability y data integrity > todo lo demás**: si tienes que elegir entre escribir un fix elegante y contener el sangrado rápido, contiene primero. El fix elegante puede esperar; el customer sufriendo no.
2. **Comunicación > heroísmo**: un incident manager que actualiza Slack cada 15 min con 'still investigating, last action X, next step Y' vale más que un genio silencioso que resuelve solo a los 40 min sin que nadie sepa qué pasó.
3. **Sin blame**: los incidents son fallos de systems, no de personas. Si un deploy rompió prod, la pregunta es 'por qué el sistema permitió que ese deploy llegue a prod', no 'quién lo mergeó'.
4. **Evidencia > intuición**: cada afirmación sobre root cause debe estar respaldada por una métrica, log line o commit. 'Creo que es la DB' no cuenta. 'Vi que los query times en Postgres subieron 10x a las 14:32, coincidente con el deploy de la migración X' sí cuenta.

## Clasificación de severidad

La severidad determina la respuesta. Clasifica conservadoramente: si dudas entre SEV2 y SEV3, trata como SEV2.

### SEV1 — Critical
**Definición**: servicio principal caído para todos los users, data loss confirmado o probable, security breach activo.

**Respuesta**:
- Pagea on-call inmediatamente (no esperes a 'ver si se resuelve solo').
- Declara incident en Slack #incidents con tag @here.
- Abre war room (Zoom/Meet) — todos los responders se unen.
- Updates cada 15 min en Slack, incluso si no hay progreso.
- Status page pública debe actualizarse dentro de 30 min.
- Postmortem obligatorio dentro de 5 días hábiles.

**Ejemplos**: API devuelve 500 para >50% de requests, DB inaccesible, leak de secrets en repo público detectado, RANSOMware en producción.

### SEV2 — High
**Definición**: degradación significativa de funcionalidad core, impacto a subset de users, degradación de performance > 3x baseline.

**Respuesta**:
- Trabaja activamente, notifica #incidents.
- Updates cada 30 min.
- Status page pública si impacto > 5% de users.
- Postmortem obligatorio dentro de 7 días hábiles.

**Ejemplos**: latencia de login subió de 200ms a 2s, webhook delivery fallando para 20% de integraciones, search feature rota.

### SEV3 — Medium
**Definición**: issue aislado, workaround disponible, impacto limitado a pocos users o edge cases.

**Respuesta**:
- Crea ticket, asigna owner.
- Trabaja en próximo sprint si no es urgente.
- No requiere canal de incident activo.
- Postmortem recomendado si es recurrente.

**Ejemplos**: export de CSV falla para accounts con > 100k rows, email notifications no se envían para un dominio específico.

### SEV4 — Low
**Definición**: nuisance, cosmetic, sin impacto funcional.

**Respuesta**: log para batch fix mensual.

## Roles durante un incident

- **Incident Commander (IC)**: coordina, no necesariamente ejecuta. Decide prioridades, asigna tareas, comunica. Si tú (el agente) eres el primer respondiente, eres IC hasta que alguien con más contexto tome el rol. Cede IC explícitamente: 'IC handoff to @persona — seguimos en este canal'.
- **Comms Lead**: redacta updates internos y externos (status page). En SEV1, es un rol separado del IC.
- **Resolver(s)**: ejecutan contención y fix. Reportan progreso al IC, no deciden prioridades.
- **Scribe**: documenta timeline en el thread del incident (acciones, timestamps, evidencia). En SEV2/SEV3 el IC puede hacer de scribe; en SEV1 debe ser rol separado.

## Fases del incident

### Fase 1: Triage (objetivo: < 5 min desde alerta)
- Confirma que la alerta es real (no false positive, no degradación esperada por tráfico).
- Clasifica severidad.
- Declara incident en Slack.
- Identifica blast radius: ¿qué users/servicios/features afectados? Usa observability para dimensionar.
- Comunicación inicial: '🚨 [SEVx] Incident: <descripción>. IC: <nombre>. Investigando. Blast radius: <X>.'

### Fase 2: Contención (objetivo: < 15 min)
El objetivo NO es entender la root cause. Es detener el sangrado.

Acciones válidas de contención:
- **Rollback deploy**: si hay un deploy en la última hora sospechoso, rollback inmediato. No esperes a confirmar — el rollback es reversible.
- **Scale up**: si la teoría es carga, escala horizontalmente.
- **Reiniciar workload**: pods, services, processes. Último recurso, no primera opción.
- **Disable feature flag**: si la teoría es una feature nueva, apágala vía flag.
- **Bloquear tráfico**: si un componente está down y afecta al resto, redirige tráfico (failover) o bloquéalo para no envenenar downstream.
- **Rate limiting**: si hay abuso o spike anómalo, activa rate limiting temporal.

Documenta cada acción con timestamp: '14:32 - Rollback deploy abc123 → staging confirmado OK. Verificando prod.'

### Fase 3: Diagnóstico (objetivo: hipótesis en < 30 min)
Ahora sí, busca la root cause.

Metodología:
1. **Timeline correlation**: alinea deploy markers (GitHub), métricas (Datadog) y logs. Busca qué cambió en la ventana de inicio del incident.
2. **Log analysis**: busca error spikes, cambios en patterns, latency increases. Filtra por servicio afectado.
3. **Trace analysis**: sigue un request end-to-end. Identifica dónde se acumula latency o dónde falla.
4. **Query patterns (Postgres)**: si sospechas DB, check slow queries, locks, connection pool saturation.
5. **Hypothesis + experiment**: formula 'Creo que X está pasando por Y. Voy a verificar Z.' Ejecuta el experimento. Si confirma, vas a fix. Si no, iteras.

Anti-patrones en diagnóstico:
- **Tunnel vision**: no te ancles a la primera hipótesis. Si después de 10 min no confirmas, broadena.
- **Blind changes**: no hagas cambios 'a ver si funciona'. Cada cambio debe tener hipótesis detrás.
- **Working in silence**: si estás > 5 min sin update, comunica estado aunque sea 'still looking at logs, no clear pattern yet'.

### Fase 4: Fix (objetivo: PR abierto ASAP)
- Crea branch: `fix/INC-<id>-<breve-desc>`.
- Mínimo cambio posible. No aproveches para refactorizar.
- Test que reproduzca el bug: debe fallar sin tu fix, pasar con él.
- PR description incluye:
  - Contexto del incident (link al thread de Slack).
  - Root cause (lo que confirmaste, no lo que sospechabas).
  - Qué hace el fix y por qué resuelve.
  - Test agregado.
  - Plan de rollback del fix (cómo revertir si el fix empeora).
  - ¿Qué prevención a largo plazo? (telemetry, guardrails, tests) — para el postmortem.
- Notifica en Slack: 'PR abierto: <link>. Reviewer urgente: @persona.'

### Fase 5: Resolution
- Fix mergeado y deployed.
- Verifica que métricas vuelven a baseline.
- Comunica resolución: '✅ [SEVx] Resolved: <descripción>. Root cause: <X>. Fix: <link PR>.'
- Status page pública actualizada.
- Recopila datos para postmortem: timeline completo, métricas clave, decisiones tomadas.

### Fase 6: Postmortem (dentro de 5-7 días)
Template:
```
# Postmortem: <nombre del incident>

## Resumen
- Fecha:
- Duración:
- Severidad:
- Impacto (users/requests/revenue afectado):

## Timeline
- HH:MM - Alerta detectada
- HH:MM - Triage completado, SEVx declarado
- HH:MM - Contención aplicada (descripción)
- HH:MM - Hipótesis confirmada
- HH:MM - Fix deployado
- HH:MM - Resolución confirmada

## Root cause
Descripción técnica detallada. Cómo llegó el bug a prod. Por qué los tests no lo catchearon.

## Qué fue bien
- Acciones que funcionaron. Cosas a repetir.

## Qué fue mal
- Cosas que retrasaron la resolución. Cosas a evitar.

## Aprendizajes
Insights no obvios que salieron del incident.

## Action items
- [ ] <acción> — owner — fecha
- [ ] <acción> — owner — fecha
```

## Comunicación durante el incident

### Updates internos (Slack #incidents)
Formato estricto cada 15 min (SEV1) o 30 min (SEV2):
```
[Update HH:MM] SEVx - <servicio>
Status: investigating | contained | fixing | resolved
Blast radius: <users/servicios afectados>
Última acción: <qué hiciste en últimos 15 min>
Próximo paso: <qué vas a hacer ahora>
Necesita: <escalación/recursos/blockers, o 'nada'>
```

### Status page pública
- Primer update dentro de 30 min del incident declarado.
- Updates cada 30 min mientras dure.
- Update final al resolver.
- Tono: factual, no marketing. 'Investigating elevated error rates on the API' no 'We're working hard to resolve this issue'.

### Escalación
Escala a humano cuando:
- > 15 min sin progreso en diagnóstico.
- Contención requiere acción irreversible (delete data, drop table, disable auth).
- Blast radius crece en vez de reducirse.
- Necesitas acceso que no tienes (prod DB write, infra admin).
- Sospecha de security breach (SIEMPRE escala a security team, no intentses contener solo).

## Anti-patrones

- **'Quick fix' en prod sin test**: si no reproduce el bug, no confíes que lo resuelve.
- **Hero culture**: el IC que trabaja solo 2h sin delegar crea bus factor y retrasa la resolución.
- **Postmortem con blame**: 'Juan deployó el bug' mata la cultura de reporting. Reemplaza con 'el proceso de review permitió que un cambio sin test llegara a prod'.
- **Incident sin postmortem**: si no documentaste, repetirás. SEV1/SEV2 sin postmortem es fallo de proceso.
- **Alert fatigue**: si declares SEV1 cada semana, nadie responde cuando es real. Tuning de alertas es parte del incident response.
- **'Resolved' sin verificación**: no declares resuelto hasta que métricas estén en baseline por 15+ min. Un fix que 'parece funcionar' puede tener second-order effects.
