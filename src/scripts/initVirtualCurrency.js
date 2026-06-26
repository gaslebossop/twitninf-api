const { sequelize } = require('../database/index');
const { VirtualCurrency, UserWallet, User } = require('../models');
const logger = require('../utils/logger');

async function initVirtualCurrency() {
  try {
    logger.info('🚀 Initialisation du système de cryptomonnaie virtuelle...');

    // 1. Créer la cryptomonnaie NINFI si elle n'existe pas
    let ninfiCurrency = await VirtualCurrency.findOne({
      where: { symbol: 'NF' }
    });

    if (!ninfiCurrency) {
      ninfiCurrency = await VirtualCurrency.create({
        name: 'NINFI',
        symbol: 'NF',
        totalSupply: 1000000000,
        circulatingSupply: 0,
        currentPrice: 1.00,
        priceHistory: [
          {
            date: new Date().toISOString(),
            price: 1.00,
            volume: 0
          }
        ],
        marketCap: 0,
        volume24h: 0,
        priceChange24h: 0,
        isActive: true,
        inflationRate: 0.02,
        miningReward: 10,
        maxMiningPerDay: 100,
        description: 'La cryptomonnaie officielle de TwitNinf - Monnaie virtuelle pour récompenser l\'engagement',
        icon: 'https://example.com/ninfi-icon.png',
        color: '#FF6B35'
      });

      logger.info('✅ Cryptomonnaie NINFI créée avec succès');
    } else {
      logger.info('ℹ️ Cryptomonnaie NINFI déjà existante');
    }

    // 2. Créer des portefeuilles pour tous les utilisateurs existants
    const users = await User.findAll({
      attributes: ['id', 'username', 'email']
    });

    logger.info(`📊 Création de portefeuilles pour ${users.length} utilisateurs...`);

    let walletsCreated = 0;
    let walletsSkipped = 0;

    for (const user of users) {
      // Vérifier si l'utilisateur a déjà un portefeuille pour NINFI
      const existingWallet = await UserWallet.findOne({
        where: {
          userId: user.id,
          currencyId: ninfiCurrency.id
        }
      });

      if (!existingWallet) {
        await UserWallet.create({
          userId: user.id,
          currencyId: ninfiCurrency.id,
          balance: 0,
          totalEarned: 0,
          totalSpent: 0,
          dailyMiningCount: 0,
          isLocked: false
        });

        walletsCreated++;
        logger.info(`✅ Portefeuille créé pour ${user.username}`);
      } else {
        walletsSkipped++;
        logger.info(`ℹ️ Portefeuille déjà existant pour ${user.username}`);
      }
    }

    // 3. Mettre à jour les statistiques de la cryptomonnaie
    const totalWallets = await UserWallet.count({
      where: { currencyId: ninfiCurrency.id }
    });

    const totalBalance = await UserWallet.sum('balance', {
      where: { currencyId: ninfiCurrency.id }
    });

    await ninfiCurrency.update({
      circulatingSupply: totalBalance || 0,
      marketCap: (totalBalance || 0) * ninfiCurrency.currentPrice
    });

    logger.info('📈 Statistiques de la cryptomonnaie mises à jour');
    logger.info(`💰 Total des portefeuilles: ${totalWallets}`);
    logger.info(`💎 Offre en circulation: ${totalBalance || 0} NF`);
    logger.info(`📊 Capitalisation: ${(totalBalance || 0) * ninfiCurrency.currentPrice}€`);

    // 4. Afficher un résumé
    logger.info('🎉 Initialisation terminée avec succès !');
    logger.info(`📝 Résumé:`);
    logger.info(`   - Cryptomonnaie: ${ninfiCurrency.name} (${ninfiCurrency.symbol})`);
    logger.info(`   - Portefeuilles créés: ${walletsCreated}`);
    logger.info(`   - Portefeuilles existants: ${walletsSkipped}`);
    logger.info(`   - Prix actuel: ${ninfiCurrency.currentPrice}€`);

    return {
      currency: ninfiCurrency,
      walletsCreated,
      walletsSkipped,
      totalWallets,
      totalBalance: totalBalance || 0
    };

  } catch (error) {
    logger.error('❌ Erreur lors de l\'initialisation:', error);
    throw error;
  }
}

// Fonction pour donner des bonus aux utilisateurs existants
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
    const welcomeBonus = 50; // 50 NF pour chaque utilisateur

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
  initVirtualCurrency()
    .then(() => {
      logger.info('🎉 Initialisation de la cryptomonnaie terminée !');
      process.exit(0);
    })
    .catch((error) => {
      logger.error('❌ Erreur fatale:', error);
      process.exit(1);
    });
}

module.exports = {
  initVirtualCurrency
};
