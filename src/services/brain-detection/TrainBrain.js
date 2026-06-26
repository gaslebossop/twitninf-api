/**
 * 🏋️ BotBrain : TrainBrain (V3 - Logistic Regression)
 * 
 * Script de chargement des données et entraînement du modèle ML.
 */

const { User, UserBehaviorData, sequelize } = require('../../models');
const FeatureExtractor = require('./FeatureExtractor');
const BrainDetector = require('./BrainDetector');
const logger = require('../../utils/logger');

async function trainModel() {
  console.log('🚀 Démarrage de l\'entraînement BotBrain (Regression Logistique)...');

  try {
    // 1. RÉCUPÉRER LES BOTS
    const botUserIds = await User.findAll({
      where: {
        [sequelize.Sequelize.Op.or]: [
          { suspension_reason: 'bot' },
          { username: ['a', 'android2', 'jesuisunbot', 'jtejuregang'] }
        ]
      },
      attributes: ['id'],
      raw: true
    }).then(users => users.map(u => u.id));

    // 2. RÉCUPÉRER LES HUMAINS
    const humanUserIds = await User.findAll({
      where: {
        is_suspended: false,
        created_at: { [sequelize.Sequelize.Op.lt]: new Date(Date.now() - 30 * 24 * 3600 * 1000) }
      },
      attributes: ['id'],
      limit: 500, // Dataset plus vaste pour les humains
      raw: true
    }).then(users => users.map(u => u.id));

    console.log(`📊 Dataset : ${botUserIds.length} Bots / ${humanUserIds.length} Humains.`);

    const trainingData = [];

    // 3. EXTRACTION DES FEATURES (Multi-sessions par utilisateur)
    const processUsers = async (ids, outputValue) => {
      const WINDOW_SIZE = 50; // On analyse par blocs de 50 actions
      for (const userId of ids) {
        const allActions = await UserBehaviorData.findAll({
          where: { user_id: userId },
          order: [['timestamp', 'DESC']],
          limit: 1000, 
          raw: true
        });

        // Découpage en fenêtres coulissantes pour multiplier les exemples
        for (let j = 0; j <= allActions.length - WINDOW_SIZE; j += 25) {
          const session = allActions.slice(j, j + WINDOW_SIZE);
          const features = FeatureExtractor.extract(session);
          if (features) {
            trainingData.push({
              input: features,
              output: outputValue
            });
          }
        }

        // Si l'utilisateur a peu d'actions (entre 10 et 49), on prend quand même ce qu'il a
        if (allActions.length < WINDOW_SIZE && allActions.length >= 10) {
          const features = FeatureExtractor.extract(allActions);
          if (features) {
            trainingData.push({ input: features, output: outputValue });
          }
        }
      }
    };

    console.log('🧪 Extraction des caractéristiques...');
    await processUsers(botUserIds, 1); // Bot = 1
    await processUsers(humanUserIds, 0); // Humain = 0

    // 4. INJECTION D'ANCRES DE VÉRITÉ (Synthetic Data pour stabiliser)
    console.log('⚓ Injection des ancres de vérité radicale...');
    for (let i = 0; i < 100; i++) {
        // BOT EXTRÊME : Rapide, précis, 0 signal humain
        trainingData.push({
            input: { avg_delay: 0.05, regularity: 0.9, engagement_ratio: 0.95, impossible_read_rate: 0.95, human_signal_density: 0, action_diversity: 0.2 },
            output: 1
        });
        // HUMAIN EXTRÊME : Lent, chaotique, beaucoup de signaux, lecture réelle
        trainingData.push({
            input: { avg_delay: 0.9, regularity: 0.2, engagement_ratio: 0.1, impossible_read_rate: 0, human_signal_density: 0.9, action_diversity: 0.9 },
            output: 0
        });
    }

    if (trainingData.length < 5) {
      console.error('❌ Trop peu de données pour un entraînement fiable.');
      return;
    }

    // 4. LANCER L'ENTRAÎNEMENT (INTENSIF)
    const results = BrainDetector.train(trainingData);
    
    console.log('✅ MODÈLE GÉNÉRÉ !');
    console.log(`Données traitées: ${results.count}`);

  } catch (error) {
    console.error('❌ Erreur lors de l\'entraînement:', error);
  }
}

if (require.main === module) {
  trainModel().then(() => process.exit(0));
}

module.exports = trainModel;
