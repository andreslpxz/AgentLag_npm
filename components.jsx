// ─── components.jsx ───────────────────────────────────────────────────────────
// Todos los componentes React/Ink puros (sin estado global).
import React from 'react';
import { Text, Box, Newline, useStdout } from 'ink';
import { PROVIDERS, PROVIDER_MODELS }    from './providers.js';
import pkg from './package.json' with { type: 'json' };

export const AGENTLAG_VERSION = pkg.version;

// ── Primitivos ────────────────────────────────────────────────────────────────

/** Línea horizontal que ocupa el ancho de la terminal. */
export const HR = ({ char = '─' }) => {
    const { stdout } = useStdout();
    const width = (stdout?.columns || 80) - 2;
    return <Text color="gray">{char.repeat(Math.max(1, width))}</Text>;
};

/** Igual que HR pero sin hook — útil fuera de contextos de Ink avanzados. */
export const HR_FULL = () => {
    const { stdout } = useStdout();
    const width = (stdout?.columns || 80) - 2;
    return <Text color="gray">{'─'.repeat(Math.max(1, width))}</Text>;
};

// ── Branding ──────────────────────────────────────────────────────────────────

export const AgentLogo = () => (
    <Box flexDirection="column">
        <Text color="#00FF87"> ▄▀▄ █▀▀ █▀▀ █▄ █ ▀█▀ █   ▄▀▄ █▀▀ </Text>
        <Text color="#00FF87"> █▀█ █ █ █▀▀ █ ▀█  █  █   █▀█ █ █ </Text>
        <Text color="#00FF87"> ▀ ▀ ▀▀▀ ▀▀▀ ▀  ▀  ▀  ▀▀▀ ▀ ▀ ▀▀▀ </Text>
        <Box>
            <Text color="white" bold>  AGENTLAG</Text>
            <Text color="gray">  v{AGENTLAG_VERSION}</Text>
        </Box>
    </Box>
);

export const WelcomeBox = ({ provider, model }) => (
    <Box flexDirection="column" borderStyle="round" borderColor="gray"
         paddingX={2} paddingY={1} marginBottom={1}>
        <Text bold>Welcome back <Text color="white" bold>Alonso</Text>!</Text>
        <Newline />
        <AgentLogo />
        <Newline />
        <Text bold>AgentLag</Text>
        <Text color="gray">{model || 'model'} · {provider || 'provider'}</Text>
        <Text color="cyan">{process.cwd()}</Text>
    </Box>
);

// ── Mensajes de chat ──────────────────────────────────────────────────────────

export const UserMessage = ({ text }) => (
    <Box flexDirection="column" marginTop={1}>
        <HR />
        <Box><Text color="cyan">❯ </Text><Text wrap="wrap">{text}</Text></Box>
    </Box>
);

export const AssistantMessage = ({ text, stripMarkdownFn }) => {
    const cleaned = stripMarkdownFn ? stripMarkdownFn(text || '') : (text || '');
    const lines   = cleaned.split('\n');
    return (
        <Box flexDirection="column" marginTop={1}>
            {lines.map((line, i) => (
                <Box key={i}>
                    {i === 0 ? <Text color="green" bold>● </Text> : <Text>  </Text>}
                    <Text wrap="wrap">{line}</Text>
                </Box>
            ))}
        </Box>
    );
};

// ── Herramientas ──────────────────────────────────────────────────────────────

const toolLabel = (n) => n?.replace(/_/g, ' ') ?? 'tool';

