<<<<<<< SEARCH
    try {
        const responseText = await _streamAgent(agent, msgRef, setStaticHistory, setStatus, setActiveTool,
            setThinkWord, setThinkStart, setTotalTokens, abortCtrlRef, askConfirm);

        if (responseText) {
            const cleaned = stripMarkdown(responseText);
            setStaticHistory(prev => [...prev, { type: 'assistant', text: cleaned }]);
            session.logInteraction('assistant', cleaned);
        }

        const recording  = await session.save('success');
        const evolution  = await analyzeAndEvolve(recording, agent);
        if (evolution) {
            addEvolution(evolution);
            setStaticHistory(prev => [...prev, {
                type: 'assistant',
                text: `✨ Oportunidad de evolución detectada: ${evolution.skillName}\nMotivo: ${evolution.reason}\n¿Deseas aplicar esta mejora? (Usa /evolve para confirmar)`,
            }]);
        }
    } catch (err) {
        await _handleAgentError(err, agent, msgRef, setStaticHistory, setStatus, setActiveTool,
            setThinkWord, setThinkStart, setTotalTokens, abortCtrlRef, askConfirm,
            setAgent, setForceReAct, persistFlag);
    } finally {
        setStatus('idle'); setActiveTool(null); setThinkStart(null); setElapsed(0);
    }
=======
    try {
        const responseText = await _streamAgent(agent, msgRef, setStaticHistory, setStatus, setActiveTool,
            setThinkWord, setThinkStart, setTotalTokens, abortCtrlRef, askConfirm);

        if (responseText) {
            const cleaned = stripMarkdown(responseText);
            setStaticHistory(prev => [...prev, { type: 'assistant', text: cleaned }]);
            session.logInteraction('assistant', cleaned);
        }

        // Reset UI status immediately after response
        setStatus('idle'); setActiveTool(null); setThinkStart(null); setElapsed(0);

        // Run evolution analysis in background
        (async () => {
            try {
                const recording  = await session.save('success');
                const evolution  = await analyzeAndEvolve(recording, agent);
                if (evolution) {
                    addEvolution(evolution);
                    setStaticHistory(prev => [...prev, {
                        type: 'assistant',
                        text: `✨ Oportunidad de evolución detectada: ${evolution.skillName}\nMotivo: ${evolution.reason}\n¿Deseas aplicar esta mejora? (Usa /evolve para confirmar)`,
                    }]);
                }
            } catch (evolveErr) {
                console.error("Error in background evolution:", evolveErr);
            }
        })();

    } catch (err) {
        await _handleAgentError(err, agent, msgRef, setStaticHistory, setStatus, setActiveTool,
            setThinkWord, setThinkStart, setTotalTokens, abortCtrlRef, askConfirm,
            setAgent, setForceReAct, persistFlag);
    } finally {
        // Ensure status is idle even if error occurs
        if (status !== 'idle') {
            setStatus('idle'); setActiveTool(null); setThinkStart(null); setElapsed(0);
        }
    }
>>>>>>> REPLACE
