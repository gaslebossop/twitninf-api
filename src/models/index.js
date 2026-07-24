const { Sequelize } = require('sequelize');
const config = require('../config/config');
const logger = require('../utils/logger');

// Import des modèles
const User = require('./User');
const Tweet = require('./Tweet');
const TweetLike = require('./TweetLike');
const TweetRetweet = require('./TweetRetweet');
const Notification = require('./Notification');
const UserFollow = require('./UserFollow');
const Report = require('./Report');
const FeedHashtagRuleModule = require('./FeedHashtagRule');
const ModerationAction = require('./ModerationAction');
const UserBehaviorData = require('./UserBehaviorData');
const UserPreferences = require('./UserPreferences');
const MonetizationMetrics = require('./MonetizationMetrics');
const VirtualCurrency = require('./VirtualCurrency');
const UserWallet = require('./UserWallet');
const Transaction = require('./Transaction');
const Event = require('./Event');
const FunctionalEvent = require('./FunctionalEvent');
const VerificationRequest = require('./VerificationRequest');
const Advertisement = require('./Advertisement');
const AdCampaign = require('./AdCampaign');
const AdImpression = require('./AdImpression');
const AdClick = require('./AdClick');
const AdEngagement = require('./AdEngagement');
const UserChallenge = require('./UserChallenge');
const DeveloperAppModule = require('./DeveloperApp');
const OAuthCodeModule = require('./OAuthCode');
const OAuthTokenModule = require('./OAuthToken');
const BotReputation = require('./BotReputation');
const Conversation = require('./Conversation');
const ConversationParticipant = require('./ConversationParticipant');
const Message = require('./Message');
const UnbanTicketModule = require('./UnbanTicket');
const PolicierCongoContract = require('./PolicierCongoContract');
const MiningRound = require('./MiningRound');
const CasinoBet = require('./CasinoBet');

// Créer l'instance Sequelize
const sequelize = new Sequelize(config.database);

// Initialiser tous les modèles
User.initUserModel(sequelize);
Tweet.initTweetModel(sequelize);
TweetLike.initTweetLikeModel(sequelize);
TweetRetweet.initTweetRetweetModel(sequelize);
Notification.initNotificationModel(sequelize);
UserFollow.initUserFollowModel(sequelize);

// Initialiser les nouveaux modèles comportementaux
UserBehaviorData.initUserBehaviorDataModel(sequelize);
UserPreferences.initUserPreferencesModel(sequelize);

// Initialiser le modèle de monétisation
MonetizationMetrics.initMonetizationMetricsModel(sequelize);

// Initialiser les modèles de cryptomonnaie virtuelle
const VirtualCurrencyModel = VirtualCurrency.initVirtualCurrencyModel(sequelize);
const PolicierCongoContractModel = PolicierCongoContract.initPolicierCongoContractModel(sequelize);
const MiningRoundModel = MiningRound.initMiningRoundModel(sequelize);
const CasinoBetModel = CasinoBet.initCasinoBetModel(sequelize);
const UserWalletModel = UserWallet.initUserWalletModel(sequelize);
const TransactionModel = Transaction.initTransactionModel(sequelize);

// Initialiser les modèles de modération
const ReportModel = Report(sequelize);
const FeedHashtagRuleModel = FeedHashtagRuleModule(sequelize);
const ModerationActionModel = ModerationAction(sequelize);

// Initialiser le modèle de vérification
const VerificationRequestModel = VerificationRequest(sequelize);

// Initialiser le modèle d'événements
const EventModel = Event(sequelize);
const FunctionalEventModel = FunctionalEvent(sequelize);

// Initialiser les modèles publicitaires
const AdvertisementModel = Advertisement(sequelize);
const AdCampaignModel = AdCampaign(sequelize);
const AdImpressionModel = AdImpression(sequelize);
const AdClickModel = AdClick(sequelize);
const AdEngagementModel = AdEngagement(sequelize);
const UserChallengeModel = UserChallenge(sequelize);
const DeveloperApp = DeveloperAppModule(sequelize);
const OAuthCode = OAuthCodeModule(sequelize);
const OAuthToken = OAuthTokenModule(sequelize);
BotReputation.initBotReputationModel(sequelize);
Conversation.initConversationModel(sequelize);
ConversationParticipant.initConversationParticipantModel(sequelize);
Message.initMessageModel(sequelize);
const UnbanTicketModel = UnbanTicketModule(sequelize);