export const ToolLine = ({ name, input, output, running }) => {
    let detail = '';
    if (input) {
        try {
            const p = typeof input === 'string' ? JSON.parse(input) : input;
            detail  = p.path || p.command || p.query || p.filename || Object.values(p)[0] || '';
            if (typeof detail !== 'string') detail = JSON.stringify(detail);
            if (detail.length > 55) detail = detail.slice(0, 55) + '…';
        } catch { detail = String(input).slice(0, 55); }
    }
    let outPreview = '';
    if (output) {
        const lines = String(output).trim().split('\n').filter(Boolean);
        outPreview  = lines.slice(0, 2).join(' · ');
        if (outPreview.length > 70) outPreview = outPreview.slice(0, 70) + '…';
        if (lines.length > 2)       outPreview += ` (+${lines.length - 2} lines)`;
    }
    return (
        <Box flexDirection="column">
            <Box>
                <Text color={running ? 'yellow' : 'green'}>● </Text>
                <Text color={running ? 'yellow' : 'white'} bold>{toolLabel(name)}</Text>
                {detail     ? <Text color="gray">({detail})</Text>    : null}
                {running    ? <Text color="gray"> Running…</Text>     : null}
            </Box>
            {outPreview && !running && (
                <Box marginLeft={2}><Text color="gray">⎿  {outPreview}</Text></Box>
            )}
        </Box>
    );
};

// ── Diálogo de confirmación ───────────────────────────────────────────────────

export const ConfirmDialog = ({ toolName, detail, options, selectedIndex }) => (
    <Box flexDirection="column" marginTop={1}
         borderStyle="single" borderColor="yellow" paddingX={1}>
        <Text color="yellow" bold>⚠  {toolLabel(toolName)}</Text>
        {detail ? <Text color="gray">   {detail.slice(0, 78)}</Text> : null}
        <Newline />
        <Text color="gray"> Do you want to proceed?</Text>
        {options.map((opt, i) => (
            <Box key={i}>
                {i === selectedIndex
                    ? <Text color="cyan"> ❯ <Text color="white" bold>{(i + 1) + '. ' + opt}</Text></Text>
                    : <Text color="gray">   {(i + 1) + '. ' + opt}</Text>}
            </Box>
        ))}
        <Text color="gray" dimColor> Esc to cancel</Text>
    </Box>
);

// ── Footer / ayuda ────────────────────────────────────────────────────────────

export const ShortcutsHelp = () => (
    <Box flexDirection="column">
        <Text color="gray">  ! for shell mode   double tap esc to clear   ctrl+shift+_ to undo</Text>
    </Box>
);

// ── Pantallas de setup ────────────────────────────────────────────────────────

export const ColorScreen = ({ menuIndex }) => {
    const opts = ['Auto (match terminal)', 'Dark mode', 'Light mode', 'ANSI colors only'];
    return (
        <Box flexDirection="column" paddingX={1} paddingY={1}>
            <Text color="gray">Welcome to AgentLag v{AGENTLAG_VERSION}</Text>
            <Text color="gray">{'…'.repeat(69)}</Text><Newline />
            <AgentLogo />
            <Text color="gray">{'─'.repeat(69)}</Text><Newline />
            <Text>{"Let's get started."}</Text><Newline />
            <Text color="gray"> Choose the text style that looks best with your terminal</Text><Newline />
            {opts.map((o, i) => (
                <Box key={i}>
                    {i === menuIndex
                        ? <Text color="cyan">❯ <Text color="white" bold>{(i + 1) + '. ' + o}</Text></Text>
                        : <Text color="gray">  {(i + 1) + '. ' + o}</Text>}
                </Box>
            ))}
            <Newline /><Text color="gray">{'╌'.repeat(69)}</Text>
        </Box>
    );
};

export const TrustScreen = ({ menuIndex }) => (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
        <HR /><Newline />
        <Text color="gray"> Accessing workspace:</Text>
        <Text color="cyan"> {process.cwd()}</Text><Newline />
        <Text color="white"> Quick safety check: Is this a project you created or one you trust?</Text>
        <Text color="gray"> (Like your own code, a well-known open source project, or work from your team).</Text>
        <Text color="gray"> If not, take a moment to review what's in this folder first.</Text><Newline />
        <Text color="gray"> AgentLag will be able to read, edit, and execute files here.</Text>
        <Text color="cyan"> Security guide</Text><Newline />
        {['Yes, I trust this folder', 'No, exit'].map((o, i) => (
            <Box key={i}>
                {i === menuIndex
                    ? <Text color="cyan">❯ <Text color="white" bold>{(i + 1) + '. ' + o}</Text></Text>
                    : <Text color="gray">  {(i + 1) + '. ' + o}</Text>}
            </Box>
        ))}
        <Newline /><Text color="gray"> Enter to confirm · Esc to cancel</Text><HR />
    </Box>
);

