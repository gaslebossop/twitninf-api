/**
 * Rejoue les octrois d'événement qui n'ont jamais abouti.
 *
 *     node src/scripts/replayEventGrants.js            # liste, sans rien faire
 *     node src/scripts/replayEventGrants.js --apply    # accorde pour de bon
 *
 * ── Pourquoi ce script existe ─────────────────────────────────────────────
 * La réclamation et l'octroi sont deux choses distinctes : `claim()` enregistre
 * d'abord la remise, PUIS accorde. C'est délibéré — sans cet ordre, une quête
 * dont l'octroi échoue serait réclamable en boucle jusqu'à ce que ça passe, ce
 * qui est exactement l'inverse de ce qu'on veut sur une récompense en monnaie.
 *
 * Le prix de ce choix est qu'un octroi qui échoue laisse une DETTE : la remise
 * est inscrite, l'index unique interdit d'y revenir, et rien n'a été donné.
 *
 * C'est arrivé pour de vrai : les remises effectuées avant le déploiement de
 * `grant()` — qui se contentait alors de journaliser — n'ont accordé
 * strictement rien. Sans ce script, ces récompenses seraient définitivement
 * perdues.
 *
 * ── Pourquoi `settled_at` et pas un simple « on rejoue tout » ─────────────
 * Trois des octrois ne sont PAS idempotents : les NF crédités deux fois le
 * sont vraiment, les jours de Pro s'additionnent, le multiplicateur prolonge.
 * Rejouer aveuglément doublerait les gains de tous ceux qui ont été servis
 * correctement. Seules les lignes à `settled_at IS NULL` sont reprises.
 *
 * ── Pourquoi le mode « liste » est le défaut ──────────────────────────────
 * Ce script bouge de l'argent. Le lancer sans argument montre ce qu'il ferait
 * et ne touche à rien ; il faut `--apply` pour l'autoriser.
 */

const { sequelize, TwQuestClaim, User } = require('../models');
const eventQuestService = require('./../services/eventQuestService');

async function main() {
  const apply = process.argv.includes('--apply');

  await sequelize.authenticate();

  const pending = await TwQuestClaim.findAll({
    where: { settled_at: null },
    order: [['claimed_at', 'ASC']],
  });

  if (pending.length === 0) {
    console.log('OK: aucune dette — toutes les remises ont ete honorees.');
    await sequelize.close();
    return;
  }

  console.log(`${pending.length} remise(s) enregistree(s) sans octroi :\n`);

  let done = 0;
  let failed = 0;

  for (const claim of pending) {
    const user = await User.findByPk(claim.user_id, { attributes: ['username'] });
    const who = user?.username || claim.user_id;
    const label = claim.granted?.label || claim.granted?.kind || '(inconnu)';

    if (!apply) {
      console.log(`  [simulation] ${who} · ${claim.quest_id} · ${label}`);
      continue;
    }

    try {
      // `grant()` ne lève plus sur un octroi partiel : il retourne les kinds
      // en échec. Dans ce cas la dette reste ouverte (pas de `settled_at`).
      const failedKinds = await eventQuestService.grant(claim.user_id, claim.granted || {});
      if (Array.isArray(failedKinds) && failedKinds.length > 0) {
        console.error(`  ECHEC ${who} · ${claim.quest_id} · ${failedKinds.join(', ')}`);
        failed += 1;
        continue;
      }
      await claim.update({ settled_at: new Date() });
      console.log(`  OK  ${who} · ${claim.quest_id} · ${label}`);
      done += 1;
    } catch (error) {
      // On NE marque PAS `settled_at` : la dette reste visible et le script
      // pourra la reprendre une fois la cause corrigee.
      console.error(`  ECHEC ${who} · ${claim.quest_id} · ${error.message}`);
      failed += 1;
    }
  }

  if (!apply) {
    console.log('\n-> rien n a ete accorde. Relancer avec --apply pour appliquer.');
  } else {
    console.log(`\n${done} octroi(s) rejoue(s), ${failed} echec(s).`);
  }

  await sequelize.close();
}

main().catch((error) => {
  console.error('ECHEC du rattrapage:', error.message);
  process.exit(1);
});
