const express = require('express');
const cors = require('cors');
const { authenticateToken } = require('./middleware/authMiddleware');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');
const redis = require('redis');
const cron = require('node-cron');
const http = require('http');
const { Server } = require('socket.io');
const { registerMiningHandlers } = require('./sockets/miningSocket');

// Configuration pour désactiver PolicierCongo
const DISABLE_POLICIERCONGO = false; // Désactiver l'automatisation de PolicierCongo

const config = require('./config/config');
const logger = require('./utils/logger');
const { sequelize, testConnection, syncDatabase, closeConnection } = require('./database');
const BanService = require('./services/banService');
const policiercongoAutomatisation = require('./services/policiercongoAutomatisation');
const twitninfaiAutomatisation = require('./services/twitninfaiAutomatisation');
const { streamSearchSummary } = require('./services/searchSummaryService');

/** Migration auto modération (fichier optionnel si déploiement partiel sur le VPS) */
let runAutoMigration = async () => {};
try {
  runAutoMigration = require('./scripts/autoMigration');
} catch (e) {
  logger.warn(
    'scripts/autoMigration introuvable — ignoré au démarrage. Ajoutez src/scripts/autoMigration.js ou npm run migrate:up.',
    { err: e.message }
  );
}
const behaviorDataMigration = require('./services/behaviorDataMigration');
const behaviorDataLoader = require('./services/behaviorDataLoader');
const { initVirtualCurrency } = require('./scripts/initVirtualCurrency');
const PriceEvolutionService = require('./services/priceEvolutionService');

// Import des routes
const authRoutes = require('./routes/authRoutes');
const tweetRoutes = require('./routes/tweetRoutes');
const searchRoutes = require('./routes/searchRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const userRoutes = require('./routes/userRoutes');
const messageRoutes = require('./routes/messageRoutes');
const moderationRoutes = require('./routes/moderationRoutes');
const recommendationRoutes = require('./routes/recommendationRoutes');
const behaviorRoutes = require('./routes/behaviorRoutes');
const monetizationRoutes = require('./routes/monetizationRoutes');
const trackingRoutes = require('./routes/trackingRoutes');
const virtualCurrencyRoutes = require('./routes/virtualCurrencyRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const newEconomyRoutes = require('./routes/newEconomyRoutes');
const casinoRoutes = require('./routes/casinoRoutes');
const tweetMonetizationRoutes = require('./routes/tweetMonetizationRoutes');
const eventRoutes = require('./routes/events');
const functionalEventRoutes = require('./routes/functionalEventRoutes');
const themePresetRoutes = require('./routes/themePresets');
const progressiveRecommendationRoutes = require('./routes/progressiveRecommendationRoutes');
const userStatsRoutes = require('./routes/userStatsRoutes');
const verificationRoutes = require('./routes/verificationRoutes');
const adRoutes = require('./routes/adRoutes');
const userChallengeRoutes = require('./routes/userChallengeRoutes');
const verifiedBadgeRoutes = require('./routes/verifiedBadgeRoutes');
const verificationStyleRoutes = require('./routes/verificationStyleRoutes');
const inventoryRoutes = require('./routes/inventoryRoutes');
const aiRecommendationRoutes = require('./routes/aiRecommendationRoutes');
const economyAdminRoutes = require('./routes/economyAdminRoutes');
const similarityAdminRoutes = require('./routes/similarityAdminRoutes');
const shadowbanAdminRoutes = require('./routes/shadowbanAdminRoutes');
const policierCongoAdminRoutes = require('./routes/policierCongoAdminRoutes');
const policierCongoChatRoutes = require('./routes/policierCongoChatRoutes');
const policierCongoV3Router = require('./services/policiercongo/policiercongov3/router');
const { getPolicierCongoV3 } = require('./services/policiercongo/policiercongov3/orchestrator');
const developerAdminRoutes = require('./routes/developerAdminRoutes');
const detectionRoutes = require('./routes/detectionRoutes');
const userSimilarityRoutes = require('./routes/userSimilarityRoutes');
const neuralRankRoutes = require('./routes/neuralRankRoutes');
const walletRoutes = require('./routes/walletRoutes');
const premiumRoutes = require('./routes/premiumRoutes');

// 🎯 Import du module de ciblage étendu (chemin absolu pour compatibilité VPS apibeta vs api)
let _targetingModule = null;
try {
  const _tPath = require('path').resolve(__dirname, '..', '..', '..', 'targeting');
  _targetingModule = require(_tPath);
} catch (e) {
  try {
    _targetingModule = require('../../targeting');
  } catch (e2) {
    console.warn('⚠️ [server.js] Module targeting non trouvé:', e2.message);
    _targetingModule = { initialize: () => false, targetingRoutes: require('express').Router(), targetingService: null, closeDB: () => {} };
  }
}
const { initialize: initTargeting, targetingRoutes, targetingService, closeDB: closeTargetingDB } = _targetingModule;

// Import du moteur de similarité JS ultra-rapide
const similarity = require('./services/similarity');
const videoRecommendationService = require('./services/videoRecommendationService');

// Import du middleware global de ban
const { globalBanCheck } = require('./middleware/globalBanMiddleware');

// Import du service de détection des fraudes (Redis ↔ Rust)
const fraudService = require('./services/fraudDetectionService');
const { blockBannedIp, checkApiRequest } = require('./middleware/fraudMiddleware');

// Créer l'application Express
const app = express();

// ⚠️ SÉCURITÉ — Confiance au proxy inverse (Nginx) UNIQUEMENT.
// Avec `trust proxy = 1`, Express dérive req.ip du DERNIER hop de confiance
// (le X-Forwarded-For ajouté par Nginx), et ignore tout XFF supplémentaire
// injecté par le client. Sans cela, un attaquant pourrait usurper son IP via
// l'en-tête X-Forwarded-For et contourner le blocage d'IP, la réputation et
// le rate-limit. La valeur 1 = un seul proxy (Nginx) devant l'API.
app.set('trust proxy', 1);

// Configuration Redis pour le cache
const redisClient = redis.createClient(config.redis);
redisClient.on('error', (err) => logger.error('Erreur Redis:', err));
redisClient.on('connect', () => logger.info('Connexion Redis établie'));

// Connexion du service de détection des fraudes sur le même Redis
fraudService.connect(config.redis).catch((e) =>
  logger.warn('[fraud] Service non disponible au démarrage:', e.message)
);

// Middleware de sécurité
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// Configuration CORS
app.use(cors(config.server.cors));

// Compression des réponses optimisée
app.use(compression(config.performance.compression));

// Limitation du taux de requêtes global - Version plus permissive pour les tests
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // 1000 requêtes par fenêtre (augmenté)
  // Le minage (app Windows) soumet un nonce à chaque bloc trouvé — en usage
  // normal ça peut aller bien au-delà de 1000/15min sans être un abus, donc
  // ces routes ont leur propre limite dédiée (voir miningLimiter) au lieu de
  // partager le quota global avec le reste de l'app.
  skip: (req) => req.path.startsWith('/new-economy/mining'),
  message: {
    success: false,
    message: 'Trop de requêtes. Réessayez plus tard.'
  }
});
app.use('/api/', limiter);

