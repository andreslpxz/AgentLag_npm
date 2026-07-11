---
name: outbound-prospecting
description: Playbooks de prospección outbound: investigación de ICP, copy personalizado y cadencias multi-canal para SDR autónomos
---

# Outbound Prospecting Playbook

## Definición del ICP (Ideal Customer Profile)

Antes de lanzar cualquier secuencia, valida que el target encaja en el ICP. Un ICP bien definido tiene cinco dimensiones verificables:

- **Firmografía**: industria, tamaño (employees, revenue), geografía, etapa de empresa (seed, series A-B, public).
- **Technographics**: stack tecnológico actual (usa Firecrawl para detectar tools en el sitio: scripts, meta tags, subdominios).
- **Trigger events**: signals recientes que indican时机: funding rounds, leadership changes, product launches, hiring spikes (especialmente en roles adyacentes a tu solución), expansión a nuevos mercados.
- **Pain signals**: problemas que tu producto resuelve y que el prospect manifiesta (blog posts, quejas en redes, comentarios en communities, job postings que implican una necesidad).
- **Decision-making unit**: quién firma, quién influencia, quién bloquea. Mapea al menos 2-3 contacts por account.

Un account sin al menos 2 de estas dimensiones alineadas no merece outreach personalizado — va a un batch templated de menor prioridad.

## Investigación previa al contacto

Cada email de primera contacto debe referenciar algo específico que encontraste en los últimos 7 días. Fuentes que Firecrawl puede procesar:

- **Página de About/Team**: identifica decision-makers reales y sus backgrounds.
- **Blog/Resources**: detecta temas que les importan y el tono editorial.
- **Careers/Jobs page**: hiring signals (qué roles buscan implica qué problemas tienen).
- **Press/News section**: announcements recientes.
- **Pricing page**: si tienen pricing público, entiende su modelo y donde tu solución puede undercut o diferenciar.
- **Product/docs**: entiende qué hacen técnicamente para no decir obviedades.

Regla: si no puedes escribir una línea de personalización específica basada en tu investigación, no escribas el email. La personalización genérica ('I love what you're building at X') es peor que no contactar.

## Estructura del email de cold outreach

### Subject line
- Máximo 6 palabras. Idealmente 3-4.
- Específica al prospect, no al remitente.
- Evita spam triggers: free, guarantee, act now, limited time, $$$.
- Patrones que funcionan: pregunta específica, referencia a trigger event, observación contrarian.

### Opening (primera línea)
- NO empieces con 'I hope this finds you well' o 'My name is X'.
- Empieza con la observación personalizada que derivó de tu investigación.
- Una línea, máximo dos.

### Body
- Una idea central. Si tienes dos ideas, split en dos emails.
- Conecta el pain point a tu solución sin pitchear features. Habla en outcomes.
- Máximo 120 palabras total. Si no cabe, recorta.

### CTA (Call To Action)
- UN solo CTA por email. Múltiples CTAs paralizan.
- Bajo friction: 'Would you be open to a 15-min call next Tuesday or Wednesday?' (ofrece días específicos).
- No: 'Let me know if you'd like to learn more' (sin CTA real).

### Signature
- Nombre real, título, empresa, link. Nada más.

## Cadencia multi-canal

Una cadencia típica para outbound B2B SaaS de mid-market:

| Día | Canal | Contenido |
|-----|-------|-----------|
| 1 | Email | Primer contacto con personalización fuerte |
| 3 | Email | Follow-up con nuevo angle (no 'just following up') |
| 4 | LinkedIn | Connection request con nota personalizada |
| 6 | Call | Cold call de 30 seg con voicemail si no contesta |
| 8 | Email | Share un resource relevante (case study, insight) |
| 11 | Slack/Email | Pregunta directa: 'Is this a priority right now? If not, I'll stop reaching out.' |
| 14 | Email | Breakup email: 'Closing the loop. If timing changes, here's how to reach me.' |

Reglas de la cadencia:
- Si el prospect responde en cualquier punto, sal de la cadencia y entra en modo conversación.
- Si el prospect pide parar, marca unsubscribed en CRM inmediatamente. No agregues a otra secuencia.
- Ajusta la cadencia según signal: si abrió 3 veces pero no respondió, acelera un touchpoint. Si no abrió ninguna, alarga.

## Personalización a escala

No personalices por personalizar. La personalización relevante tiene tres niveles:

1. **Nivel 1 (superficial)**: mencionar la empresa y el rol. Todos lo hacen. Valor bajo.
2. **Nivel 2 (específica)**: referenciar un trigger event o un contenido que publicaron. Valor medio.
3. **Nivel 3 (insight)**: hacer una observación que el prospect no había considerado, basada en patrones que ves en su industria. Valor alto — estos emails suelen tener >15% reply rate.

Apunta a Nivel 2 mínimo. Nivel 3 solo cuando tengas un insight real; forzarlo suena pretencioso.

## Seguimiento y cualificación

Cuando un prospect responde positivamente, el objetivo es agendar en máximo 2 intercambios. Patrones:

- Si responde con interés vago ('Tell me more'): responde con una pregunta específica sobre su situación + ofrece 2 horarios.
- Si responde con pregunta específica: responde la pregunta + ofrece 2 horarios.
- Si pide más info: envíale UN resource (no deck gigante) + ofrece 2 horarios.
- Si dice 'not now': pregunta 'When would be a better time to reconnect?' y marca reminder en CRM.

Nunca mandes más de 2 emails en el intercambio de booking. Si después de 2 no se agendó, propón un horario y cierra: 'I'll send a calendar invite for Tuesday at 2pm — let me know if that works or propose another slot.'

## Anti-patrones a evitar

- **Spray and pray**: mandar el mismo email a 500 personas. Funciona en 2015, no en 2025.
- **Over-personalization**: 3 párrafos de research asfixian. Una línea de personalización basta.
- **Multiple CTAs**: 'Book a call, or check our pricing, or reply with questions'. Confunde.
- **Lying about relationships**: 'Your colleague X suggested I reach out' cuando no es verdad. Quema el account.
- **Generic case studies**: 'We helped a company like yours increase revenue 30%'. Sin nombre ni contexto, no es creíble.
- **Ignoring negative responses**: un 'no' es data valiosa. Loguea la razón en CRM y aprende.
