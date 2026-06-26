const { sequelize } = require('../database/index');
const { VirtualCurrency, UserWallet, User } = require('../models');
const logger = require('../utils/logger');

/**
 * Script d'initialisation du nouveau système économique TwitCoins
 * Supprime le concept de minage et met en place l'économie officielle
 */
async function initNewEconomy() {
  try {
    logger.info('🏦 Initialisation du nouveau système économique TwitCoins...');

    // 1. Mettre à jour ou créer la cryptomonnaie TWITCOINS
    let twitCoinsCurrency = await VirtualCurrency.findOne({
      where: { symbol: 'TWC' }
    });

    if (!twitCoinsCurrency) {
      twitCoinsCurrency = await VirtualCurrency.create({
        name: 'TwitCoins',
        symbol: 'TWC',
        totalSupply: 0, // Offre illimitée basée sur les achats
        circulatingSupply: 0,
        currentPrice: 0.01, // 1 centime d'euro
        basePrice: 0.01,
        currentMultiplier: 1.0,
        purchaseBonus: 0.0, // Pas de bonus initial
        economicTrend: 'stable',
        priceHistory: [
          {
            date: new Date().toISOString(),
            price: 0.01,
            volume: 0,
            multiplier: 1.0
          }
        ],
        marketCap: 0,
        volume24h: 0,
        priceChange24h: 0,
        isActive: true,
        purchasePackages: [
          {
            id: 'small',
            name: 'Pack Starter',
            coins: 100,
            price: 0.99,
            popular: false
          },
          {
            id: 'medium',
            name: 'Pack Popular',
            coins: 500,
            price: 4.99,
            popular: true
          },
          {
            id: 'large',
            name: 'Pack Premium',
            coins: 1200,
            price: 9.99,
            popular: false
          },
          {
            id: 'mega',
            name: 'Pack Elite',
            coins: 2500,
            price: 19.99,
            popular: false
          },
          {
            id: 'ultimate',
            name: 'Pack Ultimate',
            coins: 6000,
            price: 49.99,
            popular: false
          },
          // Nouveaux packages haute valeur
          {
            id: 'vip_100',
            name: 'Pack VIP 100€',
            coins: 10000,
            price: 100.00,
            popular: false
          },
          {
            id: 'vip_500',
            name: 'Pack VIP 500€',
            coins: 50000,
            price: 500.00,
            popular: false
          },
          {
            id: 'vip_1000',
            name: 'Pack VIP 1000€',
            coins: 100000,
            price: 1000.00,
            popular: false
          },
          {
            id: 'vip_10000',
            name: 'Pack VIP 10000€',
            coins: 1000000,
            price: 10000.00,
            popular: false
          }
        ],
        description: 'TwitCoins - La cryptomonnaie officielle de TwitNin. Achetez avec de l\'argent réel pour débloquer des fonctionnalités premium.',
        icon: 'https://example.com/twitcoins-icon.png',
        color: '#1d9bf0'
      });

      logger.info('✅ Cryptomonnaie TwitCoins créée avec succès');
    } else {
      // Mettre à jour la cryptomonnaie existante pour le nouveau système
      await twitCoinsCurrency.update({
        basePrice: 0.01,
        currentMultiplier: 1.0,
        purchaseBonus: 0.0,
        economicTrend: 'stable',
        purchasePackages: [
          {
            id: 'small',
            name: 'Pack Starter',
            coins: 100,
            price: 0.99,
            popular: false
          },
          {
            id: 'medium',
            name: 'Pack Popular',
            coins: 500,
            price: 4.99,
            popular: true
          },
          {
            id: 'large',
            name: 'Pack Premium',
            coins: 1200,
            price: 9.99,
            popular: false
          },
          {
            id: 'mega',
            name: 'Pack Elite',
            coins: 2500,
            price: 19.99,
            popular: false
          },
          {
            id: 'ultimate',
            name: 'Pack Ultimate',
            coins: 6000,
            price: 49.99,
            popular: false
          },
          // Nouveaux packages haute valeur
          {
            id: 'vip_100',
            name: 'Pack VIP 100€',
            coins: 10000,
            price: 100.00,
            popular: false
          },
          {
            id: 'vip_500',
            name: 'Pack VIP 500€',
            coins: 50000,
            price: 500.00,
            popular: false
          },
          {
            id: 'vip_1000',
            name: 'Pack VIP 1000€',
            coins: 100000,
            price: 1000.00,
            popular: false
          },
          {
            id: 'vip_10000',
            name: 'Pack VIP 10000€',
            coins: 1000000,
            price: 10000.00,
            popular: false
          }
        ],
        description: 'TwitCoins - La cryptomonnaie officielle de TwitNin. Achetez avec de l\'argent réel pour débloquer des fonctionnalités premium.'
      });

      logger.info('✅ Cryptomonnaie TwitCoins mise à jour pour le nouveau système');
    }

    // 2. Mettre à jour tous les portefeuilles existants
    const existingWallets = await UserWallet.findAll({
      where: { currencyId: twitCoinsCurrency.id }
    });

    logger.info(`🔄 Mise à jour de ${existingWallets.length} portefeuilles existants...`);

    for (const wallet of existingWallets) {
      await wallet.update({
        totalPurchased: 0, // Réinitialiser les achats
        loyaltyPoints: 0,  // Réinitialiser les points de fidélité
        lastPurchaseDate: null
      });
    }

    // 3. Créer des portefeuilles pour les nouveaux utilisateurs qui n'en ont pas
    const users = await User.findAll({
      attributes: ['id', 'username', 'email']
    });

    let walletsCreated = 0;

    for (const user of users) {
      const existingWallet = await UserWallet.findOne({
        where: { 
          userId: user.id, 
          currencyId: twitCoinsCurrency.id 
        }
      });

      if (!existingWallet) {
        await UserWallet.create({
          userId: user.id,
          currencyId: twitCoinsCurrency.id,
          balance: 0,
          totalEarned: 0,
          totalSpent: 0,
          totalPurchased: 0,
          loyaltyPoints: 0,
          isLocked: false
        });
        walletsCreated++;
      }
    }

    logger.info(`✅ ${walletsCreated} nouveaux portefeuilles créés`);

    // 4. Afficher le résumé du nouveau système
    const totalWallets = await UserWallet.count({
      where: { currencyId: twitCoinsCurrency.id }
    });

    const totalSupply = await UserWallet.sum('balance', {
      where: { currencyId: twitCoinsCurrency.id }
    }) || 0;

    logger.info('📊 Résumé du nouveau système économique:');
    logger.info(`   • Cryptomonnaie: ${twitCoinsCurrency.name} (${twitCoinsCurrency.symbol})`);
    logger.info(`   • Prix de base: ${twitCoinsCurrency.basePrice}€`);
    logger.info(`   • Prix actuel: ${twitCoinsCurrency.currentPrice}€`);
    logger.info(`   • Portefeuilles actifs: ${totalWallets}`);
    logger.info(`   • Offre en circulation: ${totalSupply} TWC`);
    logger.info(`   • Packages d'achat: ${twitCoinsCurrency.purchasePackages.length}`);

    logger.info('🎉 Nouveau système économique initialisé avec succès !');
    logger.info('💡 Fonctionnalités clés:');
    logger.info('   ❌ Plus de minage gratuit');
    logger.info('   ✅ Achat uniquement avec argent réel');
    logger.info('   ✅ Prix dynamiques basés sur l\'économie');
    logger.info('   ✅ Système de bonus et promotions');
    logger.info('   ✅ Points de fidélité');

    return {
      currency: twitCoinsCurrency,
      totalWallets,
      walletsCreated,
      totalSupply
    };

  } catch (error) {
    logger.error('❌ Erreur lors de l\'initialisation du nouveau système économique:', error);
    throw error;
  }
}

// Exécuter le script si appelé directement
if (require.main === module) {
  initNewEconomy()
    .then(() => {
      logger.info('✅ Script d\'initialisation terminé');
      process.exit(0);
    })
    .catch((error) => {
      logger.error('❌ Erreur fatale:', error);
      process.exit(1);
    });
}

module.exports = { initNewEconomy };