export const ProviderScreen = ({ menuIndex }) => (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
        <AgentLogo /><Newline />
        <Text color="gray">{'─'.repeat(69)}</Text>
        <Text bold> Choose your LLM Provider</Text><Newline />
        {PROVIDERS.map((p, i) => (
            <Box key={p.id}>
                {i === menuIndex
                    ? <Box><Text color="cyan">❯ </Text><Text color="white" bold>{p.label.padEnd(16)}</Text><Text color="gray">{p.desc}</Text></Box>
                    : <Box><Text>  </Text><Text color="gray">{p.label.padEnd(16)}</Text><Text color="gray" dimColor>{p.desc}</Text></Box>}
            </Box>
        ))}
        <Newline /><Text color="gray"> Enter to select · Esc to go back</Text>
        <Text color="gray">{'╌'.repeat(69)}</Text>
    </Box>
);

export const ApiKeyScreen = ({ provider, inputText, showError }) => {
    const noKey = provider?.id === 'ollama' || provider?.id === 'huggingface';
    return (
        <Box flexDirection="column" paddingX={1} paddingY={1}>
            <AgentLogo /><Newline />
            <Text color="gray">{'─'.repeat(69)}</Text>
            <Text bold> Enter API Key for <Text color="#00FF87">{provider?.label}</Text></Text><Newline />
            <Text color="gray"> {noKey
                ? 'No necesita API key — se ejecuta localmente'
                : 'Your key is stored locally in ~/.agentlag/config.json'}</Text>
            <Newline />
            <Box borderStyle="single" borderColor={showError ? 'red' : 'cyan'} paddingX={1}>
                <Text color="gray">Key: </Text>
                <Text>{noKey ? 'Local' : '*'.repeat(inputText.length)}</Text>
                <Text color="white">█</Text>
            </Box>
            {showError && <Text color="red"> ⚠ API key es requerida para {provider?.label}</Text>}
            <Newline />
            <Text color="gray"> Enter to confirm · Esc to go back</Text>
            <Text color="gray">{'╌'.repeat(69)}</Text>
        </Box>
    );
};

export const DownloadScreen = ({ modelName, progress, statusText }) => (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
        <AgentLogo /><Newline />
        <Text color="gray">{'─'.repeat(69)}</Text>
        <Text bold> Descargando modelo de HuggingFace</Text><Newline />
        <Text color="cyan"> {modelName}</Text>
        <Newline />
        <Box>
            <Text color="gray"> [</Text>
            <Text color="green">{'█'.repeat(Math.floor(progress / 2))}</Text>
            <Text color="gray">{'░'.repeat(50 - Math.floor(progress / 2))}</Text>
            <Text color="gray">] </Text>
            <Text color="white">{progress}%</Text>
        </Box>
        <Newline />
        <Text color="gray"> {statusText || 'Descargando...'}</Text>
        <Text color="gray">{'╌'.repeat(69)}</Text>
    </Box>
);

