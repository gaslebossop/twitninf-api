const { VirtualCurrency, UserWallet, User } = require('../models');
const logger = require('../utils/logger');

async function giveWelcomeBonus() {
  try {
    logger.info('🎁 Attribution des bonus de bienvenue...');

    const ninfiCurrency = await VirtualCurrency.findOne({
      where: { symbol: 'NF' }
    });

    if (!ninfiCurrency) {
      throw new Error('Cryptomonnaie NINFI non trouvée');
    }

    const users = await User.findAll({
      include: [{
        model: UserWallet,
        as: 'wallets',
        where: { currencyId: ninfiCurrency.id },
        required: true
      }]
    });

    let bonusGiven = 0;
    const welcomeBonus = 5; // 50 NF pour chaque utilisateur

    for (const user of users) {
      const wallet = user.wallets[0];
      
      // Vérifier si l'utilisateur a déjà reçu un bonus (balance > 0)
      if (wallet.balance === 0) {
        await wallet.update({
          balance: welcomeBonus,
          totalEarned: welcomeBonus
        });

        bonusGiven++;
        logger.info(`🎁 Bonus de ${welcomeBonus} NF attribué à ${user.username}`);
      }
    }

    // Mettre à jour les statistiques
    const totalBalance = await UserWallet.sum('balance', {
      where: { currencyId: ninfiCurrency.id }
    });

    await ninfiCurrency.update({
      circulatingSupply: totalBalance || 0,
      marketCap: (totalBalance || 0) * ninfiCurrency.currentPrice
    });

    logger.info(`✅ ${bonusGiven} bonus de bienvenue attribués`);
    logger.info(`💰 Nouvelle offre en circulation: ${totalBalance || 0} NF`);

    return { bonusGiven, totalBalance: totalBalance || 0 };

  } catch (error) {
    logger.error('❌ Erreur lors de l\'attribution des bonus:', error);
    throw error;
  }
}

// Exécuter si le script est appelé directement
if (require.main === module) {
  giveWelcomeBonus()
    .then(() => {
      logger.info('🎉 Attribution des bonus terminée !');
      process.exit(0);
    })
    .catch((error) => {
      logger.error('❌ Erreur fatale:', error);
      process.exit(1);
    });
}

module.exports = { giveWelcomeBonus };
