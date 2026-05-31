import { bot, logExecution } from './bot.js';
import { buildAgent } from './agent.js';
import { HumanMessage, AIMessage, ToolMessage } from '@langchain/core/messages';

let agent;
const chatHistories = new Map();
const MAX_HISTORY = 20;

bot.on('text', async (ctx) => {
    const chatId = ctx.chat.id;
    const text = ctx.message.text;

    try {
        if (!agent) {
            ctx.reply('Iniciando agente...');
            // Seguridad: En Telegram excluimos run_shell por defecto
            agent = await buildAgent({ excludedTools: ['run_shell'] });
        }

        // Recuperar o inicializar historial
        if (!chatHistories.has(chatId)) {
            chatHistories.set(chatId, []);
        }
        const history = chatHistories.get(chatId);

        // Añadir mensaje del usuario
        history.push(new HumanMessage(text));

        // Mantener límite de 20 mensajes
        if (history.length > MAX_HISTORY) {
            history.splice(0, history.length - MAX_HISTORY);
        }

        const result = await agent.invoke({
            messages: history
        });

        // El resultado contiene el historial completo actualizado (incluyendo tool calls y respuestas)
        // Pero nosotros queremos persistir solo lo relevante para el contexto del bot
        const newMessages = result.messages.slice(history.length);

        // Actualizar historial local con la respuesta del asistente y posibles tools
        history.push(...newMessages);

        // Volver a recortar si es necesario
        if (history.length > MAX_HISTORY) {
            history.splice(0, history.length - MAX_HISTORY);
        }

        const lastMsg = result.messages[result.messages.length - 1];

        // Logging detallado
        logExecution({
            source: 'telegram',
            chatId,
            user: ctx.from.username || ctx.from.id,
            input: text,
            output: lastMsg.content,
            toolCalls: newMessages.filter(m => m.tool_calls?.length > 0).map(m => m.tool_calls)
        });

        await ctx.reply(lastMsg.content);

    } catch (error) {
        console.error('Error in Telegram bot:', error);
        ctx.reply('Lo siento, ocurrió un error al procesar tu solicitud.');

        logExecution({
            source: 'telegram',
            chatId,
            error: error.message
        });
    }
});

bot.launch().then(() => {
    console.log('Telegram bot is running');
});

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