// Définir les associations entre les modèles

// Associations User
User.hasMany(Tweet, { 
  foreignKey: 'user_id', 
  as: 'tweets',
  onDelete: 'CASCADE'
});

User.hasMany(TweetLike, { 
  foreignKey: 'user_id', 
  as: 'likes',
  onDelete: 'CASCADE'
});

User.hasMany(TweetRetweet, { 
  foreignKey: 'user_id', 
  as: 'retweets',
  onDelete: 'CASCADE'
});

User.hasMany(Notification, { 
  foreignKey: 'recipient_id', 
  as: 'receivedNotifications',
  onDelete: 'CASCADE'
});

User.hasMany(Notification, { 
  foreignKey: 'sender_id', 
  as: 'sentNotifications',
  onDelete: 'SET NULL'
});

// Associations Tweet
Tweet.belongsTo(User, { 
  foreignKey: 'user_id', 
  as: 'author'
});

Tweet.hasMany(TweetLike, { 
  foreignKey: 'tweet_id', 
  as: 'likes',
  onDelete: 'CASCADE'
});

Tweet.hasMany(TweetRetweet, { 
  foreignKey: 'tweet_id', 
  as: 'retweets',
  onDelete: 'CASCADE'
});

Tweet.hasMany(Notification, { 
  foreignKey: 'tweet_id', 
  as: 'notifications',
  onDelete: 'CASCADE'
});

// Auto-référence pour les réponses
Tweet.belongsTo(Tweet, { 
  foreignKey: 'parent_tweet_id', 
  as: 'parentTweet'
});

Tweet.hasMany(Tweet, { 
  foreignKey: 'parent_tweet_id', 
  as: 'replies'
});

// Auto-référence pour les retweets
Tweet.belongsTo(Tweet, { 
  foreignKey: 'original_tweet_id', 
  as: 'originalTweet'
});

Tweet.hasMany(Tweet, { 
  foreignKey: 'original_tweet_id', 
  as: 'retweetedTweets'
});

// Associations pour les signalements
ReportModel.belongsTo(User, { 
  foreignKey: 'reporter_id', 
  as: 'reporter'
});

ReportModel.belongsTo(User, { 
  foreignKey: 'resolved_by', 
  as: 'resolver'
});

// Associations pour les actions de modération
ModerationActionModel.belongsTo(User, { 
  foreignKey: 'moderator_id', 
  as: 'moderator'
});



// Associations TweetLike
TweetLike.belongsTo(User, { 
  foreignKey: 'user_id', 
  as: 'user'
});

TweetLike.belongsTo(Tweet, { 
  foreignKey: 'tweet_id', 
  as: 'tweet'
});

// Associations TweetRetweet
TweetRetweet.belongsTo(User, { 
  foreignKey: 'user_id', 
  as: 'user'
});

TweetRetweet.belongsTo(Tweet, { 
  foreignKey: 'tweet_id', 
  as: 'tweet'
});

// Associations Notification
Notification.belongsTo(User, { 
  foreignKey: 'recipient_id', 
  as: 'recipient'
});

Notification.belongsTo(User, { 
  foreignKey: 'sender_id', 
  as: 'sender'
});

Notification.belongsTo(Tweet, { 
  foreignKey: 'tweet_id', 
  as: 'tweet'
});

Notification.belongsTo(Tweet, { 
  foreignKey: 'original_tweet_id', 
  as: 'originalTweet'
});

// Associations UserFollow
UserFollow.belongsTo(User, { 
  foreignKey: 'follower_id', 
  as: 'follower'
});

UserFollow.belongsTo(User, { 
  foreignKey: 'following_id', 
  as: 'following'
});

// Auto-référence pour les followers
User.hasMany(UserFollow, { 
  foreignKey: 'follower_id', 
  as: 'following',
  onDelete: 'CASCADE'
});

User.hasMany(UserFollow, { 
  foreignKey: 'following_id', 
  as: 'followers',
  onDelete: 'CASCADE'
});

// Associations MonetizationMetrics
MonetizationMetrics.belongsTo(Tweet, { 
  foreignKey: 'tweet_id', 
  as: 'tweet',
  onDelete: 'CASCADE'
});

Tweet.hasOne(MonetizationMetrics, { 
  foreignKey: 'tweet_id', 
  as: 'monetizationMetrics'
});

