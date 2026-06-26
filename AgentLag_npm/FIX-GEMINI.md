# Fix: Error 400 de Google Gemini "Unknown name exclusiveMinimum"

## Problema

Al usar AgentLag con Google Gemini (`gemini-3.0-flash` u otros modelos Google),
el agente fallaba al iniciar cualquier conversación con:

```
[GoogleGenerativeAI Error]: Error fetching from
 https://generativelanguage.googleapis.com/v1beta/models/gemini-3.0-flash:generateContent:
 [400 Bad Request] Invalid JSON payload received.
 Unknown name "exclusiveMinimum" at 'tools[0].function_declarations[4].parameters.properties[4].value':
 Cannot find field.
```

## Causa raíz

Google Gemini **no soporta** los keywords JSON Schema `exclusiveMinimum` ni
`exclusiveMaximum`. Sin embargo, varias herramientas de AgentLag usaban la
restricción Zod `.positive()`, que LangChain traduce exactamente a
`exclusiveMinimum: 0` al serializar el schema para el proveedor.

Las 4 herramientas afectadas eran:

| # | Tool | Campo | Línea original |
|---|------|-------|----------------|
| 4 | `list_directory` | `maxResults` | `z.number().int().positive().max(200)` |
| 6 | `apply_patch`    | `timeoutMs` | `z.number().int().positive().max(MAX_SHELL_TIMEOUT_MS)` |
| 7 | `run_shell`      | `timeoutMs` | `z.number().int().positive().max(MAX_SHELL_TIMEOUT_MS)` |
| 13| `manage_memory`  | `ttlDays`   | `z.number().positive().optional()` |

## Solución aplicada

En `tools.js` se reemplazó `.positive()` por `.min(1)` en las 4 definiciones.
Semánticamente equivalente para los enteros (`.int().positive()` rechaza 0 y
negativos; `.int().min(1)` rechaza 0 y negativos — mismo comportamiento).
Para `ttlDays` (float opcional) se usó `.min(1)` (un día es la unidad mínima
razonable; el campo es opcional y se puede omitir).

### Diferencia para Gemini

| Zod | JSON Schema emitido | ¿Gemini lo acepta? |
|-----|---------------------|---------------------|
| `.positive()` | `exclusiveMinimum: 0` | ❌ No |
| `.min(1)`     | `minimum: 1`          | ✅ Sí |
| `.gt(5)`      | `exclusiveMinimum: 5` | ❌ No |
| `.gte(5)`     | `minimum: 5`          | ✅ Sí |
| `.lt(5)`      | `exclusiveMaximum: 5` | ❌ No |
| `.lte(5)`     | `maximum: 5`          | ✅ Sí |

## Archivos modificados

- `tools.js` — 4 líneas cambiadas (280, 326, 352, 532)

## Cómo aplicar manualmente (si prefieres no reemplazar todo)

Si ya tienes el proyecto modificado y solo quieres aplicar este fix:

```bash
# En tools.js, reemplazar:
#   z.number().int().positive().max(200)
# por:
#   z.number().int().min(1).max(200)
#
# Y todas las ocurrencias de:
#   z.number().int().positive().max(MAX_SHELL_TIMEOUT_MS)
# por:
#   z.number().int().min(1).max(MAX_SHELL_TIMEOUT_MS)
#
# Y:
#   z.number().positive().optional()
# por:
#   z.number().min(1).optional()

sed -i 's/z\.number()\.int()\.positive()/z.number().int().min(1)/g' tools.js
sed -i 's/z\.number()\.positive()\.optional()/z.number().min(1).optional()/g' tools.js
```

## Recomendación para futuras herramientas

Si añades nuevas herramientas y quieres que sean compatibles con Gemini:

- **Evita** `.positive()`, `.negative()`, `.gt(x)`, `.lt(x)` en schemas Zod.
- **Usa** `.min(x)` / `.max(x)` (inclusivos) o `.gte(x)` / `.lte(x)`.
- Para strings, `.min(1)` es compatible.
- Para arrays, `.min(1)` es compatible.