// Limitation dédiée au minage : plus permissive que le quota global, car un
// mineur actif (surtout GPU) peut légitimement soumettre beaucoup de blocs.
const miningLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 300, // 300 requêtes/minute (round + submit cumulés)
  message: {
    success: false,
    message: 'Trop de requêtes de minage. Réessayez dans quelques secondes.'
  }
});
app.use('/api/new-economy/mining', miningLimiter);

// Protection rate limit sur les routes d'authentification
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 tentatives par fenêtre (augmenté de 5 à 100)
  message: {
    success: false,
    message: 'Trop de tentatives de connexion. Réessayez plus tard.'
  }
});

app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

// Protection rate limit sur les routes de tweets (plus strict)
const tweetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200, // 200 tweets par fenêtre
  message: {
    success: false,
    message: 'Trop de tweets. Réessayez plus tard.'
  }
});

app.use('/api/tweets', tweetLimiter);

// Protection rate limit sur les routes de recherche
const searchLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300, // 300 recherches par fenêtre
  message: {
    success: false,
    message: 'Trop de recherches. Réessayez plus tard.'
  }
});

app.use('/api/search', searchLimiter);

// Logging des requêtes
app.use(morgan('combined', {
  stream: {
    write: (message) => logger.info(message.trim())
  }
}));

// Parser pour le corps des requêtes
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// NOTE SÉCURITÉ : on n'écrase PLUS req.ip à partir de l'en-tête brut
// X-Forwarded-For (falsifiable par le client). Express calcule désormais
// req.ip de façon fiable grâce à `app.set('trust proxy', 1)` ci-dessus.
// (req.ip est en lecture seule via un getter une fois trust proxy actif.)

// Middleware pour ajouter la plateforme utilisateur
app.use((req, res, next) => {
  req.userPlatform = req.headers['user-platform'] || 'unknown';
  next();
});

// Middleware de cache pour les ressources statiques (pointage sur src/public)
app.use('/static', express.static(path.join(__dirname, './public'), {
  maxAge: '1y',
  etag: true
}));

// Alias direct avatars (sans auth)
app.use('/static/avatars', express.static(path.join(__dirname, './public/avatars'), {
  maxAge: '1y',
  etag: true
}));

// Route statique pour les vidéos uploadées
const storageDir = path.join(__dirname, '../storage');
if (!fs.existsSync(storageDir)) {
  fs.mkdirSync(storageDir, { recursive: true });
}
app.use('/storage', express.static(storageDir, {
  maxAge: '30d',
  etag: true
}));

// Route explicite pour servir un avatar (fallback si static ne matche pas)
app.get('/static/avatars/:filename', (req, res) => {
  const avatarsDir = path.join(__dirname, './public/avatars');
  const filePath = path.join(avatarsDir, req.params.filename);
  if (fs.existsSync(filePath)) {
    return res.sendFile(filePath);
  }
  res.status(404).json({ success: false, message: 'Fichier non trouvé' });
});

// Middleware global de vérification des bans (appliqué à toutes les routes API)
app.use('/api', globalBanCheck);

// ── Fraude : blocage instantané des IPs blacklistées (O(1) Redis GET) ────────
app.use('/api', blockBannedIp);

// ── Fraude : analyse asynchrone de chaque requête API (background, non-bloquant)
app.use('/api', checkApiRequest);

// Routes API - Version complète avec toutes les fonctionnalités
app.use('/api/auth', (req, res, next) => {
  console.log('🔵 Route auth appelée:', req.method, req.path);
  next();
}, authRoutes);

app.use('/api/tweets', (req, res, next) => {
  console.log('🐦 Route tweets appelée:', req.method, req.path);
  next();
}, tweetRoutes);

app.use('/api/search', (req, res, next) => {
  console.log('🔍 Route recherche appelée:', req.method, req.path);
  next();
}, searchRoutes);

app.use('/api/notifications', (req, res, next) => {
  console.log('🔔 Route notifications appelée:', req.method, req.path);
  next();
}, notificationRoutes);

app.use('/api/users', (req, res, next) => {
  console.log('👤 Route utilisateurs appelée:', req.method, req.path);
  next();
}, userRoutes);