// Associations pour la modération
User.hasMany(ReportModel, { 
  foreignKey: 'reporter_id', 
  as: 'reports',
  onDelete: 'CASCADE'
});

User.hasMany(ModerationActionModel, { 
  foreignKey: 'moderator_id', 
  as: 'moderationActions',
  onDelete: 'CASCADE'
});

// Associations pour les données comportementales
User.hasMany(UserBehaviorData, {
  foreignKey: 'user_id',
  as: 'behaviorData',
  onDelete: 'CASCADE'
});

User.hasOne(UserPreferences, {
  foreignKey: 'user_id',
  as: 'userPreferences',
  onDelete: 'CASCADE'
});

// Associations inverses
UserBehaviorData.belongsTo(User, {
  foreignKey: 'user_id',
  as: 'user'
});

UserPreferences.belongsTo(User, {
  foreignKey: 'user_id',
  as: 'user'
});

// Associations pour la réputation de bot
User.hasOne(BotReputation, {
  foreignKey: 'user_id',
  as: 'botReputation',
  onDelete: 'CASCADE'
});

BotReputation.belongsTo(User, {
  foreignKey: 'user_id',
  as: 'user'
});

// Associations pour la cryptomonnaie virtuelle
User.hasMany(UserWalletModel, { 
  foreignKey: 'userId', 
  as: 'wallets',
  onDelete: 'CASCADE'
});

UserWalletModel.belongsTo(User, { 
  foreignKey: 'userId', 
  as: 'user'
});

VirtualCurrencyModel.hasMany(UserWalletModel, { 
  foreignKey: 'currencyId', 
  as: 'wallets'
});

UserWalletModel.belongsTo(VirtualCurrencyModel, { 
  foreignKey: 'currencyId', 
  as: 'currency'
});

VirtualCurrencyModel.hasMany(TransactionModel, { 
  foreignKey: 'currencyId', 
  as: 'transactions'
});

TransactionModel.belongsTo(VirtualCurrencyModel, { 
  foreignKey: 'currencyId', 
  as: 'currency'
});

User.hasMany(TransactionModel, { 
  foreignKey: 'fromUserId', 
  as: 'sentTransactions',
  onDelete: 'SET NULL'
});

User.hasMany(TransactionModel, { 
  foreignKey: 'toUserId', 
  as: 'receivedTransactions',
  onDelete: 'CASCADE'
});

TransactionModel.belongsTo(User, { 
  foreignKey: 'fromUserId', 
  as: 'fromUser'
});

TransactionModel.belongsTo(User, { 
  foreignKey: 'toUserId', 
  as: 'toUser'
});

// Associations pour les événements
EventModel.belongsTo(User, { 
  foreignKey: 'created_by', 
  as: 'creator'
});

EventModel.belongsTo(User, { 
  foreignKey: 'updated_by', 
  as: 'updater'
});

// Associations pour les événements fonctionnels
FunctionalEventModel.belongsTo(User, { 
  foreignKey: 'created_by', 
  as: 'creator'
});

FunctionalEventModel.belongsTo(User, { 
  foreignKey: 'updated_by', 
  as: 'updater'
});

// Associations pour les demandes de vérification
User.hasMany(VerificationRequestModel, { 
  foreignKey: 'user_id', 
  as: 'verificationRequests',
  onDelete: 'CASCADE'
});

VerificationRequestModel.belongsTo(User, { 
  foreignKey: 'user_id', 
  as: 'user'
});

VerificationRequestModel.belongsTo(User, { 
  foreignKey: 'processed_by', 
  as: 'processor'
});

// Associations pour les tickets d'unban
User.hasMany(UnbanTicketModel, {
  foreignKey: 'user_id',
  as: 'unbanTickets',
  onDelete: 'CASCADE'
});

UnbanTicketModel.belongsTo(User, {
  foreignKey: 'user_id',
  as: 'user'
});

UnbanTicketModel.belongsTo(User, {
  foreignKey: 'processed_by',
  as: 'processor'
});

// Associations pour les publicités
User.hasMany(AdCampaignModel, { 
  foreignKey: 'user_id', 
  as: 'adCampaigns',
  onDelete: 'CASCADE'
});

AdCampaignModel.belongsTo(User, { 
  foreignKey: 'user_id', 
  as: 'user'
});

