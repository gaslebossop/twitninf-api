const { sequelize } = require('../database/index');
const VirtualCurrency = require('../models/VirtualCurrency');
const UserWallet = require('../models/UserWallet');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const logger = require('../utils/logger');

async function migrateVirtualCurrencyTables() {
  try {
    logger.info('Début de la migration des tables de cryptomonnaie virtuelle...');

    // Synchroniser les modèles avec la base de données
    await VirtualCurrency.sync({ force: false });
    await UserWallet.sync({ force: false });
    await Transaction.sync({ force: false });

    // Créer les associations
    VirtualCurrency.hasMany(UserWallet, { foreignKey: 'currencyId' });
    UserWallet.belongsTo(VirtualCurrency, { foreignKey: 'currencyId' });

    User.hasMany(UserWallet, { foreignKey: 'userId' });
    UserWallet.belongsTo(User, { foreignKey: 'userId' });

    VirtualCurrency.hasMany(Transaction, { foreignKey: 'currencyId', as: 'currency' });
    Transaction.belongsTo(VirtualCurrency, { foreignKey: 'currencyId', as: 'currency' });

    User.hasMany(Transaction, { foreignKey: 'fromUserId', as: 'fromUser' });
    Transaction.belongsTo(User, { foreignKey: 'fromUserId', as: 'fromUser' });

    User.hasMany(Transaction, { foreignKey: 'toUserId', as: 'toUser' });
    Transaction.belongsTo(User, { foreignKey: 'toUserId', as: 'toUser' });

    // Créer la cryptomonnaie par défaut si elle n'existe pas
    const defaultCurrency = await VirtualCurrency.findOne({
      where: { symbol: 'TWC' }
    });

    if (!defaultCurrency) {
      await VirtualCurrency.create({
        name: 'NINFI',
        symbol: 'NF',
        totalSupply: 1000000000,
        circulatingSupply: 0,
        currentPrice: 1.00,
        priceHistory: [],
        marketCap: 0,
        volume24h: 0,
        priceChange24h: 0,
        isActive: true,
        inflationRate: 0.02,
        miningReward: 10,
        maxMiningPerDay: 100,
        description: 'La cryptomonnaie officielle de TwitNin',
        icon: 'https://example.com/twc-icon.png',
        color: '#FF6B35'
      });

      logger.info('Cryptomonnaie TwitCoins créée avec succès');
    }

    logger.info('Migration des tables de cryptomonnaie virtuelle terminée avec succès');
  } catch (error) {
    logger.error('Erreur lors de la migration des tables de cryptomonnaie:', error);
    throw error;
  }
}

// Exécuter la migration si le script est appelé directement
if (require.main === module) {
  migrateVirtualCurrencyTables()
    .then(() => {
      console.log('Migration terminée avec succès');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Erreur lors de la migration:', error);
      process.exit(1);
    });
}

module.exports = migrateVirtualCurrencyTables;
