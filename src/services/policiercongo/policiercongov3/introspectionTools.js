'use strict';

const { TOOL_RISK } = require('./constants');

/**
 * Outil d'introspection du catalogue.
 *
 * Le prompt ne porte plus que l'index compact des outils (signature + risque +
 * description, voir toolIndex.js). Le schéma complet et les recettes d'usage
 * arrivent à la demande, par cet outil : c'est le modèle qui juge quand il a
 * besoin du détail, exactement comme il juge quand il a besoin d'une lecture
 * de plateforme. Rien ne l'oblige à l'appeler, rien ne l'empêche d'appeler un
 * outil directement depuis sa signature.
 *
 * Ce qui est demandé une fois reste ensuite dans le contexte du run
 * (`ToolRegistry.markExpanded`), donc jamais deux fois la même question.
 */
const MAX_INSPECTED_TOOLS = 16;

function registerIntrospectionTools(registry) {
  registry.register({
    name: 'inspect_tools',
    risk: TOOL_RISK.READ,
    description: "Donne le schéma d'arguments complet (champs des objets imbriqués, bornes, valeurs autorisées) et le mode d'emploi détaillé des outils demandés. À appeler quand la signature de available_tools ne suffit pas à construire l'appel — typiquement advanced_search_tweets ou un outil aux arguments imbriqués. Lecture pure, sans effet.",
    inputSchema: {
      type: 'object',
      properties: {
        names: {
          type: 'array',
          maxItems: MAX_INSPECTED_TOOLS,
          items: { type: 'string', maxLength: 64 }
        }
      }
      // `names` n'est PAS requis : un modèle qui appelle cet outil sans savoir
      // encore quel nom précis demander (cas observé en usage réel) doit
      // recevoir une réponse qui le remet sur la bonne voie, pas un échec de
      // validation — celui-ci ressemble à un outil cassé alors que l'outil
      // fonctionne, il manque juste un argument facultatif.
    },
    handler: async ({ names } = {}, context) => {
      const requested = Array.isArray(names) ? names : [];
      if (!requested.length) {
        return {
          tools: [],
          note: "Aucun nom fourni. Passe les noms exacts des outils à détailler, ex: {\"names\": [\"advanced_search_tweets\"]} — leur liste complète (signature + risque + description) est déjà dans available_tools."
        };
      }
      const { tools, unknown } = registry.describe(requested, context?.event);
      registry.markExpanded(context?.runId, tools.map(tool => tool.name));
      return {
        tools,
        ...(unknown.length ? { unknown, note: "Ces noms ne correspondent à aucun outil visible pour ce tour. Vérifie l'orthographe dans available_tools." } : {})
      };
    }
  });
  return registry;
}

module.exports = { registerIntrospectionTools, MAX_INSPECTED_TOOLS };
