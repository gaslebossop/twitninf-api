const logger = require('../utils/logger');

/**
 * Ouvre une issue GitHub `agent-task` quand une idée de la Forge est retenue.
 *
 * Best-effort : une issue non créée ne doit jamais faire échouer la décision
 * du staff (le versement, lui, est déjà acté en base). La routine horaire de
 * secours relit `/api/forge/agent/accepted` de toute façon, donc rater cette
 * issue retarde la prise en charge d'au plus une heure, sans jamais la
 * perdre. C'est pour ça qu'aucun appelant n'attend cette fonction avant de
 * répondre au staff.
 */

const GITHUB_REPO = process.env.FORGE_GITHUB_REPO || 'gaslebossop/twitninf-app';

async function createAgentTaskIssue(proposal) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    logger.warn('[forge] GITHUB_TOKEN absent : pas de création d’issue agent-task');
    return null;
  }

  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/issues`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        title: `[Forge] ${proposal.title}`,
        body: [
          `**Description**\n${proposal.body}`,
          `**Zone**: ${proposal.area}`,
          // C'est sur cet identifiant que la routine retrouve la proposition
          // dans /api/forge/agent/accepted pour la clôturer au bon endroit.
          `**ID interne (Forge)**: ${proposal.id}`,
        ].join('\n\n'),
        labels: ['agent-task'],
      }),
    });

    if (!res.ok) {
      logger.error(`[forge] création issue GitHub échouée (${res.status}): ${await res.text()}`);
      return null;
    }

    const issue = await res.json();
    logger.info(`[forge] issue agent-task créée: #${issue.number} pour l'idée ${proposal.id}`);
    return issue;
  } catch (error) {
    logger.error(`[forge] création issue GitHub: ${error.message}`);
    return null;
  }
}

module.exports = { createAgentTaskIssue };
