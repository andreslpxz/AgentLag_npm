import { getSkills, saveSkill } from './skill_registry.js';

export async function analyzeAndEvolve(recording, agent) {
    const skills = getSkills();
    const skillsContext = skills.map(s => `Skill: ${s.name}\nDesc: ${s.description}\nContent: ${s.content}`).join('\n---\n');

    const prompt = `
Eres el Motor de Evolución de OpenSpaceLag. Tu tarea es analizar la grabación de una tarea y decidir si se debe:
1. FIX: Arreglar una skill existente que falló o fue ineficiente.
2. CAPTURED: Capturar una nueva habilidad reusable a partir de los pasos exitosos.
3. NONE: No hacer nada.

Grabación de la tarea:
${JSON.stringify(recording, null, 2)}

Skills actuales:
${skillsContext}

Responde en formato JSON:
{
  "action": "FIX" | "CAPTURED" | "NONE",
  "skillName": "nombre_de_la_skill",
  "reason": "por qué evoluciona",
  "newContent": "contenido completo del SKILL.md mejorado o nuevo",
  "description": "nueva descripción"
}
`;

    try {
        // Usamos el agente mismo para invocar al modelo, ya que tiene configurado el provider y la key
        const response = await agent.invoke({
            messages: [
                ["system", "Eres un experto en ingeniería de prompts y automatización. Responde únicamente con el JSON solicitado."],
                ["user", prompt]
            ]
        });

        const lastMessage = response.messages[response.messages.length - 1];
        const content = typeof lastMessage.content === 'string' ? lastMessage.content : JSON.stringify(lastMessage.content);
        const suggestion = JSON.parse(content.match(/\{[\s\S]*\}/)[0]);

        if (suggestion.action !== 'NONE') {
            return suggestion;
        }
    } catch (error) {
        console.error("Error en evolución:", error);
    }
    return null;
}

export function applyEvolution(suggestion) {
    saveSkill(suggestion.skillName, suggestion.description, suggestion.newContent);
}
