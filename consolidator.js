import { kuzuClient } from './kuzu_utils.js';
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

export async function consolidateHistory(history, llm) {
    if (!history || history.length === 0) return "⚠️ No hay historial para consolidar.";

    const messages = history.map(m => `${m.role}: ${m.content}`).join('\n');

    const prompt = `Analiza la siguiente conversación entre un usuario y un asistente de IA.
Extrae las entidades principales (conceptos, tecnologías, decisiones, componentes de software) y sus relaciones.

Devuelve EXCLUSIVAMENTE un JSON con esta estructura:
{
  "entities": [
    {"name": "nombre", "type": "tipo"},
    ...
  ],
  "relations": [
    {"source": "nombre_origen", "target": "nombre_destino", "description": "descripcion"},
    ...
  ]
}

HISTORIAL:
${messages}`;

    try {
        const response = await llm.invoke([
            new SystemMessage("Eres un experto en extracción de grafos de conocimiento. Solo respondes con JSON válido."),
            new HumanMessage(prompt)
        ]);

        let text = response.content;
        // Limpiar posible markdown
        text = text.replace(/\`\`\`json/g, '').replace(/\`\`\`/g, '').trim();

        const data = JSON.parse(text);

        for (const ent of data.entities || []) {
            try {
                // Usar MERGE manual (MATCH or CREATE) porque Kuzu no tiene MERGE nativo simple en todas las versiones
                const existing = await kuzuClient.query(`MATCH (e:Entidad {nombre: '${ent.name.replace(/'/g, "\\'")}'}) RETURN e`);
                if (existing.length === 0) {
                    await kuzuClient.execute(`CREATE (:Entidad {nombre: '${ent.name.replace(/'/g, "\\'")}', tipo: '${ent.type.replace(/'/g, "\\'")}'})`);
                }
            } catch (e) {
                console.error(`Error al crear entidad ${ent.name}:`, e.message);
            }
        }

        for (const rel of data.relations || []) {
            try {
                await kuzuClient.execute(`
                    MATCH (a:Entidad {nombre: '${rel.source.replace(/'/g, "\\'")}'}), (b:Entidad {nombre: '${rel.target.replace(/'/g, "\\'")}'})
                    CREATE (a)-[:RELACIONA {descripcion: '${rel.description.replace(/'/g, "\\'")}'}]->(b)
                `);
            } catch (e) {
                console.error(`Error al crear relación ${rel.source} -> ${rel.target}:`, e.message);
            }
        }

        return `✅ Consolidación completada: ${(data.entities || []).length} entidades y ${(data.relations || []).length} relaciones procesadas.`;
    } catch (error) {
        return `❌ Error en consolidación: ${error.message}`;
    }
}
