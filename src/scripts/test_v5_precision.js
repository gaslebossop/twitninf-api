/**
 * 🧪 TEST: Advanced Bot Detection V5 (High Precision & New Features)
 */

const BehaviorDataCollector = require('c:\\Users\\nouno\\OneDrive\\Bureau\\IAFILTRE\\api\\src\\services\\behaviorDataCollector');
const FeatureExtractor = require('c:\\Users\\nouno\\OneDrive\\Bureau\\IAFILTRE\\brain-engine\\FeatureExtractor');
const { UserBehaviorData, User, sequelize } = require('c:\\Users\\nouno\\OneDrive\\Bureau\\IAFILTRE\\api\\src\\models');

async function runTest() {
  console.log('🧪 Démarrage du test V5...');

  try {
    // 1. Trouver un utilisateur test
    const user = await User.findOne();
    if (!user) throw new Error('Aucun utilisateur trouvé pour le test');
    console.log(`👤 Utilisateur test: ${user.username} (${user.id})`);

    const collector = new BehaviorDataCollector();

    // 2. Simuler des actions avec précision milliseconde (Batched)
    const baseTime = Date.now();
    const actionsSource = [
      { type: 'tweet_view', target: '1', delay: 0 },
      { type: 'tap_gesture', target: '1', delay: 150, duration: 120 }, // Humain
      { type: 'tweet_like', target: '1', delay: 1000 },
      { type: 'scroll_jitter', target: null, delay: 2000, jitter: 1.5 },
      { type: 'keyboard_rhythm', target: null, delay: 3000, delays: [120, 150, 110, 200, 130] }
    ];

    console.log('📥 Enregistrement des actions avec client_timestamp...');

    for (const a of actionsSource) {
      const clientTs = new Date(baseTime + a.delay).toISOString();
      await collector.recordUserAction(
        user.id,
        a.type,
        a.target,
        'tweet',
        { 
          client_timestamp: clientTs,
          duration_ms: a.duration || null,
          jitter: a.jitter || null,
          delays: a.delays || null
        }
      );
    }

    // 3. Récupérer les actions et vérifier le FeatureExtractor
    console.log('🔍 Vérification de l\'extraction des caractéristiques...');
    const actions = await UserBehaviorData.findAll({
      where: { user_id: user.id },
      order: [['timestamp', 'DESC']],
      limit: 10,
      raw: true
    });

    const features = FeatureExtractor.extract(actions);
    console.log('📊 Features Extraites:', JSON.stringify(features, null, 2));

    if (features.avg_tap_duration > 0 || features.scroll_jitter_score > 0) {
      console.log('✅ TEST RÉUSSI: Les nouvelles features V5 sont correctement extraites.');
    } else {
      console.warn('⚠️ Attention: Certaines features sont à 0.');
    }

  } catch (error) {
    console.error('❌ Erreur durant le test:', error);
  } finally {
    await sequelize.close();
  }
}

runTest();
