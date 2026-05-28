/**
 * Optimiza la salida de herramientas para ahorrar tokens.
 * Si el output es muy largo, lo trunca y añade un resumen o aviso.
 */
const MAX_OUTPUT_CHARS = 2000;

export function optimizeToolOutput(output) {
    if (typeof output !== 'string') {
        try {
            output = JSON.stringify(output);
        } catch {
            output = String(output);
        }
    }

    if (output.length <= MAX_OUTPUT_CHARS) {
        return output;
    }

    const truncated = output.slice(0, MAX_OUTPUT_CHARS);
    const remaining = output.length - MAX_OUTPUT_CHARS;

    return `${truncated}

[... ${remaining} caracteres más truncados para ahorrar tokens ...]
Sugerencia: Si necesitas ver una parte específica, usa comandos como 'sed', 'grep' o 'tail'.`;
}
