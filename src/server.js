// ⚠️ CHARGEMENT DE L'ENVIRONNEMENT — DOIT RESTER LA TOUTE PREMIÈRE INSTRUCTION.
//
// `config/config.js` chargeait déjà dotenv, mais il n'est requis qu'à la ligne
// ~20 de ce fichier. Or `authMiddleware` (ligne suivante) et `miningSocket`
// entraînent le chargement de modules qui lisent `process.env` au moment de
// leur évaluation — `rustRecommenderClient`, `ctrTracker`. Ces modules
// voyaient donc un environnement VIDE et retenaient définitivement leurs
// valeurs de repli.
//
// Conséquences observées en production :
//   - `RUST_RECOMMENDER_URL` ignoré → repli figé sur 127.0.0.1:3002. Invisible
//     tant que le recommandeur tournait sur la même machine ; sur un second
//     serveur, tout le trafic bascule sur le classement JS en silence.
//   - `INTERNAL_SECRET` ignoré → le tracking CTR envoyait une clé vide et se
//     faisait refuser en 401 par le moteur Rust. C'est l'explication du
//     `ctr_samples` qui ne montait pas.
//
// Charger dotenv ici règle les deux d'un coup, quel que soit l'ordre des
// `require` en dessous.
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('dotenv').config();

const express = require('express');
const { Op } = require('sequelize');
const cors = require('cors');
const { authenticateToken, requireAdminRole } = require('./middleware/authMiddleware');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const morgan = require('morgan');
// `path` est déjà requis tout en haut, pour le chargement de dotenv.
const fs = require('fs');
const redis = require('redis');
const cron = require('node-cron');
const http = require('http');
const { Server } = require('socket.io');
const { registerMiningHandlers } = require('./sockets/miningSocket');

// Configuration pour désactiver PolicierCongo
const DISABLE_POLICIERCONGO = false; // Désactiver l'automatisation de PolicierCongo
// Permet d'isoler complètement PolicierCongo sur un nœud précis. En production,
// A garde la valeur par défaut (`true`) et B définit cette variable à `false`.
// Nginx épingle parallèlement toutes les routes PolicierCongo sur A ; ce garde-
// fou empêche aussi un accès direct à B d'initialiser le moteur ou ses providers.
const POLICIERCONGO_LOCAL_ENABLED = process.env.POLICIERCONGO_LOCAL_ENABLED !== 'false';

