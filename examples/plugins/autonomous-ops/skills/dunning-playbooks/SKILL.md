---
name: dunning-playbooks
description: Secuencias de dunning por severidad, reglas de reintento y scripts de retención para maximizar recuperación y reducir churn
---

# Dunning & Collections Playbook

## Filosofía del dunning moderno

El dunning no es cobranza agresiva: es comunicación que protege revenue sin quemar la relación con customers legítimos. La meta no es 'cobrar a toda costa' sino 'maximir recovery rate de customers que quieren quedarse, identificar temprano a los que se quieren ir, y minimizar fricción para todos'.

Tres principios que gobiernan toda decisión de dunning:

1. **Empatía primero**: la mayoría de los fallos de pago son problemas técnicos (tarjeta expirada, fondos momentáneos, cambio de banco), no decisions de cancelar. Trata al customer como alguien con quien quieres seguir trabajando.
2. **Decisión basada en data**: antes de escalar la severidad, consulta el patrón de uso del customer. Dunning agresivo a alguien que ya dejó de usar el producto acelera el churn voluntario.
3. **Acción clara en cada touch**: cada email/SMS debe tener un CTA único y fácil de ejecutar. El customer no debería tener que pensar '¿qué hago ahora?'.

## Clasificación del customer antes del dunning

Antes de entrar a la secuencia de dunning, clasifica al customer en uno de tres perfiles. Esto determina el tono y la intensidad:

### Perfil A: Churn involuntario puro
- **Signals**: uso activo del producto (logins recientes, feature usage estable), fallo de pago aislado o primero.
- **Estrategia**: prioridad máxima de recuperación. Tono amistoso, asume problema técnico. Ofrece prorrogar servicio sin suspensión si actualizan payment method en 7 días.
- **Tono**: 'Parece que hubo un problema con tu tarjeta — queremos ayudarte a resolverlo sin interrumpir tu uso.'

### Perfil B: Churn voluntario disfrazado
- **Signals**: uso decayed en últimos 30-60 días (logins esporádicos, feature usage cayendo), fallo de pago coincidente o posterior.
- **Estrategia**: el dunning no va a recuperarlos. Escala a Customer Success con contexto del decaimiento. CS ofrece call de retention. NO insistas con emails de pago.
- **Tono**: transparente. 'Notamos que no has estado usando X tanto — ¿hay algo que podamos mejorar? También vimos un problema con tu pago, lo pausamos por ahora.'

### Perfil C: Customer nuevo que falla en onboarding payment
- **Signals**: cuenta creada hace < 14 días, fallo de pago en primera factura.
- **Estrategia**: sospecha de fraud o de signup desinteresado. Tono directo, corto deadline. Si no responde en 5 días, cancela sin ceremony.
- **Tono**: 'Tu cuenta trial necesita un payment method válido para continuar. Tienes hasta el DATE o la cuenta será cerrada.'

## Secuencia de dunning estándar (Perfil A)

| Día | Canal | Asunto | Tono | Acción |
|-----|-------|--------|------|--------|
| D1 | Email | Problema con tu pago | Amistoso, asume error técnico | Link a update payment method |
| D3 | Email | Recordatorio: tu factura sigue pendiente | Directo, referencia invoice específica | Link + ofrece ayuda |
| D5 | Email + SMS (si Twilio) | Tu cuenta será suspendida en 48h | Claro, deadline específico | Link + deadline |
| D7 | Acción en Stripe | — | Suspender servicio (subscription → unpaid) | Email confirmando suspensión |
| D10 | Email final | Cuenta cancelada por falta de pago | Cierre formal, deja puerta abierta | Cancela en Stripe + log en CRM |

Reglas de la secuencia:
- Si el customer actualiza payment method en cualquier punto, reactiva inmediatamente, reintenta el cobro y sale de la secuencia.
- Si el customer responde (aunque sea para pedir más tiempo), pausa la secuencia automática y entra en modo conversación.
- Si el customer pide cancelar, ejecuta la cancelación sin forzar más dunning.

## Scripts de email por etapa

### D1 — Amistoso
```
Subject: Problema con tu pago en [PRODUCTO]

Hola [NOMBRE],

Parece que el último pago de tu suscripción no se procesó correctamente.
Suele pasar por tarjetas expiradas o fondos momentáneos — nada grave.

Puedes actualizar tu método de pago en este link:
[LINK]

Una vez actualizado, el cobro se reintenta automáticamente y tu servicio
continúa sin interrupciones.

¿Algún problema? Responde a este email y lo resolvemos.

[FOOTER]
```