User.hasMany(AdvertisementModel, { 
  foreignKey: 'user_id', 
  as: 'advertisements',
  onDelete: 'CASCADE'
});

AdvertisementModel.belongsTo(User, { 
  foreignKey: 'user_id', 
  as: 'user'
});

Tweet.hasMany(AdvertisementModel, { 
  foreignKey: 'tweet_id', 
  as: 'advertisements',
  onDelete: 'CASCADE'
});

AdvertisementModel.belongsTo(Tweet, { 
  foreignKey: 'tweet_id', 
  as: 'tweet'
});

AdCampaignModel.hasMany(AdvertisementModel, { 
  foreignKey: 'campaign_id', 
  as: 'advertisements',
  onDelete: 'CASCADE'
});

AdvertisementModel.belongsTo(AdCampaignModel, { 
  foreignKey: 'campaign_id', 
  as: 'campaign'
});

// Associations pour les interactions publicitaires
AdvertisementModel.hasMany(AdImpressionModel, { 
  foreignKey: 'advertisement_id', 
  as: 'impressions',
  onDelete: 'CASCADE'
});

AdImpressionModel.belongsTo(AdvertisementModel, { 
  foreignKey: 'advertisement_id', 
  as: 'advertisement'
});

AdvertisementModel.hasMany(AdClickModel, { 
  foreignKey: 'advertisement_id', 
  as: 'clicks',
  onDelete: 'CASCADE'
});

AdClickModel.belongsTo(AdvertisementModel, { 
  foreignKey: 'advertisement_id', 
  as: 'advertisement'
});

AdvertisementModel.hasMany(AdEngagementModel, { 
  foreignKey: 'advertisement_id', 
  as: 'engagements',
  onDelete: 'CASCADE'
});

AdEngagementModel.belongsTo(AdvertisementModel, { 
  foreignKey: 'advertisement_id', 
  as: 'advertisement'
});

// Associations User pour les interactions publicitaires
User.hasMany(AdImpressionModel, { 
  foreignKey: 'user_id', 
  as: 'adImpressions',
  onDelete: 'CASCADE'
});

User.hasMany(AdClickModel, { 
  foreignKey: 'user_id', 
  as: 'adClicks',
  onDelete: 'CASCADE'
});

User.hasMany(AdEngagementModel, { 
  foreignKey: 'user_id', 
  as: 'adEngagements',
  onDelete: 'CASCADE'
});

AdImpressionModel.belongsTo(User, { 
  foreignKey: 'user_id', 
  as: 'user'
});

AdClickModel.belongsTo(User, { 
  foreignKey: 'user_id', 
  as: 'user'
});

AdEngagementModel.belongsTo(User, { 
  foreignKey: 'user_id', 
  as: 'user'
});

// Associations UserChallenge
User.hasMany(UserChallengeModel, { 
  foreignKey: 'user_id', 
  as: 'challenges',
  onDelete: 'CASCADE'
});

UserChallengeModel.belongsTo(User, { 
  foreignKey: 'user_id', 
  as: 'user'
});

// Associations Developer Apps & OAuth
User.hasMany(DeveloperApp, {
  foreignKey: 'user_id',
  as: 'developerApps',
  onDelete: 'CASCADE'
});
DeveloperApp.belongsTo(User, {
  foreignKey: 'user_id',
  as: 'creator'
});

DeveloperApp.hasMany(OAuthCode, {
  foreignKey: 'developer_app_id',
  as: 'oauthCodes',
  onDelete: 'CASCADE'
});
OAuthCode.belongsTo(DeveloperApp, {
  foreignKey: 'developer_app_id',
  as: 'app'
});

DeveloperApp.hasMany(OAuthToken, {
  foreignKey: 'developer_app_id',
  as: 'oauthTokens',
  onDelete: 'CASCADE'
});
OAuthToken.belongsTo(DeveloperApp, {
  foreignKey: 'developer_app_id',
  as: 'app'
});

User.hasMany(OAuthCode, {
  foreignKey: 'user_id',
  as: 'oauthCodes',
  onDelete: 'CASCADE'
});
OAuthCode.belongsTo(User, {
  foreignKey: 'user_id',
  as: 'user'
});

User.hasMany(OAuthToken, {
  foreignKey: 'user_id',
  as: 'oauthTokens',
  onDelete: 'CASCADE'
});
OAuthToken.belongsTo(User, {
  foreignKey: 'user_id',
  as: 'user'
});

