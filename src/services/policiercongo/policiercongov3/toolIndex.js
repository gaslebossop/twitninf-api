'use strict';

/**
 * Index compact des outils.
 *
 * Le catalogue complet (84 outils avec leur JSON Schema entier) pèse ~48 500
 * caractères. Envoyé à chaque prompt plein, il dépassait le budget de section
 * réservé aux outils (~35 000) : `safeJson` coupait alors la chaîne au milieu
 * d'un objet, ce qui faisait disparaître purement et simplement les ~30
 * derniers outils du catalogue — l'agent ne pouvait pas appeler ce qu'il ne
 * voyait pas, et le JSON tronqué se terminait sur un objet ouvert.
 *
 * Ici, chaque outil tient sur une ligne : signature d'appel + risque +
 * description complète. Les 84 outils tiennent dans ~25 000 caractères, donc
 * ils sont TOUS visibles. Le schéma complet (bornes, énumérations longues,
 * objets imbriqués) reste disponible à la demande via `inspect_tools` — c'est
 * le modèle qui décide quand il en a besoin, personne ne le décide pour lui.
 */

const SIGNATURE_ENUM_MAX = 48;

const INDEX_HEADER = `Chaque ligne: nom(arguments) [risque] description.
Arguments: "!" = requis, "?" = optionnel, "obj" = objet imbriqué, "[]" = liste, "=a|b" = valeurs autorisées.
Cette signature suffit pour la plupart des appels. Pour le schéma complet d'un outil (champs d'un "obj", bornes, énumérations longues) et son mode d'emploi détaillé, appelle inspect_tools.`;

function renderType(schema = {}) {
  if (!schema.type && Array.isArray(schema.enum)) return 'enum';
  switch (schema.type) {
    case 'array': return `${renderType(schema.items || {})}[]`;
    case 'object': return 'obj';
    case 'integer': return 'int';
    case 'number': return 'num';
    case 'boolean': return 'bool';
    case 'string': return 'str';
    default: return schema.type || 'any';
  }
}

/** Énumération inline seulement si elle reste courte : sinon, c'est le rôle d'inspect_tools. */
function renderEnum(schema = {}) {
  const values = Array.isArray(schema.enum) ? schema.enum : schema.items?.enum;
  if (!Array.isArray(values) || !values.length) return '';
  const joined = values.join('|');
  return joined.length <= SIGNATURE_ENUM_MAX ? `=${joined}` : '';
}

function renderSignature(tool) {
  const schema = tool.inputSchema || tool.input_schema || {};
  const required = new Set(schema.required || []);
  const args = Object.entries(schema.properties || {}).map(([name, child]) => {
    const value = child || {};
    return `${name}${required.has(name) ? '!' : '?'}:${renderType(value)}${renderEnum(value)}`;
  });
  return `${tool.name}(${args.join(', ')})`;
}

/**
 * @param {object[]} tools sortie de `ToolRegistry.catalog()`
 * @param {number} descriptionMax 0 = description entière (défaut : c'est la
 *   seule base sur laquelle le modèle choisit un outil, la tronquer dégrade
 *   directement la qualité de sélection).
 */
function renderToolIndex(tools, { descriptionMax = 0 } = {}) {
  const lines = tools.map(tool => {
    const description = String(tool.description || '').replace(/\s+/g, ' ').trim();
    const shown = descriptionMax > 0 && description.length > descriptionMax
      ? `${description.slice(0, descriptionMax - 1)}…`
      : description;
    return `${renderSignature(tool)} [${tool.risk}] ${shown}`.trimEnd();
  });
  return `${INDEX_HEADER}\n\n${lines.join('\n')}`;
}

/** Schéma complet d'un outil, tel que renvoyé par inspect_tools et par le prompt. */
function toolDetail(tool) {
  return {
    name: tool.name,
    risk: tool.risk,
    description: tool.description || '',
    input_schema: tool.inputSchema || tool.input_schema || { type: 'object', properties: {} }
  };
}

module.exports = { renderToolIndex, renderSignature, renderType, toolDetail, INDEX_HEADER };
