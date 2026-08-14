/**
 * Accorde un style de certification rare à un compte.
 *
 *     node src/scripts/grantVerificationBadge.js gas gold
 *     node src/scripts/grantVerificationBadge.js gas gray --revoke
 *     node src/scripts/grantVerificationBadge.js gas          # etat du compte
 *
 * ── Pourquoi un script plutôt que du SQL à la main ────────────────────────
 * Les styles « gris » et « or » sont des objets limités, attribués par un
 * administrateur. C'est un choix produit assumé, mais il n'existait aucun
 * outil pour le faire : il fallait écrire l'INSERT soi-même dans l'inventaire,
 * avec le nom EXACT de l'objet.
 *
 * Or ce nom est la seule chose qui compte : `canUseGoldStyle` cherche
 * littéralement « Badge Verifie Or ». Une majuscule ou un accent de travers et
 * l'objet est bien en base, visible dans l'inventaire, mais le style reste
 * verrouillé — sans le moindre message d'erreur pour expliquer pourquoi.
 *
 * Ce script tient ces noms au même endroit que le code qui les lit.
 */

const { sequelize, User } = require('../models');
const InventoryService = require('../services/inventoryService');

/**
 * Les noms EXACTS attendus par `verificationStyleService`.
 *
 * S'ils divergent, le style reste verrouillé silencieusement — d'où cette
 * table unique plutôt que des chaînes recopiées.
 */
const ITEMS = {
  rose: 'Badge Verifie Rose',
  gray: 'Badge Verifie Gris',
  gold: 'Badge Verifie Or',
};

async function main() {
  const [username, style] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const revoke = process.argv.includes('--revoke');

  if (!username) {
    console.error('Usage : node src/scripts/grantVerificationBadge.js <pseudo> [rose|gray|gold] [--revoke]');
    process.exit(1);
  }

  await sequelize.authenticate();

  const user = await User.findOne({
    where: { username },
    attributes: ['id', 'username', 'verified', 'verification_style'],
  });
  if (!user) {
    console.error(`Compte « ${username} » introuvable.`);
    process.exit(1);
  }

  // Sans certification, l'objet serait accorde mais le style resterait
  // refuse par `changeUserVerificationStyle`. Autant le dire tout de suite.
  if (!user.verified) {
    console.warn(`⚠ ${username} n'est PAS certifié : le style restera refusé tant que ce sera le cas.`);
  }

  console.log(`Compte  : ${user.username}${user.verified ? ' (certifié)' : ''}`);
  console.log(`Style actuel : ${user.verification_style || 'default'}`);
  for (const [key, item] of Object.entries(ITEMS)) {
    const has = await InventoryService.userHasItem(user.id, item);
    console.log(`  ${key.padEnd(5)} ${has ? 'possédé' : '—'}   (« ${item} »)`);
  }

  if (!style) {
    console.log('\n-> aucun style demandé, rien de modifié.');
    await sequelize.close();
    return;
  }

  const item = ITEMS[style];
  if (!item) {
    console.error(`\nStyle « ${style} » inconnu. Attendus : ${Object.keys(ITEMS).join(', ')}.`);
    process.exit(1);
  }

  if (revoke) {
    console.log(`\n⚠ Le retrait n'est pas automatisé : l'inventaire n'expose pas de suppression sûre.`);
    console.log(`  À faire à la main sur la ligne « ${item} » de ${user.username}.`);
    await sequelize.close();
    return;
  }

  const already = await InventoryService.userHasItem(user.id, item);
  if (already) {
    console.log(`\n-> ${user.username} possède déjà « ${item} », rien à faire.`);
    await sequelize.close();
    return;
  }

  await InventoryService.addItemToUser(user.id, item, 1);
  console.log(`\nOK : « ${item} » accordé à ${user.username}.`);
  console.log(`     Le style « ${style} » est maintenant sélectionnable dans l'app.`);

  await sequelize.close();
}

main().catch((error) => {
  console.error('ECHEC :', error.message);
  process.exit(1);
});
