const { DataTypes } = require('sequelize');

class VirtualCurrency {
  static initVirtualCurrencyModel(sequelize) {
    return sequelize.define('VirtualCurrency', {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true
      },
      name: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true,
        comment: 'Nom de la cryptomonnaie (ex: TwitCoins, TwitTokens)'
      },
      symbol: {
        type: DataTypes.STRING(10),
        allowNull: false,
        unique: true,
        comment: 'Symbole de la cryptomonnaie (ex: TWC, TWT)'
      },
      totalSupply: {
        type: DataTypes.DECIMAL(20, 8),
        allowNull: false,
        defaultValue: 1000000000,
        comment: 'Offre totale de la cryptomonnaie'
      },
      circulatingSupply: {
        type: DataTypes.DECIMAL(20, 8),
        allowNull: false,
        defaultValue: 0,
        comment: 'Offre en circulation'
      },
      currentPrice: {
        type: DataTypes.DECIMAL(10, 4),
        allowNull: false,
        defaultValue: 1.00,
        comment: 'Prix actuel en euros'
      },
      priceHistory: {
        type: DataTypes.JSONB,
        allowNull: false,
        defaultValue: [],
        comment: 'Historique des prix (24h, 7j, 30j)'
      },
      marketCap: {
        type: DataTypes.DECIMAL(20, 2),
        allowNull: false,
        defaultValue: 0,
        comment: 'Capitalisation boursière'
      },
      volume24h: {
        type: DataTypes.DECIMAL(20, 2),
        allowNull: false,
        defaultValue: 0,
        comment: 'Volume d\'échanges sur 24h'
      },
      priceChange24h: {
        type: DataTypes.DECIMAL(10, 4),
        allowNull: false,
        defaultValue: 0,
        comment: 'Variation de prix sur 24h (%)'
      },
      isActive: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
        comment: 'Si la cryptomonnaie est active'
      },
      basePrice: {
        type: DataTypes.DECIMAL(10, 4),
        allowNull: false,
        defaultValue: 0.01,
        comment: 'Prix de base en euros (ex: 0.01€ = 1 centime)'
      },
      currentMultiplier: {
        type: DataTypes.DECIMAL(20, 8),
        allowNull: false,
        defaultValue: 1.0,
        comment: 'Multiplicateur de prix actuel basé sur l\'économie (sans limite)'
      },
      purchaseBonus: {
        type: DataTypes.DECIMAL(20, 8),
        allowNull: false,
        defaultValue: 0,
        comment: 'Bonus d\'achat en pourcentage (0.10 = 10% bonus, sans limite)'
      },
      economicTrend: {
        type: DataTypes.ENUM('stable', 'rising', 'falling'),
        allowNull: false,
        defaultValue: 'stable',
        comment: 'Tendance économique actuelle'
      },
      purchasePackages: {
        type: DataTypes.JSONB,
        allowNull: false,
        defaultValue: [],
        comment: 'Packages d\'achat disponibles avec bonus'
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: 'Description de la cryptomonnaie'
      },
      icon: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: 'URL de l\'icône de la cryptomonnaie'
      },
      color: {
        type: DataTypes.STRING(7),
        allowNull: false,
        defaultValue: '#FF6B35',
        comment: 'Couleur de la cryptomonnaie (hex)'
      },
      creatorId: {
        type: DataTypes.UUID,
        allowNull: true,
        references: {
          model: 'users',
          key: 'id'
        },
        comment: 'Créateur si monnaie communautaire ; NULL pour NF et EUR (monnaies système)'
      },
      isUserCreated: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: 'Monnaie créée par un utilisateur (payante) plutôt que par la plateforme'
      }
    }, {
      tableName: 'virtual_currencies',
      timestamps: true,
      indexes: [
        {
          fields: ['symbol']
        }
      ]
    });
  }
}

module.exports = VirtualCurrency;