### D3 — Directo
```
Subject: Tu factura #[INVOICE] sigue pendiente

Hola [NOMBRE],

Te escribimos el [DATE] sobre un problema con tu pago. Aún no lo vemos
resuelto, así que queríamos chequear antes de que afecte tu servicio.

Detalle de la factura pendiente:
- Factura: #[INVOICE]
- Monto: $[AMOUNT]
- Vencimiento: [DATE]

Actualiza tu payment method acá: [LINK]

Si ya lo resolviste, ignorá este email. Si necesitas más tiempo,
respondé y lo coordinamos.

[FOOTER]
```

### D5 — Crítico con deadline
```
Subject: [URGENTE] Tu cuenta será suspendida en 48 horas

Hola [NOMBRE],

No hemos recibido respuesta sobre tu pago pendiente. Tu cuenta será
suspendida el [DATE+2] si no se regulariza.

Para evitar la suspensión:
1. Actualiza tu payment method: [LINK]
2. El cobro se reintenta automáticamente

Si necesitas ayuda o más tiempo, respondé a este email AHORA —
podemos extender el deadline si hay conversación activa.

[FOOTER]
```

### D7 — Confirmación de suspensión
```
Subject: Tu cuenta en [PRODUCTO] ha sido suspendida

Hola [NOMBRE],

Tu cuenta fue suspendida por falta de pago. No se eliminó ninguno de
tus datos — todo está intacto y esperando reactivación.

Para reactivar:
1. Actualiza tu payment method: [LINK]
2. El cobro pendiente se procesa automáticamente
3. Tu cuenta se reactiva en minutos

Si prefieres cancelar definitivamente, respondé y lo procesamos.

[FOOTER]
```

### D10 — Cierre
```
Subject: Confirmación de cancelación de cuenta

Hola [NOMBRE],

Tras múltiples intentos de contacto sin respuesta, tu cuenta en
[PRODUCTO] ha sido cancelada por falta de pago.

Si esto fue un error o quieres reactivar, estamos a un email de distancia.
Tu data se conserva por [N] días antes del purge definitivo.

Gracias por habernos dado la oportunidad de trabajar contigo.

[FOOTER]
```

## Reglas de retención para high-value customers

Para customers con MRR > $500 o tenure > 6 meses o plan annual, aplica retención proactiva ANTES de la secuencia estándar:

- Al detectar el fallo de pago, envía un email personalizado (no template) del CSM owner, no del sistema.
- Ofrece opciones: pausar la cuenta 30 días sin cargo, descuento one-time del 50% en la invoice pendiente, upgrade de plan con el próximo mes gratis.
- Si el customer responde pero no puede pagar ahora, pausa la cuenta (no suspendas). Reactiva cuando él confirme.
- Para accounts > $5000 MRR, llama por phone (si tienes número) antes del D5.

## Reporting y métricas clave

Mide la efectividad del dunning con:

- **Recovery rate**: % de accounts en dunning que se recuperan. Benchmark sano: 60-70% para Perfil A, 30-40% global.
- **Time to recover**: días promedio desde D1 hasta recovery. Benchmark: < 5 días.
- **Churn from dunning**: % de accounts que terminan cancelados. Si > 40% global, revisa si estás clasificando mal Perfiles B como A.
- **Dunning-related support tickets**: si muchos customers escriben a soporte por emails de dunning, el tono/messaging está mal.

Cada semana, genera un summary en Slack #dunning-ops con: total accounts en dunning, monto pendiente, recuperado esta semana, cancelados esta semana, top 5 accounts pendientes por monto.

## Compliance y límites legales

- Respeta horarios razonables para SMS (no enviar antes de 8am ni después de 9pm hora local del customer).
- Permite opt-out explícito: si el customer dice 'stop contacting me', cesa toda comunicación de dunning y escala a collections manual si el monto lo justifica.
- No amenaces con acciones que no vas a tomar (p.ej. 'te enviaremos a collections' si no es cierto).
- Para customers en EU/UK, considera GDPR: el customer puede pedir deletión de data incluso con deuda pendiente; la deuda se cobra por canal separado, no retengas data personal como rehén.
- Documenta cada interacción en el CRM con timestamp, canal, contenido enviado y response del customer. Es tu evidencia en caso de disputa.
