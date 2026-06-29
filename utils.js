// ─── utils.js ─────────────────────────────────────────────────────────────────
// Utilidades de propósito general: portapapeles, shell, parsing de errores.
import { spawn } from 'child_process';

// ── Portapapeles ──────────────────────────────────────────────────────────────
export function copyToClipboard(text) {
    return new Promise((resolve) => {
        const candidates = [
            ['termux-clipboard-set', []],
            ['xclip',  ['-selection', 'clipboard']],
            ['xsel',   ['--clipboard', '--input']],
            ['pbcopy', []],
            ['wl-copy', []],
        ];
        let i = 0;
        const tryNext = () => {
            if (i >= candidates.length) return resolve(false);
            const [bin, args] = candidates[i++];
            let proc;
            try { proc = spawn(bin, args, { stdio: ['pipe', 'ignore', 'ignore'] }); }
            catch { return tryNext(); }
            proc.on('error', tryNext);
            proc.on('close', code => { code === 0 ? resolve(true) : tryNext(); });
            try { proc.stdin.write(text); proc.stdin.end(); } catch { tryNext(); }
        };
        tryNext();
    });
}

// ── Shell ─────────────────────────────────────────────────────────────────────
export function splitCommandArgs(text) {
    return Array.from(
        text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g),
        match => match[1] ?? match[2] ?? match[3]
    );
}

export function runCommand(bin, args = [], opts = {}) {
    return new Promise((resolve) => {
        let proc;
        try {
            proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
        } catch (e) {
            return resolve({ ok: false, output: `${bin} no encontrado: ${e.message}`, code: 127 });
        }
        let out = '', err = '';
        proc.stdout?.on('data', d => out += d.toString());
        proc.stderr?.on('data', d => err += d.toString());
        proc.on('error', (e) =>
            resolve({ ok: false, output: `${bin} no encontrado: ${e.message}`, code: 127 })
        );
        proc.on('close', code => {
            const text = (out + (err ? `\n${err}` : '')).trim();
            resolve({ ok: code === 0, output: text || `(exit ${code})`, code });
        });
    });
}

// ── Error helpers (Groq / OpenRouter / tool-unsupported) ─────────────────────

/**
 * Aplana todos los posibles campos de mensaje de un error en un string
 * para hacer matching sin reventar con shapes inesperados.
 */
export function flattenErrorText(err) {
    return [
        err?.message,
        err?.error?.message,
        err?.cause?.message,
        err?.response?.data?.error?.message,
        typeof err === 'string' ? err : '',
    ].filter(Boolean).join(' ');
}

/**
 * Detecta si el error indica que el modelo/proveedor no soporta tool calling.
 * Cubre OpenAI, Anthropic, Mistral, OpenRouter y Groq (tool_use_failed).
 */
export function isToolUnsupportedError(err) {
    const text = flattenErrorText(err).toLowerCase();
    if (!text) return false;
    return (
        text.includes('does not support tools') ||
        text.includes('does not support tool') ||
        text.includes('tools are not supported') ||
        text.includes('tool use is not supported') ||
        text.includes('tool calling is not supported') ||
        text.includes('function calling is not supported') ||
        text.includes('no endpoints found that support tool use') ||
        text.includes('no endpoints found that support tools') ||
        (text.includes('try disabling') && text.includes('tool')) ||
        text.includes('try disabling "create_file"') ||
        (text.includes('model_not_found') && text.includes('tool')) ||
        text.includes('tool_use_failed') ||
        text.includes('failed to call a function') ||
        text.includes('please adjust your prompt')
    );
}

/**
 * Cuando Groq devuelve `tool_use_failed`, intenta extraer la respuesta real
 * del campo `failed_generation`.
 */
export function extractFailedGeneration(err) {
    const raw = flattenErrorText(err);
    if (!raw) return null;

    // 1. Campo directo
    const direct =
        err?.error?.failed_generation ??
        err?.response?.data?.error?.failed_generation ??
        null;
    if (typeof direct === 'string' && direct.trim()) return direct;

    // 2. Buscar el primer JSON dentro del texto
    const start = raw.indexOf('{');
    if (start === -1) return null;
    try {
        const parsed = JSON.parse(raw.slice(start));
        const fg = parsed?.error?.failed_generation;
        return typeof fg === 'string' && fg.trim() ? fg : null;
    } catch {
        // 3. Fallback regex
        const m = raw.match(/"failed_generation"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        if (m?.[1]) {
            try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; }
        }
        return null;
    }
}

/**
 * Detecta si el error es un rate limit (429) recuperable con retry.
 */
export function isRateLimitError(err) {
    const text = flattenErrorText(err).toLowerCase();
    const status = err?.status || err?.statusCode || err?.response?.status || err?.response?.statusCode;
    return (
        status === 429 ||
        text.includes('rate limit') ||
        text.includes('rate_limit') ||
        text.includes('too many requests') ||
        text.includes('429 provider returned error')
    );
}

/**
 * Ejecuta una funcion asincrona con retry y backoff exponencial.
 * Util para errores 429 de proveedores con rate limits estrictos (OpenRouter free, etc.).
 */
export async function withRetry(fn, { maxRetries = 3, baseDelay = 2000, shouldRetry } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            if (attempt >= maxRetries) break;
            if (shouldRetry && !shouldRetry(err)) throw err;
            if (!shouldRetry && !isRateLimitError(err)) throw err;
            const retryAfter = err?.response?.headers?.['retry-after'];
            const delay = retryAfter
                ? Math.max(1000, parseInt(retryAfter, 10) * 1000)
                : baseDelay * Math.pow(2, attempt) + Math.random() * 1000;
            await new Promise(r => setTimeout(r, delay));
        }
    }
    throw lastErr;
}