app.use('/api/messages', (req, res, next) => {
  console.log('💬 Route messages appelée:', req.method, req.path);
  next();
}, messageRoutes);

app.use('/api/moderation', (req, res, next) => {
  console.log('🛡️ Route modération appelée:', req.method, req.path);
  next();
}, moderationRoutes);

app.use('/api/recommendations', (req, res, next) => {
  console.log('🚀 Route recommandations appelée:', req.method, req.path);
  next();
}, recommendationRoutes);

app.use('/api/behavior', (req, res, next) => {
  console.log('📊 Route comportement appelée:', req.method, req.path);
  next();
}, behaviorRoutes);

app.use('/api/monetization', (req, res, next) => {
  console.log('💰 Route monétisation appelée:', req.method, req.path);
  next();
}, monetizationRoutes);

app.use('/api/virtual-currency', (req, res, next) => {
  console.log('🪙 Route cryptomonnaie virtuelle appelée:', req.method, req.path);
  next();
}, virtualCurrencyRoutes);

app.use('/api/payments', (req, res, next) => {
  console.log('💳 Route paiements appelée:', req.method, req.path);
  next();
}, paymentRoutes);

app.use('/api/new-economy', (req, res, next) => {
  console.log('🏦 Route nouvelle économie appelée:', req.method, req.path);
  next();
}, newEconomyRoutes);

app.use('/api/casino', (req, res, next) => {
  console.log('🎰 Route casino appelée:', req.method, req.path);
  next();
}, casinoRoutes);

app.use('/api/tweet-monetization', (req, res, next) => {
  console.log('💰 Route monétisation tweets appelée:', req.method, req.path);
  next();
}, tweetMonetizationRoutes);

app.use('/api/events', (req, res, next) => {
  console.log('🎉 Route événements appelée:', req.method, req.path);
  next();
}, eventRoutes);

app.use('/api/functional-events', (req, res, next) => {
  console.log('⚡ Route événements fonctionnels appelée:', req.method, req.path);
  next();
}, functionalEventRoutes);

app.use('/api/theme-presets', (req, res, next) => {
  console.log('🎨 Route presets de thèmes appelée:', req.method, req.path);
  next();
}, themePresetRoutes);

app.use('/api/progressive-recommendations', (req, res, next) => {
  console.log('🚀 Route recommandations progressives appelée:', req.method, req.path);
  next();
}, progressiveRecommendationRoutes);

// NeuralRank Fusion — moteur Rust haute performance
app.use('/api/neural-rank', neuralRankRoutes);

// Wallet et Premium
app.use('/api/wallet', walletRoutes);
app.use('/api/premium', premiumRoutes);

// 📊 CTR Tracking pour l'algorithme Rust
app.use('/api/track', (req, res, next) => {
  console.log('📊 Route tracking appelée:', req.method, req.path);
  next();
}, trackingRoutes);

app.use('/api/user-stats', (req, res, next) => {
  console.log('📈 Route statistiques utilisateur appelée:', req.method, req.path);
  console.log('📈 Routes disponibles:', userStatsRoutes.stack ? userStatsRoutes.stack.map(r => r.route?.path) : 'Pas de stack');
  next();
}, userStatsRoutes);

app.use('/api/verification', (req, res, next) => {
  console.log('📋 Route vérification appelée:', req.method, req.path);
  next();
}, verificationRoutes);

// Routes publicitaires
app.use('/api/ads', (req, res, next) => {
  console.log('🎯 Route publicité appelée:', req.method, req.path);
  next();
}, adRoutes);

// Routes des défis d'utilisateur
app.use('/api/user-challenges', (req, res, next) => {
  console.log('🎯 Route défis utilisateur appelée:', req.method, req.path);
  next();
}, userChallengeRoutes);

// Routes des badges vérifiés
app.use('/api/verified-badges', (req, res, next) => {
  console.log('🏆 Route badges vérifiés appelée:', req.method, req.path);
  next();
}, verifiedBadgeRoutes);

// Routes des styles de vérification
app.use('/api/verification-style', (req, res, next) => {
  console.log('🎨 Route styles de vérification appelée:', req.method, req.path);
  next();
}, verificationStyleRoutes);

// Routes de l'inventaire
app.use('/api/inventory', (req, res, next) => {
  console.log('🎒 Route inventaire appelée:', req.method, req.path);
  next();
}, inventoryRoutes);

// 🧠 Routes de recommandation IA (Deep Learning)
app.use('/api/ai-recommendations', (req, res, next) => {
  console.log('🧠 Route recommandations IA appelée:', req.method, req.path);
  next();
}, aiRecommendationRoutes);

// 🛡️ Routes d'administration de l'économie
app.use('/api/admin/economy', (req, res, next) => {
  console.log('🛡️ Route admin économie appelée:', req.method, req.path);
  next();
}, economyAdminRoutes);

app.use('/api/admin/similarity', similarityAdminRoutes);
app.use('/api/admin/shadowban', shadowbanAdminRoutes);

// 🛡️ Routes d'administration de PolicierCongo
app.use('/api/admin/policiercongo', policierCongoAdminRoutes);

// 💬 Routes de Chat avec PolicierCongo
app.use('/api/policiercongo/chat', policierCongoChatRoutes);

// 🧠 PolicierCongo V3 — moteur agentique, mémoire et streaming
app.use('/api/policiercongo/v3', policierCongoV3Router);

// 🎯 Routes du ciblage étendu (Targeting)
if (targetingRoutes) {
  app.use('/api/targeting', targetingRoutes);
}

