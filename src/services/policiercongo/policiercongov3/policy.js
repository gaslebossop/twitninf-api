'use strict';

const { TOOL_RISK, TRIGGER_TYPES } = require('./constants');

class ToolPolicy {
  constructor(config) { this.config = config; }

  authorize(tool, event) {
    const permissions = event.permissions || {};
    if (Array.isArray(event.context?.disabledTools) && event.context.disabledTools.includes(tool.name)) {
      return { allowed: false, reason: `Outil ${tool.name} désactivé pour ce canal: la réponse visible est livrée par l’appelant` };
    }
    if (tool.allowedTriggers && !tool.allowedTriggers.includes(event.trigger)) {
      return { allowed: false, reason: `Outil ${tool.name} interdit pour le trigger ${event.trigger}` };
    }
    if (this.config.allowAllTools) {
      return { allowed: true, reason: 'Autorisation permanente de tous les outils V3 activée par le propriétaire' };
    }
    if (tool.risk === TOOL_RISK.READ && permissions.allowRead !== false) return { allowed: true };
    if (tool.risk === TOOL_RISK.READ) return { allowed: false, reason: 'Lecture non autorisée pour ce tour' };

    const autonomous = [TRIGGER_TYPES.SCHEDULED, TRIGGER_TYPES.PROACTIVE].includes(event.trigger);
    const writesAllowed = permissions.allowWrite === true || (autonomous && this.config.allowAutonomousWrites);
    if (!writesAllowed) return { allowed: false, reason: 'Écriture non autorisée pour ce tour' };

    if (tool.risk === TOOL_RISK.WRITE) return { allowed: true };
    if (tool.risk === TOOL_RISK.SENSITIVE) {
      return permissions.allowSensitive && this.config.allowSensitiveTools
        ? { allowed: true }
        : { allowed: false, reason: 'Action sensible non autorisée' };
    }
    if (tool.risk === TOOL_RISK.DESTRUCTIVE) {
      return permissions.allowDestructive && permissions.approvalToken
        ? { allowed: true }
        : { allowed: false, reason: 'Action destructive sans approbation explicite' };
    }
    return { allowed: false, reason: `Niveau de risque inconnu: ${tool.risk}` };
  }
}

module.exports = { ToolPolicy };