export const ModelScreen = ({ provider, menuIndex, inputText, ollamaModels, ollamaStatus }) => {
    const isOllama   = provider?.id === 'ollama';
    const isHF       = provider?.id === 'huggingface';
    let   suggestions;
    if (isOllama) {
        suggestions = ollamaStatus === 'running' ? ollamaModels : [];
    } else {
        suggestions = PROVIDER_MODELS[provider?.id] || [];
    }
    const listLabel = isOllama && ollamaStatus === 'running' ? 'Modelos instalados' : 'Suggestions';
    return (
        <Box flexDirection="column" paddingX={1} paddingY={1}>
            <AgentLogo /><Newline />
            <Text color="gray">{'─'.repeat(69)}</Text>
            <Text bold>
                {' '}{isHF ? 'Escribe el modelo de HuggingFace' : 'Select or type model for'}{' '}
                <Text color="#00FF87">{provider?.label}</Text>
            </Text><Newline />
            {isHF && (
                <Box flexDirection="column">
                    <Text color="gray"> Formato: org/modelo (ej: inclusionai/ling-2.6-1t)</Text>
                    <Text color="gray"> Se descargará via Ollama y se usará localmente.</Text>
                    <Newline />
                </Box>
            )}
            <Box borderStyle="single" borderColor="cyan" paddingX={1}>
                <Text color="gray">Model: </Text><Text>{inputText}</Text><Text color="white">█</Text>
            </Box>
            <Newline />
            {isOllama && ollamaStatus === 'checking' && (
                <Text color="yellow"> ⏳ Verificando conexión con Ollama...</Text>
            )}
            {isOllama && ollamaStatus === 'not_running' && (
                <Box flexDirection="column">
                    <Text color="red"> ⚠ Ollama no está corriendo.</Text>
                    <Text color="gray"> Inicia el servidor con: </Text>
                    <Text color="cyan">   ollama serve</Text>
                    <Newline />
                    <Text color="gray"> Puedes escribir el nombre del modelo manualmente.</Text>
                </Box>
            )}
            {isOllama && ollamaStatus === 'running' && ollamaModels.length === 0 && (
                <Box flexDirection="column">
                    <Text color="yellow"> ⚠ Ollama está corriendo pero no hay modelos descargados.</Text>
                    <Text color="gray"> Descarga uno con: </Text>
                    <Text color="cyan">   ollama pull llama3</Text>
                </Box>
            )}
            {suggestions.length > 0 && (
                <Box flexDirection="column">
                    <Text color="gray"> {listLabel} (↑↓ pick · Enter confirm):</Text>
                    {suggestions.map((m, i) => (
                        <Box key={m}>
                            {i === menuIndex
                                ? <Text color="cyan">  ❯ {m}</Text>
                                : <Text color="gray">    {m}</Text>}
                        </Box>
                    ))}
                </Box>
            )}
            <Newline />
            <Text color="gray"> Enter to confirm · Esc to go back</Text>
            <Text color="gray">{'╌'.repeat(69)}</Text>
        </Box>
    );
};

// ── Menú de slash commands ────────────────────────────────────────────────────

export const CommandMenu = ({ input, selectedIndex, slashCommands }) => {
    const query    = input.slice(1).toLowerCase();
    const filtered = slashCommands.filter(c => c.cmd.includes(query));
    const LIMIT    = 8;

    let start = 0;
    if (filtered.length > LIMIT) {
        if (selectedIndex >= LIMIT) {
            start = Math.min(selectedIndex - LIMIT + 1, filtered.length - LIMIT);
        }
    }

    const visible = filtered.slice(start, start + LIMIT);

    return (
        <Box flexDirection="column">
            {visible.map((item, i) => {
                const actualIndex = start + i;
                const sel = actualIndex === selectedIndex;
                const cc  = sel ? 'cyan' : 'white';
                const dc  = sel ? 'cyan' : 'gray';
                const pad = ' '.repeat(Math.max(0, 18 - item.cmd.length));
                return (
                    <Box key={item.cmd} flexDirection="column">
                        <Box>
                            <Text color={cc}>{item.cmd}</Text>
                            <Text>{pad}</Text>
                            <Text color={dc}>{item.desc[0]}</Text>
                        </Box>
                        {item.desc[1] && (
                            <Box>
                                <Text>{' '.repeat(18)}</Text>
                                <Text color={dc}>{item.desc[1]}</Text>
                            </Box>
                        )}
                    </Box>
                );
            })}
        </Box>
    );
};