// 📦 Routes pour les développeurs externes
app.use('/api/developer', developerAdminRoutes);

// 🔍 Route de détection pour les tests
app.use('/api/detection', detectionRoutes);

// 👥 Route de similarité utilisateur
app.use('/api/user-similarity', userSimilarityRoutes);

// Endpoint pour déclencher manuellement l'analyse intelligente PolicierCongo
app.post('/api/policiercongo/analyze', async (req, res) => {
  try {
    logger.info('🔍 Déclenchement manuel de l\'analyse intelligente PolicierCongo...');
    
    const result = await policiercongoAutomatisation.runIntelligentAutomation();
    
    if (result) {
      const memoryStatus = policiercongoAutomatisation.getGeminiMemoryStatus();
      
      res.json({
        success: true,
        message: 'Analyse intelligente PolicierCongo déclenchée avec succès',
        result: result,
        memoryStatus: memoryStatus,
        timestamp: new Date().toISOString()
      });
    } else {
      res.json({
        success: false,
        message: 'Analyse intelligente PolicierCongo terminée sans action',
        timestamp: new Date().toISOString()
      });
    }
  } catch (error) {
    logger.error('❌ Erreur lors du déclenchement manuel:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de l\'analyse intelligente',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Endpoint de diagnostic simple (Ping)
app.get('/api/ping', (req, res) => {
  res.json({ success: true, message: 'pong', timestamp: new Date().toISOString() });
});

// Endpoint pour obtenir le statut du scheduler PolicierCongo (DEBUG SANS AUTH)
app.get('/api/debug/policiercongo/scheduler', (req, res) => {
  try {
    const schedulerManager = require('./services/policiercongo/schedulerManager');
    schedulerManager.load();
    const nextRun = schedulerManager.nextRunTime;
    const now = new Date();
    const isReady = schedulerManager.isTimeForRun();
    let minutesUntilRun = null;
    if (nextRun && !isReady) {
      minutesUntilRun = Math.max(0, Math.round((nextRun.getTime() - now.getTime()) / 60000));
    }
    res.json({
      success: true,
      scheduler: {
        next_run_time: nextRun ? nextRun.toISOString() : null,
        is_ready_to_run: isReady,
        minutes_until_run: minutesUntilRun,
        server_iso: now.toISOString()
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Endpoint pour obtenir le statut du scheduler PolicierCongo (Direct avec Auth)
app.get('/api/admin/policiercongo/scheduler', authenticateToken, (req, res) => {
  try {
    const schedulerManager = require('./services/policiercongo/schedulerManager');
    schedulerManager.load();
    const nextRun = schedulerManager.nextRunTime;
    const now = new Date();
    const isReady = schedulerManager.isTimeForRun();
    let minutesUntilRun = null;
    if (nextRun && !isReady) {
      minutesUntilRun = Math.max(0, Math.round((nextRun.getTime() - now.getTime()) / 60000));
    }
    res.json({
      success: true,
      scheduler: {
        next_run_time: nextRun ? nextRun.toISOString() : null,
        is_ready_to_run: isReady,
        minutes_until_run: minutesUntilRun,
        status: isReady ? 'ready' : 'sleeping',
        server_iso: now.toISOString()
      }
    });
  } catch (error) {
    logger.error('❌ Erreur route directe scheduler GET:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Endpoint pour réinitialiser le scheduler (Direct avec Auth)
app.delete('/api/admin/policiercongo/scheduler', authenticateToken, (req, res) => {
  try {
    const schedulerManager = require('./services/policiercongo/schedulerManager');
    schedulerManager.reset();
    res.json({ success: true, message: 'Scheduler réinitialisé' });
  } catch (error) {
    logger.error('❌ Erreur route directe scheduler DELETE:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Endpoint pour forcer une exécution immédiate (Direct avec Auth)
app.post('/api/admin/policiercongo/scheduler/run', authenticateToken, async (req, res) => {
  try {
    const policiercongoAutomatisation = require('./services/policiercongoAutomatisation');
    // On ignore le gate du scheduler pour un run manuel
    const result = await policiercongoAutomatisation.runOptimizedAutomation();
    res.json({ success: true, result });
  } catch (error) {
    logger.error('❌ Erreur route directe scheduler RUN:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Endpoint pour obtenir le statut de la mémoire Gemini
app.get('/api/policiercongo/status', async (req, res) => {
  try {
    const memoryStatus = policiercongoAutomatisation.getGeminiMemoryStatus();
    
    res.json({
      success: true,
      memoryStatus: memoryStatus,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('❌ Erreur lors de la récupération du statut:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération du statut',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Endpoint pour réinitialiser la mémoire Gemini
app.post('/api/policiercongo/reset-memory', async (req, res) => {
  try {
    logger.info('🧠 Réinitialisation manuelle de la mémoire Gemini...');
    
    policiercongoAutomatisation.resetGeminiMemory();
    
    res.json({
      success: true,
      message: 'Mémoire Gemini réinitialisée avec succès',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('❌ Erreur lors de la réinitialisation de la mémoire:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la réinitialisation de la mémoire',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Route de santé avec vérification de la base de données
app.get('/api/health', async (req, res) => {
  try {
    const dbStatus = await testConnection();
    const redisStatus = redisClient.ready ? 'connected' : 'disconnected';
    
    res.status(200).json({
      success: true,
      message: 'API wtitninf opérationnelle',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: config.server.env,
      database: dbStatus ? 'connected' : 'disconnected',
      redis: redisStatus,
      memory: process.memoryUsage(),
      version: require('../package.json').version,
      features: {
        tweets: true,
        search: true,
        notifications: true,
        likes: true,
        retweets: true,
        user_follows: true,
        ai_recommendations: getAIBridge().ready
      }
    });
  } catch (error) {
    res.status(503).json({
      success: false,
      message: 'Service indisponible',
      error: error.message
    });
  }
});

// Route racine
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Bienvenue sur l\'API wtitninf',
    version: '1.0.0',
    documentation: '/docs',
    health: '/health',
    endpoints: {
      auth: '/api/auth',
      tweets: '/api/tweets',
      search: '/api/search',
      notifications: '/api/notifications'
    },
    features: {
      'Gestion des tweets': 'Création, lecture, mise à jour, suppression',
      'Système de likes': 'Liker/unliker des tweets',
      'Système de retweets': 'Retweeter avec ou sans commentaire',
      'Recherche avancée': 'Utilisateurs, tweets, hashtags',
      'Notifications': 'Likes, retweets, mentions, suivis',
      'Relations utilisateurs': 'Suivre/ne plus suivre',
      'Statistiques': 'Compteurs automatiques mis à jour'
    }
  });
});

// Route de test pour l'API
app.get('/test', (req, res) => {
  res.json({
    success: true,
    message: 'Route de test fonctionnelle',
    timestamp: new Date().toISOString(),
    routes: {
      health: '/api/health',
      auth: '/api/auth',
      tweets: '/api/tweets',
      search: '/api/search',
      notifications: '/api/notifications'
    },
    examples: {
      'Créer un tweet': 'POST /api/tweets',
      'Liker un tweet': 'POST /api/tweets/:id/like',
      'Rechercher des utilisateurs': 'GET /api/search/users?q=john',
      'Obtenir les notifications': 'GET /api/notifications'
    }
  });
});

// Middleware de gestion des erreurs 404
app.use('*', (req, res) => {
  logger.warn('Route non trouvée', {
    method: req.method,
    path: req.originalUrl,
    ip: req.ip,
    userAgent: req.get('User-Agent')
  });

  res.status(404).json({
    success: false,
    message: 'Route non trouvée',
    path: req.originalUrl,
    available_endpoints: [
      '/api/auth',
      '/api/tweets',
      '/api/search',
      '/api/notifications',
      '/api/health'
    ]
  });
});

// Middleware de gestion des erreurs global
app.use((error, req, res, next) => {
  logger.error('Erreur serveur', {
    error: error.message,
    stack: error.stack,
    method: req.method,
    path: req.path,
    ip: req.ip,
    userAgent: req.get('User-Agent')
  });

  // Ne pas exposer les détails d'erreur en production
  const message = config.server.env === 'production' 
    ? 'Erreur interne du serveur' 
    : error.message;

  res.status(error.status || 500).json({
    success: false,
    message,
    ...(config.server.env === 'development' && { stack: error.stack })
  });
});

// Tâches cron pour la maintenance
function setupCronJobs() {
  // Nettoyage des sessions expirées (toutes les heures)
  cron.schedule('0 * * * *', async () => {
    try {
      logger.info('Nettoyage des sessions expirées...');
      // Logique de nettoyage ici
    } catch (error) {
      logger.error('Erreur lors du nettoyage des sessions:', error);
    }
  });

  // Optimisation de la base de données (tous les jours à 2h du matin)
  cron.schedule('0 2 * * *', async () => {
    try {
      logger.info('Optimisation de la base de données...');
      await sequelize.query('VACUUM ANALYZE users;');
      await sequelize.query('VACUUM ANALYZE tweets;');
      await sequelize.query('VACUUM ANALYZE tweet_likes;');
      await sequelize.query('VACUUM ANALYZE tweet_retweets;');
      await sequelize.query('VACUUM ANALYZE notifications;');
      await sequelize.query('VACUUM ANALYZE user_follows;');
      logger.info('Optimisation terminée');
    } catch (error) {
      logger.error('Erreur lors de l\'optimisation:', error);
    }
  });

  // Sauvegarde des statistiques (toutes les 6 heures)
  cron.schedule('0 */6 * * *', async () => {
    try {
      logger.info('Sauvegarde des statistiques...');
      // Logique de sauvegarde ici
    } catch (error) {
      logger.error('Erreur lors de la sauvegarde:', error);
    }
  });

  // Mise à jour des prix des cryptomonnaies (toutes les heures)
  cron.schedule('0 * * * *', async () => {
    try {
      logger.info('🕐 Mise à jour programmée des prix des cryptomonnaies...');
      await PriceEvolutionService.scheduledPriceUpdate();
    } catch (error) {
      logger.error('❌ Erreur lors de la mise à jour des prix:', error);
    }
  });

  // Nettoyage des notifications anciennes (tous les jours à 3h du matin)
  cron.schedule('0 3 * * *', async () => {
    try {
      logger.info('Nettoyage des notifications anciennes...');
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      
      const deletedCount = await sequelize.models.Notification.destroy({
        where: {
          created_at: { [sequelize.Op.lt]: thirtyDaysAgo },
          is_read: true
        }
      });
      
      logger.info(`${deletedCount} notifications anciennes supprimées`);
    } catch (error) {
      logger.error('Erreur lors du nettoyage des notifications:', error);
    }
  });

  // Nettoyage des suspensions expirées (toutes les heures)
  cron.schedule('0 * * * *', async () => {
    try {
      logger.info('Nettoyage des suspensions expirées...');
      const cleanedCount = await BanService.cleanupExpiredSuspensions();
      
      if (cleanedCount > 0) {
        logger.info(`${cleanedCount} suspensions expirées nettoyées automatiquement`);
      }
    } catch (error) {
      logger.error('Erreur lors du nettoyage des suspensions:', error);
    }
  });

  // Synchronisation de la similarité utilisateur (Tous les jours à 4h du matin)
  cron.schedule('0 4 * * *', async () => {
    try {
      logger.info('👥 [Cron] Synchronisation des vecteurs de similarité utilisateur...');
      const userSimilarityService = require('./services/userSimilarityService');
      await userSimilarityService.syncAllUsers();
      logger.info('✅ [Cron] Synchronisation de similarité terminée');
    } catch (error) {
      logger.error('❌ [Cron] Erreur synchronisation similarity:', error);
    }
  });

  // Analyse intelligente PolicierCongo (toutes les 10 minutes — respecte le planning dynamique du scheduler)
  cron.schedule('*/10 * * * *', async () => {
    // Vérifier si PolicierCongo est désactivé
    if (DISABLE_POLICIERCONGO) {
      logger.info('🚫 PolicierCongo désactivé - Tâche cron ignorée');
      return;
    }

    try {
      const policierCongoV3 = getPolicierCongoV3();
      if (policierCongoV3.config.enabled) {
        // Le scheduler persistant V3 décide seul des réveils. Ce cron reste un filet de sécurité.
        const tick = await policierCongoV3.scheduler.runDueOnce();
        if (tick.claimed > 0) logger.info(`🧠 [Cron] PolicierCongo V3: ${tick.claimed} réveil(s) traité(s)`);
        return;
      }
      const schedulerManager = require('./services/policiercongo/schedulerManager');

      // GATE : Respecter le planning décidé par l'IA
      if (!schedulerManager.isTimeForRun()) {
        // Pas encore l'heure, on log discrètement et on skip
        return;
      }

      // Verrouiller pour éviter les exécutions parallèles
      schedulerManager.startRun();

      logger.info('🔄 [Cron] Lancement de l\'analyse PolicierCongo (scheduler ready)...');
      const result = await policiercongoAutomatisation.runOptimizedAutomation();
      
      if (result && result.success) {
        if (result.skipped) {
          logger.info(`ℹ️ PolicierCongo: en attente du prochain réveil (${result.reason})`);
        } else {
          logger.info(`✅ Analyse intelligente PolicierCongo terminée (${result.summary || 'OK'})`);
        }
      } else {
        logger.warn('⚠️ Analyse intelligente PolicierCongo terminée sans succès ou erreur');
      }
    } catch (error) {
      logger.error('❌ Erreur lors de la relance de l\'analyse PolicierCongo:', error);
    }
  });

  // TwitNinfAI officiel (a chaque heure precise)
  cron.schedule('0 * * * *', async () => {
    try {
      logger.info('🤖 Relance automatique TwitNinfAI...');
      const result = await twitninfaiAutomatisation.runOptimizedAutomation();
      if (result?.success) {
        if (result.skipped) {
          logger.info(`ℹ️ TwitNinfAI: publication ignoree (${result.reason})`);
        } else {
          logger.info(`✅ TwitNinfAI: tweet publie (${result.tweet_id})`);
        }
      } else {
        logger.warn(`⚠️ TwitNinfAI: echec (${result?.error || 'unknown'})`);
      }
    } catch (error) {
      logger.error('❌ Erreur cron TwitNinfAI:', error);
    }
  });

  // 🎯 CIBLAGE ÉTENDU — Analyse des batchs toutes les 2 heures
  cron.schedule('0 */2 * * *', async () => {
    try {
      logger.info('🎯 [Targeting] Lancement de l\'analyse des batchs (cron 2h)...');
      const result = await targetingService.processAllPendingBatches();
      logger.info(`🎯 [Targeting] Analyse terminée: ${result.processed} batchs traités pour ${result.users} utilisateurs en ${result.duration_ms}ms`);
    } catch (error) {
      logger.error('❌ [Targeting] Erreur lors de l\'analyse des batchs:', error);
    }
  });
}

// Fonction pour lancer l'analyse intelligente de PolicierCongo
async function launchPolicierCongoAnalysis() {
  // Vérifier si PolicierCongo est désactivé
  if (DISABLE_POLICIERCONGO) {
    logger.info('🚫 PolicierCongo désactivé - Analyse intelligente ignorée');
    return;
  }

  try {
    const schedulerManager = require('./services/policiercongo/schedulerManager');
    
    // GATE : Vérifier immédiatement si c'est l'heure du run
    if (!schedulerManager.isTimeForRun()) {
      logger.info('⏰ PolicierCongo : Pas encore l\'heure du run (planification respectée).');
      return;
    }

    // NOUVEAU : On marque immédiatement le début du run pour éviter les lancements multiples
    // durant le temps de calcul de l'IA.
    schedulerManager.startRun();

    logger.info('👤 Démarrage de l\'analyse intelligente pour le bot...');
    
    // Attendre un peu que le serveur soit complètement démarré
    setTimeout(async () => {
      try {
        // NOUVEAU : Utiliser l'architecture optimisée en 2 phases
        const result = await policiercongoAutomatisation.runOptimizedAutomation();
        
        if (result && result.success && !result.skipped) {
          logger.info('✅ Analyse intelligente terminée avec succès');
          logger.info(`📊 Résumé: ${result.summary}`);
          
          // Afficher le statut de la mémoire Gemini
          const memoryStatus = policiercongoAutomatisation.getGeminiMemoryStatus();
          logger.info('🧠 Statut de la mémoire Gemini:', {
            tailleMemoire: memoryStatus.memorySize,
            derniereMiseAJour: memoryStatus.lastUpdated,
            humeurCommunaute: memoryStatus.communityMood
          });
          
          // Afficher les statistiques d'automatisation si disponibles
          if (memoryStatus.automation_stats) {
            logger.info('📈 Statistiques d\'automatisation:', {
              totalRuns: memoryStatus.automation_stats.total_runs,
              successfulRuns: memoryStatus.automation_stats.successful_runs,
              failedRuns: memoryStatus.automation_stats.failed_runs,
              errorRuns: memoryStatus.automation_stats.error_runs
            });
          }
          
        } else {
          logger.warn('⚠️ Analyse intelligente PolicierCongo optimisée terminée sans succès');
          if (result && result.error) {
            logger.warn(`❌ Erreur: ${result.error}`);
          }
        }
      } catch (error) {
        logger.error('❌ Erreur lors de l\'analyse intelligente PolicierCongo:', error);
      }
    }, 5000); // Attendre 5 secondes après le démarrage du serveur
    
  } catch (error) {
    logger.error('❌ Erreur lors du lancement de l\'analyse PolicierCongo:', error);
  }
}

// Fonction de lancement startup pour TwitNinfAI
async function launchTwitNinfAIIfNeeded() {
  try {
    logger.info('🤖 Vérification startup TwitNinfAI...');
    setTimeout(async () => {
      try {
        const result = await twitninfaiAutomatisation.runOptimizedAutomation();
        if (result?.success) {
          if (result.skipped) {
            logger.info(`ℹ️ TwitNinfAI startup: pas de lancement (${result.reason})`);
          } else {
            logger.info(`✅ TwitNinfAI startup: tweet publié (${result.tweet_id})`);
          }
        } else {
          logger.warn(`⚠️ TwitNinfAI startup: échec (${result?.error || 'unknown'})`);
        }
      } catch (error) {
        logger.error('❌ Erreur lancement startup TwitNinfAI:', error);
      }
    }, 7000); // Laisser le serveur monter complètement avant la vérification
  } catch (error) {
    logger.error('❌ Erreur pré-lancement TwitNinfAI:', error);
  }
}

// Fonction de démarrage du serveur
async function startServer() {
  try {
    // Connecter à la base de données
    const dbConnected = await testConnection();
    if (!dbConnected) {
      throw new Error('Impossible de se connecter à PostgreSQL');
    }

    // Synchroniser la base de données (créer les tables si elles n'existent pas)
    await syncDatabase();

    // Exécuter la migration automatique pour les colonnes de modération
    await runAutoMigration();

    // 📊 Initialiser les données comportementales
    logger.info('📊 Initialisation des données comportementales...');
    try {
      await behaviorDataMigration.initializeOnStartup();
      await behaviorDataLoader.initializeOnStartup();
      logger.info('✅ Données comportementales initialisées avec succès');
    } catch (error) {
      logger.error('❌ Erreur initialisation données comportementales:', error);
      // Ne pas arrêter le serveur, les données comportementales ne sont pas critiques
    }

    // 💰 Initialiser le système de cryptomonnaie virtuelle
    logger.info('💰 Initialisation du système de cryptomonnaie virtuelle...');
    try {
      await initVirtualCurrency();
      logger.info('✅ Système de cryptomonnaie virtuelle initialisé avec succès');
    } catch (error) {
      logger.error('❌ Erreur initialisation cryptomonnaie:', error);
      // Ne pas arrêter le serveur, la cryptomonnaie n'est pas critique
    }

    // 🎯 Initialiser le module de ciblage étendu
    logger.info('🎯 Initialisation du module de ciblage étendu...');
    try {
      const targetingReady = initTargeting();
      if (targetingReady) {
        logger.info('✅ Module de ciblage étendu initialisé avec succès');
      } else {
        logger.warn('⚠️ Module de ciblage étendu non initialisé (non critique)');
      }
    } catch (error) {
      logger.error('❌ Erreur initialisation ciblage étendu:', error);
    }

    // 🎯 INITIALISATION SOCKET.IO
    const httpServer = http.createServer(app);
    const io = new Server(httpServer, {
      cors: config.server.cors,
      pingTimeout: 60000,
      pingInterval: 25000
    });

    // Exposer io pour les routes et services
    app.set('io', io);

    io.on('connection', (socket) => {
      const userId = socket.handshake.query.userId || 'anonymous';
      logger.info(`🔌 Socket connecté: ${socket.id} (User: ${userId})`);
      if (userId && userId !== 'anonymous') {
        socket.join(`user_${userId}`);
      }

      const resolveConversationId = (payload) => String(
        (typeof payload === 'string' || typeof payload === 'number')
          ? payload
          : (payload?.conversationId || payload?.conversation_id || payload?.id || '')
      );
      const resolveUserId = (payload) => String(payload?.userId || payload?.user_id || '');

      socket.on('join_user', (uid) => {
        if (!uid) return;
        socket.join(`user_${uid}`);
      });

      socket.on('join_conversation', (payload) => {
        const conversationId = resolveConversationId(payload);
        if (!conversationId) return;
        socket.join(`conversation_${conversationId}`);
      });

      socket.on('typing:start', (payload = {}) => {
        const conversationId = resolveConversationId(payload);
        const typingUserId = resolveUserId(payload);
        const username = payload?.username || null;
        if (!conversationId || !typingUserId) return;
        socket.to(`conversation_${conversationId}`).emit('typing:update', {
          conversation_id: conversationId,
          conversationId,
          user_id: String(typingUserId),
          userId: String(typingUserId),
          username: username || null,
          is_typing: true,
          isTyping: true
        });
      });

      socket.on('typing:stop', (payload = {}) => {
        const conversationId = resolveConversationId(payload);
        const typingUserId = resolveUserId(payload);
        const username = payload?.username || null;
        if (!conversationId || !typingUserId) return;
        socket.to(`conversation_${conversationId}`).emit('typing:update', {
          conversation_id: conversationId,
          conversationId,
          user_id: String(typingUserId),
          userId: String(typingUserId),
          username: username || null,
          is_typing: false,
          isTyping: false
        });
      });
      
      registerMiningHandlers(io, socket);

      socket.on('join_video_upload', (tweetId) => {
        socket.join(`video_upload_${tweetId}`);
        logger.info(`👤 User ${userId} a rejoint le salon video_upload_${tweetId}`);
      });

      socket.on('search:summary:start', async (payload = {}) => {
        const requestId = payload?.requestId || null;
        const query = typeof payload?.q === 'string' ? payload.q.trim() : '';
        const type = payload?.type || 'all';
        const users = Array.isArray(payload?.users) ? payload.users : [];
        const tweets = Array.isArray(payload?.tweets) ? payload.tweets : [];
        const hashtags = Array.isArray(payload?.hashtags) ? payload.hashtags : [];

        if (!query) {
          socket.emit('search:summary:error', {
            requestId,
            message: 'Le champ q est requis'
          });
          return;
        }

        try {
          const result = await streamSearchSummary({
            query,
            type,
            users,
            tweets,
            hashtags,
            onChunk: (text) => {
              socket.emit('search:summary:chunk', { requestId, text });
            },
            onStatus: (status) => {
              socket.emit('search:summary:status', { requestId, status });
            }
          });

          socket.emit('search:summary:done', {
            requestId,
            text: result.text || ''
          });
        } catch (error) {
          logger.error('❌ Erreur WS search:summary:start:', error);
          socket.emit('search:summary:error', {
            requestId,
            message: 'Erreur lors de la génération du résumé IA'
          });
        }
      });

      socket.on('disconnect', () => {
        logger.info(`🔌 Socket déconnecté: ${socket.id}`);
      });
    });

    // Démarrer le serveur
    const server = httpServer.listen(config.server.port, config.server.host, () => {
      logger.info(`🚀 Serveur démarré sur http://${config.server.host}:${config.server.port}`);
      logger.info(`🌍 Environnement: ${config.server.env}`);
      logger.info(`🗄️ Base de données: PostgreSQL sur ${config.database.host}:${config.database.port}`);
      logger.info(`📊 API Endpoints:`);
      logger.info(`   🔐 Auth: /api/auth`);
      logger.info(`   🐦 Tweets: /api/tweets`);
      logger.info(`   🔍 Recherche: /api/search`);
      logger.info(`   🔔 Notifications: /api/notifications`);
      logger.info(`   🧠 AI Recommendations: /api/ai-recommendations`);
      logger.info(`   🎯 Targeting: /api/targeting`);
      logger.info(`   🏥 Health: /api/health`);
      logger.info(`👤 Bot status: ${DISABLE_POLICIERCONGO ? '🚫 DÉSACTIVÉ' : '✅ ACTIVÉ'}`);
      logger.info('🤖 TwitNinfAI: ✅ ACTIVÉ');
    });

    try {
      const models = require('./models');
      await similarity.initialize(models);
      await videoRecommendationService.initialize(models);
      
      // Lier Socket.io au service vidéo
      const { videoService } = require('./services/videoService');
      videoService.setIo(io);
      
      logger.info('✅ Moteurs de recommandation prêts (Tweets + Vidéos)');

      // 🧠 Initialiser l'index sémantique global (100% JS / E5-Base)
      const semanticSimilarityService = require('./services/semanticSimilarityService');
      semanticSimilarityService.initialize().catch(err => {
        logger.error('❌ Erreur initialisation index sémantique:', err.message);
      });
    } catch (err) {
      logger.error('❌ Erreur initialisation recommandations:', err.message);
    }

    // Configurer les tâches cron
    setupCronJobs();

    // ⏰ Initialiser le scheduler PolicierCongo SANS run immédiat
    // Le cron */10 prendra le relais après le délai de grâce
    if (!DISABLE_POLICIERCONGO) {
      const policierCongoV3 = getPolicierCongoV3();
      if (policierCongoV3.config.enabled) {
        await policierCongoV3.initialize();
        logger.info('🧠 PolicierCongo V3 activé au démarrage; scheduler persistant prêt.');
      } else {
      const schedulerManager = require('./services/policiercongo/schedulerManager');
      schedulerManager.initOnStartup(3); // 3 min de grâce après démarrage
      }
    }

  // 🛑 Desactive au demarrage, execution uniquement via cron horaire
  // launchTwitNinfAIIfNeeded();

    // Gestion gracieuse de l'arrêt
    process.on('SIGTERM', async () => {
      logger.info('SIGTERM reçu, arrêt gracieux du serveur...');
      server.close(async () => {
        logger.info('Serveur arrêté');
        await getPolicierCongoV3().close();
        await closeConnection();
        redisClient.quit();
        process.exit(0);
      });
    });

    process.on('SIGINT', async () => {
      logger.info('SIGINT reçu, arrêt gracieux du serveur...');
      server.close(async () => {
        logger.info('Serveur arrêté');
        await getPolicierCongoV3().close();
        await closeConnection();
        redisClient.quit();
        process.exit(0);
      });
    });

    // Gestion des erreurs non capturées
    process.on('uncaughtException', (error) => {
      logger.error('Exception non capturée:', error);
      process.exit(1);
    });

    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Promesse rejetée non gérée:', reason);
      process.exit(1);
    });

  } catch (error) {
    logger.error('Erreur lors du démarrage du serveur:', error);
    process.exit(1);
  }
}

// Démarrer le serveur si ce fichier est exécuté directement
if (require.main === module) {
  startServer();
}

module.exports = app;