// Associations Messages (DM + groupes)
Conversation.belongsTo(User, {
  foreignKey: 'created_by',
  as: 'creator'
});

User.hasMany(Conversation, {
  foreignKey: 'created_by',
  as: 'createdConversations'
});

Conversation.hasMany(ConversationParticipant, {
  foreignKey: 'conversation_id',
  as: 'participants',
  onDelete: 'CASCADE'
});

ConversationParticipant.belongsTo(Conversation, {
  foreignKey: 'conversation_id',
  as: 'conversation'
});

User.hasMany(ConversationParticipant, {
  foreignKey: 'user_id',
  as: 'conversationMemberships',
  onDelete: 'CASCADE'
});

ConversationParticipant.belongsTo(User, {
  foreignKey: 'user_id',
  as: 'user'
});

Conversation.hasMany(Message, {
  foreignKey: 'conversation_id',
  as: 'messages',
  onDelete: 'CASCADE'
});

Message.belongsTo(Conversation, {
  foreignKey: 'conversation_id',
  as: 'conversation'
});

User.hasMany(Message, {
  foreignKey: 'sender_id',
  as: 'sentMessages',
  onDelete: 'CASCADE'
});

Message.belongsTo(User, {
  foreignKey: 'sender_id',
  as: 'sender'
});

// Fonction pour tester la connexion à la base de données
async function testConnection() {
  try {
    await sequelize.authenticate();
    logger.info('Connexion à PostgreSQL établie avec succès');
    return true;
  } catch (error) {
    logger.error('Impossible de se connecter à PostgreSQL:', error);
    return false;
  }
}

/**
 * Avec alter:false, Sequelize ne crée pas les nouvelles colonnes sur une table existante,
 * mais tente quand même les index du modèle → erreur si la migration n'a pas été jouée.
 * Ce bootstrap est idempotent (safe au redémarrage).
 */
async function ensureUsersSubscriptionColumns() {
  try {
    const [tables] = await sequelize.query(
      `SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'users'
      ) AS exists`,
      { type: Sequelize.QueryTypes.SELECT }
    );
    if (!tables || !tables.exists) {
      logger.info('[schema] Table users absente : Sequelize.sync créera le schéma.');
      return;
    }

    const [tierRow] = await sequelize.query(
      `SELECT 1 AS ok FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'subscription_tier'
       LIMIT 1`,
      { type: Sequelize.QueryTypes.SELECT }
    );

    if (!tierRow) {
      logger.warn(
        '[schema] Colonne users.subscription_tier absente : application du patch SQL (équivalent migration 20260514).'
      );
      await sequelize.query(`
        DO $enum$
        BEGIN
          CREATE TYPE "enum_users_subscription_tier" AS ENUM ('free', 'plus', 'pro');
        EXCEPTION
          WHEN duplicate_object THEN NULL;
        END
        $enum$;
      `);
      await sequelize.query(`
        ALTER TABLE users
          ADD COLUMN subscription_tier "enum_users_subscription_tier" NOT NULL DEFAULT 'free';
      `);
      await sequelize.query(`
        ALTER TABLE users
          ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMP WITH TIME ZONE NULL;
      `);
      await sequelize.query(`
        UPDATE users SET subscription_tier = 'pro', subscription_expires_at = NULL WHERE premium = true;
      `);
      await sequelize.query(`
        UPDATE users SET subscription_tier = 'free' WHERE premium IS NOT TRUE OR premium IS NULL;
      `);
      await sequelize.query(`
        CREATE INDEX IF NOT EXISTS users_subscription_tier ON users (subscription_tier);
      `);
      logger.info('[schema] users.subscription_tier / subscription_expires_at prêts.');
      return;
    }

    const [expRow] = await sequelize.query(
      `SELECT 1 AS ok FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'subscription_expires_at'
       LIMIT 1`,
      { type: Sequelize.QueryTypes.SELECT }
    );
    if (!expRow) {
      logger.warn('[schema] Ajout de la colonne manquante users.subscription_expires_at.');
      await sequelize.query(`
        ALTER TABLE users
          ADD COLUMN subscription_expires_at TIMESTAMP WITH TIME ZONE NULL;
      `);
    }
  } catch (e) {
    logger.error('[schema] ensureUsersSubscriptionColumns:', e.message);
    throw e;
  }
}