const config = require('./config/config');
// Rôle du process (web / worker / all) — pilote l'exécution des tâches de fond
// et des migrations quand l'API tourne sur plusieurs machines. Voir config/role.js.
const { role: nodeRole, isWorker, runMigrations, instanceId } = require('./config/role');
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
const gAuthRoutes = require('./routes/gAuthRoutes');
const tweetRoutes = require('./routes/tweetRoutes');
const searchRoutes = require('./routes/searchRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const userRoutes = require('./routes/userRoutes');
const messageRoutes = require('./routes/messageRoutes');
const storyRoutes = require('./routes/storyRoutes');
const moderationRoutes = require('./routes/moderationRoutes');
const recommendationRoutes = require('./routes/recommendationRoutes');
const behaviorRoutes = require('./routes/behaviorRoutes');
const monetizationRoutes = require('./routes/monetizationRoutes');
const trackingRoutes = require('./routes/trackingRoutes');
const virtualCurrencyRoutes = require('./routes/virtualCurrencyRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const newEconomyRoutes = require('./routes/newEconomyRoutes');
const userCurrencyRoutes = require('./routes/userCurrencyRoutes');
const casinoRoutes = require('./routes/casinoRoutes');
const tweetMonetizationRoutes = require('./routes/tweetMonetizationRoutes');
const eventRoutes = require('./routes/events');
const functionalEventRoutes = require('./routes/functionalEventRoutes');
const featureFlagRoutes = require('./routes/featureFlagRoutes');
const nfMapRoutes = require('./routes/nfMapRoutes');
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
const creatorIntelligenceRoutes = require('./routes/creatorIntelligenceRoutes');
const supportRoutes = require('./routes/supportRoutes');
const paidContentRoutes = require('./routes/paidContentRoutes');
const scheduledTweetRoutes = require('./routes/scheduledTweetRoutes');
const insightsRoutes = require('./routes/insightsRoutes');
const usernameMarketRoutes = require('./routes/usernameMarketRoutes');
const infrastructureInternalRoutes = require('./routes/infrastructureInternalRoutes');
const infrastructureAdminRoutes = require('./routes/infrastructureAdminRoutes');
const scheduledTweetService = require('./services/scheduledTweetService');
const creatorRadarService = require('./services/creatorRadarService');
const impersonationWatchService = require('./services/impersonationWatchService');
const profileViewService = require('./services/profileViewService');
const usernameMarketService = require('./services/usernameMarketService');

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
const { blockBannedIp, checkApiRequest, isTrustedFirstPartyClient } = require('./middleware/fraudMiddleware');
const transactionAuthorizationService = require('./services/transactionAuthorizationService');
const { requestContextMiddleware } = require('./services/transactionAuthorizationService');
const { requestReadRouting } = require('./database/requestReadRouting');

// Créer l'application Express
const app = express();

// ⚠️ SÉCURITÉ — Confiance au proxy inverse (Nginx) UNIQUEMENT.
// Avec `trust proxy = 1`, Express dérive req.ip du DERNIER hop de confiance
// (le X-Forwarded-For ajouté par Nginx), et ignore tout XFF supplémentaire
// injecté par le client. Sans cela, un attaquant pourrait usurper son IP via
// l'en-tête X-Forwarded-For et contourner le blocage d'IP, la réputation et
// le rate-limit. La valeur 1 = un seul proxy (Nginx) devant l'API.
app.set('trust proxy', 1);

// Sonde de vivacité volontairement indépendante des middlewares globaux et
// des services externes. L'autoscaler ne doit pas conclure qu'un process Node
// est mort simplement parce que PostgreSQL, Redis ou l'anti-fraude ralentit.
app.get('/api/health/live', (_req, res) => res.status(200).json({
  success: true,
  role: nodeRole,
  instance: instanceId,
  policiercongo_local: POLICIERCONGO_LOCAL_ENABLED,
}));

// Configuration Redis pour le cache
const redisClient = redis.createClient(config.redis);
redisClient.on('error', (err) => logger.error('Erreur Redis:', err));
redisClient.on('connect', () => logger.info('Connexion Redis établie'));
// node-redis v4 ne se connecte plus automatiquement à createClient() (contrairement
// à v3) : sans ce .connect(), ce client restait à l'état "closed" en permanence —
// /api/health rapportait "redis: disconnected" en continu, et tout code qui s'en
// servirait plus tard pour du cache aurait échoué avec "The client is closed".
redisClient.connect().catch((err) => logger.error('[redis] Connexion initiale échouée:', err.message));

// ── Rate limiting partagé entre instances ───────────────────────────────────
// `express-rate-limit` compte par défaut en mémoire du process. Avec plusieurs
// instances derrière le répartiteur, chacune tient son propre compteur : la
// limite réelle est multipliée par le nombre de nœuds, et une même IP change de
// compteur à chaque requête selon le nœud qui la reçoit. On déporte donc les
// compteurs dans Redis, qui est déjà partagé par tout le parc.
//
// Le repli mémoire n'est pas un détail de confort : si Redis est momentanément
// indisponible, on préfère un rate limit trop permissif à une API qui renvoie
// des 500 sur chaque requête.
let RedisRateLimitStore = null;
try {
  RedisRateLimitStore = require('rate-limit-redis').default || require('rate-limit-redis');
} catch (e) {
  logger.warn('[rate-limit] rate-limit-redis absent — compteurs en mémoire (par instance).');
}

const makeRateLimitStore = (prefix) => {
  if (!RedisRateLimitStore) return undefined; // → MemoryStore par défaut
  try {
    return new RedisRateLimitStore({
      prefix: `rl:${prefix}:`,
      // node-redis v4 : la lib n'accepte pas le client directement, elle veut
      // un émetteur de commandes brut.
      sendCommand: (...args) => redisClient.sendCommand(args)
    });
  } catch (error) {
    logger.warn(`[rate-limit] Store Redis indisponible pour "${prefix}": ${error.message}`);
    return undefined;
  }
};

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

// Limitation du taux de requêtes global — ne s'applique qu'au trafic hors
// application officielle (web, scripts, bots). Un client first-party
// authentifié (app mobile, desktop Windows) est exempté : c'est le moteur
// anti-fraude (Rust, cadence/comportement) qui le surveille désormais — voir
// `isTrustedFirstPartyClient` dans fraudMiddleware.js, avec les mêmes
// garde-fous (login/paiements toujours limités, JWT vérifié obligatoire).
// Avant ce changement, un usage normal de l'app (scroll, polling des badges,
// navigation) pouvait dépasser 1000 req/15min et recevait un 429 générique
// alors qu'aucune fraude n'était en cause.
const limiter = rateLimit({
  store: makeRateLimitStore('global'),
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // 1000 requêtes par fenêtre (trafic non first-party)
  // Le minage (app Windows) soumet un nonce à chaque bloc trouvé — en usage
  // normal ça peut aller bien au-delà de 1000/15min sans être un abus, donc
  // ces routes ont leur propre limite dédiée (voir miningLimiter) au lieu de
  // partager le quota global avec le reste de l'app.
  skip: (req) => req.path.startsWith('/new-economy/mining') || isTrustedFirstPartyClient(req),
  message: {
    success: false,
    message: 'Trop de requêtes. Réessayez plus tard.'
  }
});
app.use('/api/', limiter);

// Limitation dédiée au minage : plus permissive que le quota global, car un
// mineur actif (surtout GPU) peut légitimement soumettre beaucoup de blocs.
const miningLimiter = rateLimit({
  store: makeRateLimitStore('mining'),
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
  store: makeRateLimitStore('auth'),
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 tentatives par fenêtre (augmenté de 5 à 100)
  message: {
    success: false,
    message: 'Trop de tentatives de connexion. Réessayez plus tard.'
  }
});

app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

// Protection rate limit sur les routes de tweets (plus strict).
// Comme le limiteur global : hors app uniquement, le trafic first-party
// authentifié est laissé au moteur anti-fraude (vélocité API dédiée, voir
// `velocity_rules.rs`), calibré pour la cadence réelle de l'app (feed, likes,
// vues) plutôt que sur un compteur générique par route.
const tweetLimiter = rateLimit({
  store: makeRateLimitStore('tweets'),
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200, // 200 tweets par fenêtre (trafic non first-party)
  skip: (req) => isTrustedFirstPartyClient(req),
  message: {
    success: false,
    message: 'Trop de tweets. Réessayez plus tard.'
  }
});

app.use('/api/tweets', tweetLimiter);

// Protection rate limit sur les routes de recherche
const searchLimiter = rateLimit({
  store: makeRateLimitStore('search'),
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300, // 300 recherches par fenêtre (trafic non first-party)
  skip: (req) => isTrustedFirstPartyClient(req),
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
app.use(requestReadRouting);
// Capture a server-trusted, privacy-preserving context for every future wallet
// mutation. The central ledger can then authorize calls without trusting route
// bodies or requiring every controller to forward IP/device identifiers.
app.use(requestContextMiddleware);

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
// Canal prive A <-> B : secret interne obligatoire et aucune donnee utilisateur.
// Il passe avant l'anti-fraude pour ne pas polluer ses compteurs.
// /api/health ne contient aucune donnee utilisateur. Les deploiements et
// l'autoscaler doivent pouvoir la sonder meme si leur IP est classee fraude.
const exceptHealth = (middleware) => (req, res, next) => (
  req.path === '/health' || req.path === '/health/live' ? next() : middleware(req, res, next)
);

app.use('/api/internal/infrastructure', infrastructureInternalRoutes);

app.use('/api', exceptHealth(globalBanCheck));

// ── Fraude : blocage instantané des IPs blacklistées (O(1) Redis GET) ────────
app.use('/api', exceptHealth(blockBannedIp));

// ── Fraude : analyse asynchrone de chaque requête API (background, non-bloquant)
app.use('/api', exceptHealth(checkApiRequest));

// Documents contractuels, hors /api : accessibles sans compte ni jeton, car il
// faut pouvoir les lire AVANT d'accepter quoi que ce soit.
app.use('/legal', require('./routes/legalRoutes'));

// Routes API - Version complète avec toutes les fonctionnalités
//
// gAuthRoutes DOIT être monté avant authRoutes : Express matche les préfixes
// dans l'ordre d'enregistrement, et `/api/auth/g-auth/start` correspond au
// préfixe `/api/auth` d'authRoutes. Dans l'autre ordre, la requête ne sort
// jamais d'authRoutes — elle tombe sur son `router.use(authenticateToken, …)`
// générique (ligne ~290) et rend 401 avant d'atteindre ce routeur, alors que
// /start et /callback doivent rester publics (un navigateur frais, sans
// session, y arrive par construction).
app.use('/api/auth/g-auth', gAuthRoutes);
app.use('/api/auth', authRoutes);

app.use('/api/tweets', tweetRoutes);

app.use('/api/search', searchRoutes);

app.use('/api/notifications', notificationRoutes);

app.use('/api/users', userRoutes);

app.use('/api/messages', messageRoutes);

app.use('/api/stories', storyRoutes);

app.use('/api/moderation', moderationRoutes);

// Modération communautaire (BÊTA) — pour l'instant consommée par la seule app Windows.
app.use('/api/community-moderation', require('./routes/communityModerationRoutes'));

app.use('/api/recommendations', recommendationRoutes);

app.use('/api/behavior', behaviorRoutes);

app.use('/api/monetization', monetizationRoutes);

app.use('/api/virtual-currency', virtualCurrencyRoutes);

app.use('/api/payments', paymentRoutes);

app.use('/api/new-economy', newEconomyRoutes);

app.use('/api/currencies', userCurrencyRoutes);

app.use('/api/casino', casinoRoutes);

app.use('/api/tweet-monetization', tweetMonetizationRoutes);

app.use('/api/events', eventRoutes);

app.use('/api/functional-events', functionalEventRoutes);

// Drapeaux de fonctionnalité — déploiement progressif et ciblage par attributs
app.use('/api/feature-flags', featureFlagRoutes);

// Carte NF — présence partagée, entièrement sous drapeau `fil.cartenf`
app.use('/api/nf-map', nfMapRoutes);

app.use('/api/theme-presets', themePresetRoutes);

app.use('/api/progressive-recommendations', progressiveRecommendationRoutes);

// NeuralRank Fusion — moteur Rust haute performance
app.use('/api/neural-rank', neuralRankRoutes);

// Wallet et Premium
app.use('/api/wallet', walletRoutes);
app.use('/api/premium', premiumRoutes);

// 📊 CTR Tracking pour l'algorithme Rust
app.use('/api/track', trackingRoutes);

app.use('/api/user-stats', userStatsRoutes);

// Générateur à crédits (Plus/Pro), analytics prédictifs, co-pilote et radar (Pro)
app.use('/api/creator-intelligence', creatorIntelligenceRoutes);

// Support par ticket (traitement prioritaire pour le palier Pro)
app.use('/api/support', supportRoutes);

// Offre créateur : contenu à l'unité, file de publication, renseignements
// (visiteurs, usurpation, radar, décollage) et marché des pseudos.
app.use('/api/paid-content', paidContentRoutes);
app.use('/api/scheduled-tweets', scheduledTweetRoutes);
app.use('/api/insights', insightsRoutes);
app.use('/api/username-market', usernameMarketRoutes);

app.use('/api/verification', verificationRoutes);

// Routes publicitaires
app.use('/api/ads', adRoutes);

// Routes des défis d'utilisateur
app.use('/api/user-challenges', userChallengeRoutes);

// Routes des badges vérifiés
app.use('/api/verified-badges', verifiedBadgeRoutes);

// Routes des styles de vérification
app.use('/api/verification-style', verificationStyleRoutes);

// Routes de l'inventaire
app.use('/api/inventory', inventoryRoutes);

// 🧠 Routes de recommandation IA (Deep Learning)
app.use('/api/ai-recommendations', aiRecommendationRoutes);

// 🛡️ Routes d'administration de l'économie
app.use('/api/admin/economy', economyAdminRoutes);

app.use('/api/admin/similarity', similarityAdminRoutes);
app.use('/api/admin/shadowban', shadowbanAdminRoutes);
app.use('/api/admin/infrastructure', infrastructureAdminRoutes);

// PolicierCongo vit exclusivement sur A. Les routes publiques sont épinglées
// sur A dans nginx ; si quelqu'un contourne le proxy et appelle B directement,
// on refuse avant que le routeur V1/V2/V3 puisse initialiser le moteur.
app.use([
  '/api/admin/policiercongo',
  '/api/policiercongo',
  '/api/debug/policiercongo'
], (req, res, next) => {
  if (POLICIERCONGO_LOCAL_ENABLED) return next();
  return res.status(503).json({
    success: false,
    message: 'PolicierCongo est exécuté sur le nœud principal.'
  });
});

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
app.post('/api/policiercongo/analyze', authenticateToken, requireAdminRole, async (req, res) => {
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

// Endpoint de diagnostic du scheduler (administrateurs uniquement)
app.get('/api/debug/policiercongo/scheduler', authenticateToken, requireAdminRole, async (req, res) => {
  try {
    const schedulerManager = require('./services/policiercongo/schedulerManager');
    await schedulerManager.load();
    const nextRun = schedulerManager.nextRunTime;
    const now = new Date();
    const isReady = await schedulerManager.isTimeForRun();
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
app.get('/api/admin/policiercongo/scheduler', authenticateToken, requireAdminRole, async (req, res) => {
  try {
    const schedulerManager = require('./services/policiercongo/schedulerManager');
    await schedulerManager.load();
    const nextRun = schedulerManager.nextRunTime;
    const now = new Date();
    const isReady = await schedulerManager.isTimeForRun();
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
app.delete('/api/admin/policiercongo/scheduler', authenticateToken, requireAdminRole, async (req, res) => {
  try {
    const schedulerManager = require('./services/policiercongo/schedulerManager');
    await schedulerManager.reset();
    res.json({ success: true, message: 'Scheduler réinitialisé' });
  } catch (error) {
    logger.error('❌ Erreur route directe scheduler DELETE:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Endpoint pour forcer une exécution immédiate (Direct avec Auth)
app.post('/api/admin/policiercongo/scheduler/run', authenticateToken, requireAdminRole, async (req, res) => {
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
app.get('/api/policiercongo/status', authenticateToken, requireAdminRole, async (req, res) => {
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
app.post('/api/policiercongo/reset-memory', authenticateToken, requireAdminRole, async (req, res) => {
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
    // node-redis v4 expose `.isReady` (et `.isOpen`), pas `.ready` (qui
    // n'existe pas sur ce client et vaut donc toujours `undefined`) : ce
    // endpoint rapportait "disconnected" en permanence même quand la
    // connexion fonctionnait réellement.
    const redisStatus = redisClient.isReady ? 'connected' : 'disconnected';
    
    res.status(200).json({
      success: true,
      message: 'API wtitninf opérationnelle',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: config.server.env,
      // Rôle et identité du process : derrière le répartiteur de charge, c'est
      // le seul moyen de savoir QUI a répondu. Le script de déploiement s'en
      // sert pour valider chaque hôte individuellement, et un `role: worker`
      // qui apparaîtrait sur deux nœuds signale une erreur de configuration.
      role: nodeRole,
      instance: instanceId,
      policiercongo_local: POLICIERCONGO_LOCAL_ENABLED,
      database: dbStatus ? 'connected' : 'disconnected',
      orm_read_replica: config.database.replication
        ? { configured: true, host: process.env.DB_ORM_READ_HOST, mode: 'get_head_only' }
        : { configured: false },
      // État de la réplique de lecture : `configured: false` = mono-serveur,
      // `reachable: false` = réplique déclarée mais injoignable (le service
      // tourne quand même, replié sur le primaire, mais il faut le savoir).
      // `lag_seconds` est le retard de réplication réel.
      read_replica: await require('./database/readReplica').checkRead(),
      // Cache de feed partagé : `hit_rate` est la seule façon de vérifier qu'il
      // sert vraiment, au lieu de le supposer. Les compteurs sont propres au
      // process, donc à lire nœud par nœud.
      feed_cache: require('./services/feedCache').getStats(),
      redis: redisStatus,
      transaction_authorization: fraudService.isReady() ? 'ready' : 'fail_closed',
      memory: process.memoryUsage(),
      version: require('../package.json').version,
      features: {
        tweets: true,
        search: true,
        notifications: true,
        likes: true,
        retweets: true,
        user_follows: true,
        // `getAIBridge` n'était pas importé dans ce fichier : /api/health levait
        // une ReferenceError et répondait 503 en permanence, ce qui masquait
        // l'état réel du service.
        ai_recommendations: require('./services/aiRecommendationBridge').getAIBridge().ready
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
  /**
   * Carte NF : effacement des positions expirées, tous les quarts d'heure.
   *
   * La requête de lecture filtre déjà sur `expires_at`, donc rien de périmé
   * n'est jamais montré. Cette purge sert à autre chose : à ce que la position
   * ne RESTE PAS en base une fois passée. Sans elle, la table deviendrait
   * l'historique des déplacements de ceux qui ont activé le partage — ce que
   * personne n'a accepté en l'activant.
   */
  cron.schedule('*/15 * * * *', async () => {
    try {
      const cleared = await require('./services/nfMapService').purgeExpired(sequelize);
      if (cleared > 0) logger.info(`[nfMap] ${cleared} position(s) expirée(s) effacée(s)`);
    } catch (error) {
      logger.error('[nfMap] purge des positions impossible:', error.message);
    }
  });

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
      
      // `sequelize.Op` n'existe pas en Sequelize v6 (retiré, il faut importer
      // `Op` du package) — combiné à la double instance Sequelize corrigée
      // dans database/index.js, ce cron plantait silencieusement chaque nuit
      // depuis le début : les notifications lues de plus de 30 jours ne
      // s'étaient jamais purgées, gonflant la table `notifications` pour rien.
      const deletedCount = await sequelize.models.Notification.destroy({
        where: {
          created_at: { [Op.lt]: thirtyDaysAgo },
          is_read: true
        }
      });
      
      logger.info(`${deletedCount} notifications anciennes supprimées`);
    } catch (error) {
      logger.error('Erreur lors du nettoyage des notifications:', error);
    }
  });

  // Purge des stories expirées + de leurs fichiers médias (toutes les heures)
  cron.schedule('20 * * * *', async () => {
    try {
      await storyRoutes.purgeExpiredStories();
    } catch (error) {
      logger.error('Erreur lors de la purge des stories:', error);
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

  // Fin des abonnements échus (toutes les heures, à la demie)
  //
  // L'expiration paresseuse ne se déclenche que si l'abonné revient sur une
  // route qui la vérifie : sans ce balayage, un compte échu garde son badge et
  // ses avantages d'affichage pour tous les autres utilisateurs.
  cron.schedule('30 * * * *', async () => {
    try {
      const { expireDueSubscriptions } = require('./utils/subscriptionHelpers');
      const { expired, cleaned } = await expireDueSubscriptions(sequelize);
      if (expired > 0) {
        logger.info(`⏳ [Cron] ${expired} abonnement(s) échu(s) repassé(s) en gratuit`);
      }
      if (cleaned > 0) {
        logger.info(`🧹 [Cron] ${cleaned} habillage(s) payant(s) retiré(s) d'un compte gratuit`);
      }
    } catch (error) {
      logger.error('❌ [Cron] Erreur expiration des abonnements:', error);
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
      if (!(await schedulerManager.isTimeForRun())) {
        // Pas encore l'heure, on log discrètement et on skip
        return;
      }

      // Verrou atomique partagé : si un autre process a déjà pris le cycle,
      // on s'arrête ici plutôt que de lancer une analyse en double.
      if (!(await schedulerManager.tryStartRun())) {
        return;
      }

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
    if (!(await schedulerManager.isTimeForRun())) {
      logger.info('⏰ PolicierCongo : Pas encore l\'heure du run (planification respectée).');
      return;
    }

    // NOUVEAU : On marque immédiatement le début du run pour éviter les lancements multiples
    // durant le temps de calcul de l'IA — verrou partagé entre instances.
    if (!(await schedulerManager.tryStartRun())) {
      logger.info('🔒 PolicierCongo : cycle déjà pris par une autre instance.');
      return;
    }

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

    // Synchronisation du schéma et migrations : réservées au worker.
    //
    // Avec plusieurs instances, laisser chaque process jouer `sync()` puis
    // `runAutoMigration()` au démarrage les fait se marcher dessus sur les
    // mêmes ALTER TABLE — au mieux des erreurs au boot, au pire un schéma à
    // moitié migré. Un seul process est responsable du schéma ; les instances
    // web se contentent de le consommer. `RUN_MIGRATIONS=1` permet de forcer
    // ponctuellement le passage sur un autre nœud.
    if (runMigrations) {
      await syncDatabase();
      await runAutoMigration();
    } else {
      logger.info(`⏭️ [role=${nodeRole}] Migrations ignorées (réservées au worker).`);
    }

    // Crée le registre durable avant d'accepter le moindre achat ou mouvement
    // de valeur. Si cette étape échoue, l'API ne démarre pas en mode fail-open.
    await transactionAuthorizationService.initialize();

    // 📊 Données comportementales : migration au worker, préchauffage au worker.
    //
    // Ces deux appels ne sont pas du même ordre malgré leur voisinage.
    //
    // `behaviorDataMigration` crée des tables, migre des lignes, écrit les
    // préférences par défaut de tous les utilisateurs et purge l'ancien. C'est
    // une migration, au même titre que `syncDatabase()` vingt lignes plus haut,
    // et elle tombe donc sous la même règle : un seul process la joue. La
    // laisser sur chaque instance web faisait converger N processus sur les
    // mêmes CREATE TABLE et les mêmes écritures au démarrage.
    //
    // `behaviorDataLoader` ne fait qu'amorcer un cache : stats globales, puis
    // les profils des 100 utilisateurs les plus actifs chargés en parallèle.
    // Rien ici n'est nécessaire pour servir une requête — `loadUserBehaviorProfile`
    // recharge à la demande avec son propre TTL, et c'est le seul chemin qu'emprunte
    // le moteur de recommandation. Sur un C créé pendant une pointe, ce
    // préchauffage ouvrait une centaine de requêtes sur un primaire déjà saturé,
    // et retardait d'autant le moment où le C commençait enfin à soulager A.
    // On garde donc le préchauffage sur le worker, et le chargement paresseux
    // partout ailleurs.
    if (runMigrations) {
      logger.info('📊 Initialisation des données comportementales...');
      try {
        await behaviorDataMigration.initializeOnStartup();
        await behaviorDataLoader.initializeOnStartup();
        logger.info('✅ Données comportementales initialisées avec succès');
      } catch (error) {
        logger.error('❌ Erreur initialisation données comportementales:', error);
        // Ne pas arrêter le serveur, les données comportementales ne sont pas critiques
      }
    } else {
      logger.info(`⏭️ [role=${nodeRole}] Données comportementales non préchargées (réservées au worker, chargement à la demande).`);
    }

    // 💰 Amorçage de la cryptomonnaie virtuelle — worker uniquement.
    //
    // Malgré son nom d'initialisation, c'est un script de seed : il crée la
    // devise NF si elle manque, puis parcourt **toute** la table `users` pour
    // créer les portefeuilles absents. Le coût grandit avec le nombre de
    // comptes et ne dépend en rien du trafic ; le rejouer sur chaque instance
    // web et sur chaque C revenait à balayer les utilisateurs autant de fois
    // qu'il y a de process, en concurrence sur les mêmes insertions.
    //
    // Aucun utilisateur ne se retrouve sans portefeuille pour autant : les deux
    // chemins qui en lisent un le créent à la volée quand il manque
    // (`virtualCurrencyController`, `premiumRoutes`). Le seed ne fait que
    // rattraper l'existant en masse, ce qui est bien le travail du worker.
    if (runMigrations) {
      logger.info('💰 Initialisation du système de cryptomonnaie virtuelle...');
      try {
        await initVirtualCurrency();
        logger.info('✅ Système de cryptomonnaie virtuelle initialisé avec succès');
      } catch (error) {
        logger.error('❌ Erreur initialisation cryptomonnaie:', error);
        // Ne pas arrêter le serveur, la cryptomonnaie n'est pas critique
      }
    } else {
      logger.info(`⏭️ [role=${nodeRole}] Amorçage cryptomonnaie ignoré (réservé au worker).`);
    }

    // ⏱ Tâches de fond de l'offre créateur.
    //
    // Trois rythmes différents, et c'est voulu : une publication programmée se
    // vérifie souvent (30 s), un décollage de tweet toutes les 5 minutes, une
    // veille usurpation une fois par heure — elle balaie tous les abonnés et
    // ne détecterait rien de plus en tournant vingt fois plus.
    //
    // Aucune n'est critique : un échec est journalisé, jamais fatal. Un
    // serveur qui refuse de démarrer parce qu'un scan de ressemblance a
    // échoué serait une très mauvaise affaire.
    //
    // Réservées au worker : ce sont des tâches périodiques, pas du service de
    // requêtes. Les faire tourner sur chaque instance web reviendrait à scanner
    // les abonnés et purger les vues autant de fois qu'il y a de nœuds.
    if (!isWorker) {
      logger.info(`⏭️ [role=${nodeRole}] Tâches de fond créateur non démarrées (réservées au worker).`);
    } else {
    try {
      scheduledTweetService.startWorker();
      creatorRadarService.startVelocityWorker();

      /**
       * Premier passage peu après le démarrage, puis à l'intervalle.
       *
       * `setInterval` seul ne déclenche RIEN avant la fin d'une période
       * entière. Sur un process redémarré souvent (déploiements, `pm2
       * restart`), une tâche horaire ne tourne qu'une fois sur deux et une
       * tâche quotidienne ne tourne jamais : chaque redémarrage remet le
       * compteur à zéro. Les alertes d'usurpation et le ménage de rétention
       * étaient dans ce cas.
       *
       * Le délai de départ laisse la base et les modèles s'initialiser sans
       * concurrencer les premières requêtes.
       */
      const runNowThenEvery = (label, intervalMs, task, startupDelayMs = 45 * 1000) => {
        const runSafely = () => {
          Promise.resolve()
            .then(task)
            .catch((e) => logger.warn(`[${label}] Passage en échec:`, e.message));
        };
        const kickoff = setTimeout(runSafely, startupDelayMs);
        if (typeof kickoff.unref === 'function') kickoff.unref();
        const timer = setInterval(runSafely, intervalMs);
        if (typeof timer.unref === 'function') timer.unref();
        return timer;
      };

      runNowThenEvery(
        'impersonation',
        60 * 60 * 1000,
        () => impersonationWatchService.scanAllSubscribers(),
      );

      // Ménage quotidien : rétention des visites de profil, réservations de
      // pseudo expirées. Sans lui, `profile_views` grossit indéfiniment pour
      // afficher sept jours, et un pseudo réservé le reste pour toujours.
      runNowThenEvery('housekeeping', 24 * 60 * 60 * 1000, async () => {
        await profileViewService.purgeOld()
          .catch((e) => logger.warn('[profileViews] Purge en échec:', e.message));
        await usernameMarketService.releaseExpired()
          .catch((e) => logger.warn('[usernameMarket] Libération en échec:', e.message));
      }, 90 * 1000);

      logger.info('✅ Tâches de fond de l\'offre créateur démarrées');
    } catch (error) {
      logger.error('❌ Erreur démarrage des tâches de fond créateur:', error);
    }
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

    // ── Socket.io multi-instances ────────────────────────────────────────────
    // Sans adaptateur, chaque instance ne connaît que ses propres sockets : un
    // `io.to('user_42').emit(...)` déclenché sur le nœud B n'atteint jamais un
    // client connecté au nœud A, et `fetchSockets()` (salons de minage) ne voit
    // qu'une fraction des participants. L'adaptateur Redis fait transiter les
    // diffusions par le Redis déjà partagé, ce qui rend les salons globaux.
    //
    // On duplique le client : node-redis interdit d'utiliser une connexion en
    // mode abonnement pour autre chose, donc l'adaptateur ne peut pas partager
    // le client de cache.
    try {
      const { createAdapter } = require('@socket.io/redis-adapter');
      const pubClient = redisClient.duplicate();
      const subClient = redisClient.duplicate();
      pubClient.on('error', (err) => logger.error('[socket.io/redis pub]', err.message));
      subClient.on('error', (err) => logger.error('[socket.io/redis sub]', err.message));
      await Promise.all([pubClient.connect(), subClient.connect()]);
      io.adapter(createAdapter(pubClient, subClient));
      logger.info('✅ Socket.io : adaptateur Redis actif (diffusion inter-instances)');
    } catch (error) {
      // Volontairement non fatal : en mono-serveur, l'adaptateur par défaut
      // suffit et l'API doit démarrer même si le paquet n'est pas installé.
      logger.warn(
        `⚠️ Socket.io : adaptateur Redis indisponible (${error.message}) — diffusion limitée à cette instance.`
      );
    }

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

      // 📡 Radar de tendances (avantage Pro) — départ différé, il partage le
      // modèle d'embeddings avec l'index sémantique ci-dessus.
      // Planificateur périodique : worker uniquement (voir config/role.js).
      if (isWorker) {
        require('./services/trendRadarService').startScheduler();
      }
    } catch (err) {
      logger.error('❌ Erreur initialisation recommandations:', err.message);
    }

    // Configurer les tâches cron — worker uniquement.
    //
    // C'est le point le plus important du découpage : ces crons publient des
    // tweets, lancent PolicierCongo et TwitNinfAI, purgent des tables. Sur N
    // instances, chaque tâche s'exécuterait N fois — un auto-tweet horaire
    // deviendrait N tweets par heure. Un seul process porte NODE_ROLE=worker,
    // donc PolicierCongo ne tourne qu'en un exemplaire par construction.
    if (isWorker) {
      setupCronJobs();
      // Montée automatique des paliers de déploiement, pour la même raison :
      // sur deux instances, un drapeau armé monterait de deux crans par
      // intervalle au lieu d'un.
      require('./services/featureFlagAutoRollout').startScheduler();
    } else {
      logger.info(`⏭️ [role=${nodeRole}] Tâches cron non planifiées (réservées au worker).`);
    }

    // ⏰ Initialiser le scheduler PolicierCongo SANS run immédiat
    // Le cron */10 prendra le relais après le délai de grâce
    if (!DISABLE_POLICIERCONGO && POLICIERCONGO_LOCAL_ENABLED) {
      const policierCongoV3 = getPolicierCongoV3();
      if (policierCongoV3.config.enabled) {
        // Le moteur et ses routes ne sont initialisés que sur A. La boucle de
        // réveil persistante reste en plus réservée au process worker.
        await policierCongoV3.initialize();
        logger.info(`🧠 PolicierCongo V3 activé au démarrage (role=${nodeRole}).`);
      } else if (isWorker) {
        const schedulerManager = require('./services/policiercongo/schedulerManager');
        await schedulerManager.initOnStartup(3); // 3 min de grâce après démarrage
      }
    } else if (!POLICIERCONGO_LOCAL_ENABLED) {
      logger.info(`⏭️ [role=${nodeRole}] PolicierCongo non initialisé sur ce nœud.`);
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
        await require('./database/readReplica').closeRead();
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
        await require('./database/readReplica').closeRead();
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
