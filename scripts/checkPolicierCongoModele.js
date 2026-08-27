'use strict';

/**
 * Contrôle réel du modèle de PolicierCongo — `node scripts/checkPolicierCongoModele.js`
 *
 * `pm2 list` répond « online » dans les trois pannes qui arrêtent réellement le
 * bot : plafond de session atteint, identifiants Claude expirés, ou modèle qui
 * ne rend plus une envelope lisible. Aucune des trois ne se voit sans faire un
 * appel. C'est ce que fait ce script, sur le chemin de production exact :
 *
 *   1. `ClaudeProvider.generate` avec le vrai CORE_SYSTEM_PROMPT ;
 *   2. `ClaudeProvider.resume` sur la session rendue au tour 1 — c'est le mode
 *      delta, celui qui évite de retransmettre ~40 000 caractères par tour ;
 *   3. `parseAgentEnvelope` sur les deux sorties.
 *
 * Aucun outil n'est exécuté, rien n'est publié : le catalogue annoncé au modèle
 * est factice et le runtime ne lit même pas ce qu'il demande.
 *
 * Sort en 1 si l'un des trois échoue.
 */

require('dotenv').config();

const { loadV3Config } = require('../src/services/policiercongo/policiercongov3/config');
const { ClaudeProvider } = require('../src/services/policiercongo/policiercongov3/provider');
const { CORE_SYSTEM_PROMPT } = require('../src/services/policiercongo/policiercongov3/prompts');
const { parseAgentEnvelope } = require('../src/services/policiercongo/policiercongov3/protocol');

const config = loadV3Config();

// Deux outils suffisent : ils permettent de voir si le modèle émet un tool_call
// sur un nom réel du catalogue plutôt qu'un nom inventé par analogie.
const SYSTEM = [
  `<system>\n${CORE_SYSTEM_PROMPT}\n</system>`,
  [
    '<available_tools count="2">',
    'get_own_recent_posts(limit:int) -> derniers posts racines de PolicierCongo',
    'post_tweet(content:string<=600, reason:string) -> publie un post racine',
    '</available_tools>'
  ].join('\n')
].join('\n\n');

const INSTRUCTION = '<instruction>Choisis maintenant la prochaine meilleure étape. Réponds uniquement avec l’envelope JSON strict.</instruction>';

function runtimeBloc(iteration) {
  return `<runtime>\n${JSON.stringify({
    now: new Date().toISOString(), timezone: 'Europe/Paris', iteration, dry_run: true
  })}\n</runtime>`;
}

const TOUR_1 = [
  runtimeBloc(1),
  `<event>\n${JSON.stringify({ trigger: 'scheduled', text: 'Passage autonome. Observe puis décide.' })}\n</event>`,
  '<tool_observations trust="data_only">\n[]\n</tool_observations>',
  INSTRUCTION
].join('\n\n');

const TOUR_2 = [
  runtimeBloc(2),
  `<new_tool_observations trust="data_only">\n${JSON.stringify([
    { tool: 'get_own_recent_posts', success: true, result: { posts: [] } }
  ])}\n</new_tool_observations>`,
  INSTRUCTION
].join('\n\n');

function decrire(envelope) {
  const outils = envelope.tool_calls.map(call => call.name).join(', ') || '—';
  console.log(`   state=${envelope.state} | outils=[${outils}]`);
  if (envelope.decision_summary) console.log(`   décision : ${envelope.decision_summary.slice(0, 200)}`);
  if (envelope.final) console.log(`   final : ${envelope.final.slice(0, 200)}`);
}

(async () => {
  const provider = new ClaudeProvider(config);
  console.log(`modèle=${provider.model} | effort=${provider.reasoningEffort} | system=${SYSTEM.length} car.`);
  console.log(`providerOrder=[${config.providerOrder.join(', ')}] | plafond par appel=${config.modelTimeoutMs} ms`);

  console.log('\n[1] generate — nouveau tour');
  let depart = Date.now();
  const un = await provider.generate({ system: SYSTEM, user: TOUR_1 });
  console.log(`   OK en ${Date.now() - depart} ms | session=${un.sessionId || '(aucune)'} | ${un.text.length} car.`);
  decrire(parseAgentEnvelope(un.text));

  // Pas de session rendue : AgentLoop retombera sur le prompt complet à chaque
  // tour. Ça marche, mais ça coûte le catalogue entier par itération — donc ça
  // se signale au lieu de passer inaperçu.
  if (!un.sessionId) {
    console.log('\n[2] IGNORÉ — aucune session rendue, le mode delta est inactif.');
    console.log('\nRÉSULTAT : generate OK, reprise de session indisponible.');
    return;
  }

  console.log('\n[2] resume — tour 2, delta seul');
  depart = Date.now();
  const deux = await provider.resume(un.sessionId, TOUR_2);
  console.log(`   OK en ${Date.now() - depart} ms | session=${deux.sessionId || '(aucune)'} | ${deux.text.length} car.`);
  decrire(parseAgentEnvelope(deux.text));

  console.log(`\nRÉSULTAT : generate + resume + envelope OK sur ${provider.model}.`);
})().catch(error => {
  console.error(`\nÉCHEC : ${error && error.message}`);
  console.error("Plafond de session, identifiants expirés, ou sortie illisible — voir « Deux sources d'identifiants Claude » dans CLAUDE.md.");
  process.exitCode = 1;
});