/** Bannière profil : le modèle expose `banner` mais sync({ alter: false }) ne crée pas la colonne. */
async function ensureUsersBannerColumn() {
  try {
    const [tables] = await sequelize.query(
      `SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'users'
      ) AS exists`,
      { type: Sequelize.QueryTypes.SELECT }
    );
    if (!tables || !tables.exists) {
      return;
    }
    await sequelize.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS banner TEXT NULL;
    `);
  } catch (e) {
    logger.error('[schema] ensureUsersBannerColumn:', e.message);
    throw e;
  }
}

// Fonction pour synchroniser la base de données
async function syncDatabase() {
  try {
    logger.info('Début de la synchronisation de la base de données...');
    
    // ÉTAPE 1: Supprimer les vues qui dépendent des colonnes à modifier
    try {
      logger.info('Suppression des vues dépendantes...');
      await sequelize.query('DROP VIEW IF EXISTS popular_users CASCADE');
      await sequelize.query('DROP VIEW IF EXISTS recent_users CASCADE');
      await sequelize.query('DROP VIEW IF EXISTS global_stats CASCADE');
      logger.info('Vues supprimées avec succès');
    } catch (viewError) {
      logger.warn('Erreur lors de la suppression des vues (peut être normal):', viewError.message);
    }

    await ensureUsersSubscriptionColumns();
    await ensureUsersBannerColumn();

    // ÉTAPE 2: Synchroniser les modèles (créer/modifier les tables)
    logger.info('Synchronisation des modèles...');
    // Utiliser force: false pour ne JAMAIS supprimer de données existantes
    // alter: false pour éviter les modifications de colonnes qui causent des conflits
    await sequelize.sync({ force: false, alter: false });
    logger.info('Modèles synchronisés avec succès');
    
    // ÉTAPE 3: Recréer les vues optimisées
    try {
      logger.info('Recréation des vues optimisées...');
      
      // Vue pour les utilisateurs populaires
      await sequelize.query(`
        CREATE OR REPLACE VIEW popular_users AS
        SELECT 
          id, username, full_name, avatar, verified, premium,
          stats->>'followers' as followers_count,
          stats->>'following' as following_count,
          stats->>'tweets' as tweets_count,
          created_at, last_activity
        FROM users 
        WHERE is_active = true 
        ORDER BY (stats->>'followers')::integer DESC
      `);

      // Vue pour les utilisateurs récents
      await sequelize.query(`
        CREATE OR REPLACE VIEW recent_users AS
        SELECT 
          id, username, full_name, avatar, verified, premium,
          created_at, last_activity
        FROM users 
        WHERE is_active = true 
        AND created_at >= NOW() - INTERVAL '30 days'
        ORDER BY created_at DESC
      `);

      // Vue pour les statistiques globales
      await sequelize.query(`
        CREATE OR REPLACE VIEW global_stats AS
        SELECT 
          COUNT(*) as total_users,
          COUNT(*) FILTER (WHERE verified = true) as verified_users,
          COUNT(*) FILTER (WHERE premium = true) as premium_users,
          COUNT(*) FILTER (WHERE last_activity >= NOW() - INTERVAL '24 hours') as active_today,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') as new_this_week,
          AVG((stats->>'followers')::integer) as avg_followers,
          AVG((stats->>'tweets')::integer) as avg_tweets
        FROM users 
        WHERE is_active = true
      `);
      
      logger.info('Vues recréées avec succès');
    } catch (viewError) {
      logger.error('Erreur lors de la recréation des vues:', viewError);
      // Ne pas faire échouer la synchronisation pour une erreur de vue
    }
    
    // Créer des données de test si la base est vide
    await createTestData();
    
    logger.info('Base de données synchronisée avec succès');
    
  } catch (error) {
    logger.error('Erreur lors de la synchronisation de la base de données:', error);
    throw error;
  }
}

// Fonction pour créer des données de test
async function createTestData() {
  try {
    // Vérifier si des utilisateurs existent déjà
    const userCount = await User.count();
    if (userCount > 0) {
      logger.info('Des utilisateurs existent déjà, pas de données de test créées');
      return;
    }

    logger.info('Création de données de test...');

    // Créer des utilisateurs de test
    const testUsers = await User.bulkCreate([
      {
        username: 'admin',
        full_name: 'Administrateur',
        email: 'admin@wtitninf.com',
        phone: '+33123456789',
        password: 'AdminPass123!',
        platform: 'web',
        verified: true,
        premium: true,
        stats: {
          followers: 1000,
          following: 500,
          tweets: 250,
          likes: 1500
        }
      },
      {
        username: 'john_doe',
        full_name: 'John Doe',
        email: 'john@example.com',
        phone: '+33123456790',
        password: 'UserPass123!',
        platform: 'mobile',
        verified: false,
        premium: false,
        stats: {
          followers: 150,
          following: 200,
          tweets: 75,
          likes: 300
        }
      },
      {
        username: 'jane_smith',
        full_name: 'Jane Smith',
        email: 'jane@example.com',
        phone: '+33123456791',
        password: 'UserPass123!',
        platform: 'mobile',
        verified: true,
        premium: false,
        stats: {
          followers: 300,
          following: 150,
          tweets: 120,
          likes: 600
        }
      }
    ]);

    // Créer des tweets de test
    const testTweets = await Tweet.bulkCreate([
      {
        user_id: testUsers[0].id,
        content: 'Bienvenue sur Wtitninf ! 🚀 Une nouvelle ère de partage social commence.',
        hashtags: ['#Wtitninf', '#SocialMedia', '#Innovation'],
        mentions: [],
        media_urls: [],
        language: 'fr'
      },
      {
        user_id: testUsers[1].id,
        content: 'Salut tout le monde ! Content de rejoindre cette communauté. #Hello #NewUser',
        hashtags: ['#Hello', '#NewUser'],
        mentions: [],
        media_urls: [],
        language: 'fr'
      },
      {
        user_id: testUsers[2].id,
        content: 'Les nouvelles fonctionnalités de Wtitninf sont incroyables ! #TechNews #Amazing',
        hashtags: ['#TechNews', '#Amazing'],
        mentions: [],
        media_urls: [],
        language: 'fr'
      }
    ]);

    // Créer des relations de suivi
    await UserFollow.bulkCreate([
      {
        follower_id: testUsers[1].id,
        following_id: testUsers[0].id
      },
      {
        follower_id: testUsers[2].id,
        following_id: testUsers[0].id
      },
      {
        follower_id: testUsers[0].id,
        following_id: testUsers[1].id
      }
    ]);

    // Créer des likes de test
    await TweetLike.bulkCreate([
      {
        user_id: testUsers[1].id,
        tweet_id: testUsers[0].id
      },
      {
        user_id: testUsers[2].id,
        tweet_id: testUsers[0].id
      },
      {
        user_id: testUsers[0].id,
        tweet_id: testUsers[1].id
      }
    ]);

    logger.info('Données de test créées avec succès');
  } catch (error) {
    logger.error('Erreur lors de la création des données de test:', error);
  }
}

// Fonction pour fermer la connexion
async function closeConnection() {
  try {
    await sequelize.close();
    logger.info('Connexion à PostgreSQL fermée');
  } catch (error) {
    logger.error('Erreur lors de la fermeture de la connexion:', error);
  }
}

module.exports = {
  sequelize,
  User,
  Tweet,
  TweetLike,
  TweetRetweet,
  Notification,
  UserFollow,
  Report: ReportModel,
  FeedHashtagRule: FeedHashtagRuleModel,
  ModerationAction: ModerationActionModel,
  UserBehaviorData,
  UserPreferences,
  MonetizationMetrics,
  VirtualCurrency: VirtualCurrencyModel,
  UserWallet: UserWalletModel,
  Transaction: TransactionModel,
  Event: EventModel,
  FunctionalEvent: FunctionalEventModel,
  VerificationRequest: VerificationRequestModel,
  BotReputation,
  Advertisement: AdvertisementModel,
  AdCampaign: AdCampaignModel,
  AdImpression: AdImpressionModel,
  AdClick: AdClickModel,
  AdEngagement: AdEngagementModel,
  UserChallenge: UserChallengeModel,
  DeveloperApp,
  OAuthCode,
  OAuthToken,
  Conversation,
  ConversationParticipant,
  Message,
  UnbanTicket: UnbanTicketModel,
  PolicierCongoContract: PolicierCongoContractModel,
  MiningRound: MiningRoundModel,
  CasinoBet: CasinoBetModel,
  testConnection,
  syncDatabase,
  closeConnection
};
