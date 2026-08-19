const { Sequelize } = require('sequelize');
const config = require('../config/config');
const logger = require('../utils/logger');
const { requestAllowsReplica } = require('../database/requestReadRouting');
const {
  runSubscriberTweetCreditBackfill,
} = require('../services/subscriberTweetCreditBackfill');

// Import des modèles
const User = require('./User');
const Tweet = require('./Tweet');
const TweetLike = require('./TweetLike');
const TweetRetweet = require('./TweetRetweet');
const Notification = require('./Notification');
const UserFollow = require('./UserFollow');
const Report = require('./Report');
const CommunityReviewItem = require('./CommunityReviewItem');
const CommunityReviewVote = require('./CommunityReviewVote');
const CommunityReviewAssignment = require('./CommunityReviewAssignment');
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
// Systeme d'evenements unifie — remplace le trio Event / FunctionalEvent /
// UserChallenge, conserves le temps que les anciens appelants soient migres.
const TwEvent = require('./TwEvent');
const TwQuestClaim = require('./TwQuestClaim');
const TwQuestSignal = require('./TwQuestSignal');
const TwEventPost = require('./TwEventPost');
const FeatureFlagModule = require('./FeatureFlag');
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
const SessionModule = require('./Session');
const UserLocationEventModule = require('./UserLocationEvent');
const UserConsentRecordModule = require('./UserConsentRecord');
const BotReputation = require('./BotReputation');
const Conversation = require('./Conversation');
const ConversationParticipant = require('./ConversationParticipant');
const Message = require('./Message');
const MessageReaction = require('./MessageReaction');
const UnbanTicketModule = require('./UnbanTicket');
const SupportTicketModule = require('./SupportTicket');
const SupportTicketMessageModule = require('./SupportTicketMessage');
const PolicierCongoContract = require('./PolicierCongoContract');
const MiningRound = require('./MiningRound');
const CasinoBet = require('./CasinoBet');
const Story = require('./Story');
const StoryView = require('./StoryView');
const StoryHighlight = require('./StoryHighlight');
const StoryHighlightItem = require('./StoryHighlightItem');
const TweetTranslation = require('./TweetTranslation');
// Offre créateur : contenu payant, marché des pseudos, programmation, édition,
// visites de profil, veille usurpation et alertes de décollage.
const PaidContentModule = require('./PaidContent');
const ContentPurchaseModule = require('./ContentPurchase');
const ScheduledTweetModule = require('./ScheduledTweet');
const TweetEditModule = require('./TweetEdit');
const ProfileViewModule = require('./ProfileView');
const ImpersonationAlertModule = require('./ImpersonationAlert');
const TweetVelocityAlertModule = require('./TweetVelocityAlert');
const UsernameListingModule = require('./UsernameListing');
const UsernameSaleModule = require('./UsernameSale');
const UsernameReservationModule = require('./UsernameReservation');
const DailySpotlight = require('./DailySpotlight');
// Concours : cagnotte attachée à un tweet, conditions de participation et
// tirage automatique à l'échéance.
const Contest = require('./Contest');
const FeatureProposal = require('./FeatureProposal');
const ContestEntry = require('./ContestEntry');
// Places d'invitation : le billet signé et le journal des passages a l'entree.
const EventPassModule = require('./EventPass');
const EventPassScanModule = require('./EventPassScan');

// Créer l'instance Sequelize
const sequelize = new Sequelize(config.database);

// Sequelize choisit son pool juste avant d'obtenir la connexion. Sur le noeud
// B, forcer les SELECT des POST/PUT/DELETE et des jobs hors HTTP sur le writer
// elimine le piege create-then-read ; seuls GET/HEAD peuvent utiliser le
// standby configure par DB_ORM_READ_HOST.
if (config.database.replication) {
  const getConnection = sequelize.connectionManager.getConnection.bind(sequelize.connectionManager);
  sequelize.connectionManager.getConnection = (options = {}) => {
    if (options.type === 'SELECT' && !requestAllowsReplica()) {
      return getConnection({ ...options, type: 'WRITE', useMaster: true });
    }
    return getConnection(options);
  };
}

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
const CommunityReviewItemModel = CommunityReviewItem(sequelize);
const CommunityReviewVoteModel = CommunityReviewVote(sequelize);
const CommunityReviewAssignmentModel = CommunityReviewAssignment(sequelize);
const FeedHashtagRuleModel = FeedHashtagRuleModule(sequelize);
const ModerationActionModel = ModerationAction(sequelize);

// Initialiser le modèle de vérification
const VerificationRequestModel = VerificationRequest(sequelize);

// Initialiser le modèle d'événements
const EventModel = Event(sequelize);
const FunctionalEventModel = FunctionalEvent(sequelize);

// Evenements unifies : definition, reclamations, signaux de navigation.
const TwEventModel = TwEvent(sequelize);
const TwQuestClaimModel = TwQuestClaim(sequelize);
const TwQuestSignalModel = TwQuestSignal(sequelize);
const TwEventPostModel = TwEventPost(sequelize);

// Drapeaux de fonctionnalité — déploiement progressif et ciblage par attributs
const FeatureFlag = FeatureFlagModule(sequelize);

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
const Session = SessionModule(sequelize);
const UserLocationEvent = UserLocationEventModule(sequelize);
const UserConsentRecord = UserConsentRecordModule(sequelize);
BotReputation.initBotReputationModel(sequelize);
Conversation.initConversationModel(sequelize);
ConversationParticipant.initConversationParticipantModel(sequelize);
Message.initMessageModel(sequelize);
MessageReaction.initMessageReactionModel(sequelize);
Story.initStoryModel(sequelize);
StoryView.initStoryViewModel(sequelize);
StoryHighlight.initStoryHighlightModel(sequelize);
StoryHighlightItem.initStoryHighlightItemModel(sequelize);
TweetTranslation.initTweetTranslationModel(sequelize);
DailySpotlight.initDailySpotlightModel(sequelize);
Contest.initContestModel(sequelize);
FeatureProposal.initFeatureProposalModel(sequelize);
ContestEntry.initContestEntryModel(sequelize);
const UnbanTicketModel = UnbanTicketModule(sequelize);
const SupportTicketModel = SupportTicketModule(sequelize);
const SupportTicketMessageModel = SupportTicketMessageModule(sequelize);
const PaidContentModel = PaidContentModule(sequelize);
const ContentPurchaseModel = ContentPurchaseModule(sequelize);
const ScheduledTweetModel = ScheduledTweetModule(sequelize);
const TweetEditModel = TweetEditModule(sequelize);
const ProfileViewModel = ProfileViewModule(sequelize);
const ImpersonationAlertModel = ImpersonationAlertModule(sequelize);
const TweetVelocityAlertModel = TweetVelocityAlertModule(sequelize);
const UsernameListingModel = UsernameListingModule(sequelize);
const UsernameSaleModel = UsernameSaleModule(sequelize);
const UsernameReservationModel = UsernameReservationModule(sequelize);
const EventPassModel = EventPassModule(sequelize);
const EventPassScanModel = EventPassScanModule(sequelize);

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

Tweet.hasMany(TweetTranslation, {
  foreignKey: 'tweet_id',
  as: 'translations',
  onDelete: 'CASCADE'
});

TweetTranslation.belongsTo(Tweet, {
  foreignKey: 'tweet_id',
  as: 'tweet'
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

// Monnaies communautaires : NF et EUR gardent creatorId à NULL.
VirtualCurrencyModel.belongsTo(User, {
  foreignKey: 'creatorId',
  as: 'creator'
});

User.hasMany(VirtualCurrencyModel, {
  foreignKey: 'creatorId',
  as: 'createdCurrencies'
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

// Associations pour les drapeaux de fonctionnalité
FeatureFlag.belongsTo(User, { foreignKey: 'created_by', as: 'creator' });
FeatureFlag.belongsTo(User, { foreignKey: 'updated_by', as: 'updater' });

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

// Associations pour le support (accès direct au support — palier Pro)
User.hasMany(SupportTicketModel, {
  foreignKey: 'user_id',
  as: 'supportTickets',
  onDelete: 'CASCADE'
});

SupportTicketModel.belongsTo(User, {
  foreignKey: 'user_id',
  as: 'user'
});

SupportTicketModel.belongsTo(User, {
  foreignKey: 'assigned_to',
  as: 'assignee'
});

SupportTicketModel.hasMany(SupportTicketMessageModel, {
  foreignKey: 'ticket_id',
  as: 'messages',
  onDelete: 'CASCADE'
});

SupportTicketMessageModel.belongsTo(SupportTicketModel, {
  foreignKey: 'ticket_id',
  as: 'ticket'
});

SupportTicketMessageModel.belongsTo(User, {
  foreignKey: 'author_id',
  as: 'author'
});

// ── Offre créateur ────────────────────────────────────────────────────────
// Le verrou payant ne pointe pas vers `tweets` : la cible est polymorphe
// (tweet, story, replay) et une clé étrangère ne sait pas viser trois tables.
// L'existence et la propriété du contenu sont vérifiées par le service.
PaidContentModel.belongsTo(User, { foreignKey: 'creator_id', as: 'creator' });
PaidContentModel.hasMany(ContentPurchaseModel, {
  foreignKey: 'paid_content_id',
  as: 'purchases',
});
ContentPurchaseModel.belongsTo(PaidContentModel, {
  foreignKey: 'paid_content_id',
  as: 'paidContent',
});
ContentPurchaseModel.belongsTo(User, { foreignKey: 'buyer_id', as: 'buyer' });
ContentPurchaseModel.belongsTo(User, { foreignKey: 'creator_id', as: 'creator' });

ScheduledTweetModel.belongsTo(User, { foreignKey: 'user_id', as: 'author' });
ScheduledTweetModel.belongsTo(Tweet, {
  foreignKey: 'published_tweet_id',
  as: 'publishedTweet',
});

TweetEditModel.belongsTo(Tweet, { foreignKey: 'tweet_id', as: 'tweet' });
TweetEditModel.belongsTo(User, { foreignKey: 'edited_by', as: 'editor' });
Tweet.hasMany(TweetEditModel, { foreignKey: 'tweet_id', as: 'edits' });

ProfileViewModel.belongsTo(User, { foreignKey: 'profile_id', as: 'profile' });
ProfileViewModel.belongsTo(User, { foreignKey: 'viewer_id', as: 'viewer' });

ImpersonationAlertModel.belongsTo(User, { foreignKey: 'user_id', as: 'protectedUser' });
ImpersonationAlertModel.belongsTo(User, { foreignKey: 'suspect_id', as: 'suspect' });

TweetVelocityAlertModel.belongsTo(Tweet, { foreignKey: 'tweet_id', as: 'tweet' });
TweetVelocityAlertModel.belongsTo(User, { foreignKey: 'user_id', as: 'author' });

UsernameListingModel.belongsTo(User, { foreignKey: 'seller_id', as: 'seller' });
UsernameListingModel.belongsTo(User, { foreignKey: 'buyer_id', as: 'buyer' });
UsernameSaleModel.belongsTo(User, { foreignKey: 'seller_id', as: 'seller' });
UsernameSaleModel.belongsTo(User, { foreignKey: 'buyer_id', as: 'buyer' });
UsernameSaleModel.belongsTo(UsernameListingModel, {
  foreignKey: 'listing_id',
  as: 'listing',
});
UsernameReservationModel.belongsTo(User, { foreignKey: 'user_id', as: 'holder' });

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

// Compte promu (`target_type = 'profile'`). Distinct de `user` : `user` est
// l'annonceur qui paie, `promoted_user` est le compte mis en avant — et
// depuis qu'on peut promouvoir autre chose que soi, les deux diffèrent.
AdvertisementModel.belongsTo(User, {
  foreignKey: 'target_user_id',
  as: 'promoted_user'
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

// Association du livre d'or : le controleur fait un include({ as: 'author' }),
// qui echoue silencieusement en erreur SQL sans cette declaration.
TwEventPostModel.belongsTo(User, { foreignKey: 'user_id', as: 'author' });

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

// Sessions de connexion (jetons de rafraîchissement avec rotation)
User.hasMany(Session, {
  foreignKey: 'user_id',
  as: 'sessions',
  onDelete: 'CASCADE'
});
Session.belongsTo(User, {
  foreignKey: 'user_id',
  as: 'user'
});

User.hasMany(UserLocationEvent, {
  foreignKey: 'user_id',
  as: 'locationEvents',
  onDelete: 'CASCADE'
});
UserLocationEvent.belongsTo(User, {
  foreignKey: 'user_id',
  as: 'user'
});

User.hasMany(UserConsentRecord, {
  foreignKey: 'user_id',
  as: 'consentRecords',
  onDelete: 'CASCADE'
});
UserConsentRecord.belongsTo(User, {
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

// Associations réactions de message
Message.hasMany(MessageReaction, {
  foreignKey: 'message_id',
  as: 'reactions',
  onDelete: 'CASCADE'
});

MessageReaction.belongsTo(Message, {
  foreignKey: 'message_id',
  as: 'message'
});

MessageReaction.belongsTo(User, {
  foreignKey: 'user_id',
  as: 'user'
});

User.hasMany(MessageReaction, {
  foreignKey: 'user_id',
  as: 'message_reactions',
  onDelete: 'CASCADE'
});

// Associations Stories
User.hasMany(Story, {
  foreignKey: 'user_id',
  as: 'stories',
  onDelete: 'CASCADE'
});

Story.belongsTo(User, {
  foreignKey: 'user_id',
  as: 'author'
});

Story.hasMany(StoryView, {
  foreignKey: 'story_id',
  as: 'views',
  onDelete: 'CASCADE'
});

// Association DailySpotlight
DailySpotlight.belongsTo(Tweet, {
  foreignKey: 'tweet_id',
  as: 'tweet'
});

// Associations Concours
Contest.belongsTo(Tweet, { foreignKey: 'tweet_id', as: 'tweet' });
Tweet.hasOne(Contest, { foreignKey: 'tweet_id', as: 'contest' });
Contest.belongsTo(User, { foreignKey: 'creator_id', as: 'creator' });
Contest.hasMany(ContestEntry, {
  foreignKey: 'contest_id',
  as: 'entries',
  onDelete: 'CASCADE'
});
ContestEntry.belongsTo(Contest, { foreignKey: 'contest_id', as: 'contest' });
ContestEntry.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

// Associations des places d'invitation. `guest_user_id` est en SET NULL : un
// compte supprimé ne doit pas emporter la place qu'on a distribuée, sinon le
// compteur d'entrées de l'événement change tout seul après coup.
EventPassModel.belongsTo(User, { foreignKey: 'guest_user_id', as: 'guest' });
EventPassModel.belongsTo(User, { foreignKey: 'created_by', as: 'issuer' });
EventPassModel.belongsTo(User, { foreignKey: 'scanned_by', as: 'lastScanner' });
User.hasMany(EventPassModel, {
  foreignKey: 'guest_user_id',
  as: 'eventPasses',
  onDelete: 'SET NULL',
});

EventPassScanModel.belongsTo(EventPassModel, { foreignKey: 'pass_id', as: 'pass' });
EventPassScanModel.belongsTo(User, { foreignKey: 'scanned_by', as: 'scanner' });
EventPassModel.hasMany(EventPassScanModel, {
  foreignKey: 'pass_id',
  as: 'scans',
  onDelete: 'CASCADE',
});

// Associations Forge (fonctionnalites proposees par les utilisateurs)
FeatureProposal.belongsTo(User, { foreignKey: 'author_id', as: 'author' });
FeatureProposal.belongsTo(User, { foreignKey: 'decided_by', as: 'decider' });

StoryView.belongsTo(Story, {
  foreignKey: 'story_id',
  as: 'story'
});

StoryView.belongsTo(User, {
  foreignKey: 'viewer_id',
  as: 'viewer'
});

User.hasMany(StoryView, {
  foreignKey: 'viewer_id',
  as: 'story_views',
  onDelete: 'CASCADE'
});

// Associations Stories à la une
User.hasMany(StoryHighlight, {
  foreignKey: 'user_id',
  as: 'story_highlights',
  onDelete: 'CASCADE'
});

StoryHighlight.belongsTo(User, {
  foreignKey: 'user_id',
  as: 'owner'
});

StoryHighlight.hasMany(StoryHighlightItem, {
  foreignKey: 'highlight_id',
  as: 'items',
  onDelete: 'CASCADE'
});

StoryHighlightItem.belongsTo(StoryHighlight, {
  foreignKey: 'highlight_id',
  as: 'highlight'
});

StoryHighlightItem.belongsTo(Story, {
  foreignKey: 'story_id',
  as: 'story'
});

Story.hasMany(StoryHighlightItem, {
  foreignKey: 'story_id',
  as: 'highlight_items',
  onDelete: 'CASCADE'
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

/**
 * Solde du générateur à la demande. La migration reste la source de vérité,
 * ce garde-fou couvre les déploiements historiques qui démarrent directement
 * avec `sequelize.sync({ alter: false })`.
 */
async function ensureUsersTweetGenerationCreditsColumn() {
  try {
    const [tables] = await sequelize.query(
      `SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'users'
      ) AS exists`,
      { type: Sequelize.QueryTypes.SELECT }
    );
    if (!tables || !tables.exists) return;

    await sequelize.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS tweet_generation_credits INTEGER NOT NULL DEFAULT 0;
    `);
    await sequelize.query(`
      DO $constraint$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'users_tweet_generation_credits_nonnegative'
        ) THEN
          ALTER TABLE users
            ADD CONSTRAINT users_tweet_generation_credits_nonnegative
            CHECK (tweet_generation_credits >= 0);
        END IF;
      END
      $constraint$;
    `);
  } catch (e) {
    logger.error('[schema] ensureUsersTweetGenerationCreditsColumn:', e.message);
    throw e;
  }
}

/**
 * Ville affichée sur le profil (« La Forge » : « pouvoir ajouter sa ville
 * comme twitter »). Même garde-fou que `ensureUsersTweetGenerationCreditsColumn`
 * juste au-dessus : `sequelize.sync({ alter: false })` ne touche jamais aux
 * colonnes d'une table existante, donc une colonne ajoutée au modèle sans ce
 * garde-fou n'atteint jamais la base toute seule.
 */
async function ensureUsersCityColumn() {
  try {
    const [tables] = await sequelize.query(
      `SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'users'
      ) AS exists`,
      { type: Sequelize.QueryTypes.SELECT }
    );
    if (!tables || !tables.exists) return;

    await sequelize.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS city VARCHAR(30);
    `);
  } catch (e) {
    logger.error('[schema] ensureUsersCityColumn:', e.message);
    throw e;
  }
}

/**
 * Solde de Super Cœurs (La Forge : palier Pro, renouvelé tous les
 * `SUPER_HEART_RENEW_DAYS` jours — voir `src/utils/superHeartHelpers.js`).
 * Même garde-fou que `ensureUsersTweetGenerationCreditsColumn` : la migration
 * reste la source de vérité, ce filet couvre les déploiements qui démarrent
 * directement avec `sequelize.sync({ alter: false })`.
 */
async function ensureUsersSuperHeartsColumns() {
  try {
    const [tables] = await sequelize.query(
      `SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'users'
      ) AS exists`,
      { type: Sequelize.QueryTypes.SELECT }
    );
    if (!tables || !tables.exists) return;

    await sequelize.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS super_hearts_remaining INTEGER NOT NULL DEFAULT 0;
    `);
    await sequelize.query(`
      DO $constraint$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'users_super_hearts_remaining_nonnegative'
        ) THEN
          ALTER TABLE users
            ADD CONSTRAINT users_super_hearts_remaining_nonnegative
            CHECK (super_hearts_remaining >= 0);
        END IF;
      END
      $constraint$;
    `);
    await sequelize.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS super_hearts_renew_at TIMESTAMPTZ;
    `);
  } catch (e) {
    logger.error('[schema] ensureUsersSuperHeartsColumns:', e.message);
    throw e;
  }
}

/**
 * Marque un like posé en pression longue (Super Cœur) sur `tweet_likes`,
 * table préexistante — même raison d'être que ci-dessus.
 */
async function ensureTweetLikesSuperColumn() {
  try {
    const [tables] = await sequelize.query(
      `SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'tweet_likes'
      ) AS exists`,
      { type: Sequelize.QueryTypes.SELECT }
    );
    if (!tables || !tables.exists) return;

    await sequelize.query(`
      ALTER TABLE tweet_likes
        ADD COLUMN IF NOT EXISTS is_super BOOLEAN NOT NULL DEFAULT false;
    `);
    // Horodatage de la pose du Super Cœur, distinct de created_at (un like
    // classique peut être promu bien après sa création) — voir la migration
    // 20260815d et spotlightService, qui l'utilise pour dater le boost.
    await sequelize.query(`
      ALTER TABLE tweet_likes
        ADD COLUMN IF NOT EXISTS super_liked_at TIMESTAMPTZ;
    `);
  } catch (e) {
    logger.error('[schema] ensureTweetLikesSuperColumn:', e.message);
    throw e;
  }
}

/** Bannière profil : le modèle expose `banner` mais sync({ alter: false }) ne crée pas la colonne. */
/**
 * Fuseau de l'auteur sur une publication programmée.
 *
 * Le mode « meilleur moment » choisit une HEURE DE LA JOURNÉE à l'échéance,
 * dans un worker sans requête HTTP : sans cette colonne il prenait le fuseau
 * du VPS (UTC) et publiait deux heures trop tôt pour un auteur français.
 * `sync({ alter: false })` n'ajoute pas de colonne à une table existante.
 */
async function ensureScheduledTweetsTimeZoneColumn() {
  try {
    const [tables] = await sequelize.query(
      `SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'scheduled_tweets'
      ) AS exists`,
      { type: Sequelize.QueryTypes.SELECT }
    );
    if (!tables || !tables.exists) {
      return;
    }
    await sequelize.query(`
      ALTER TABLE scheduled_tweets
        ADD COLUMN IF NOT EXISTS time_zone VARCHAR(64) NOT NULL DEFAULT 'UTC';
    `);
  } catch (e) {
    logger.error('[schema] ensureScheduledTweetsTimeZoneColumn:', e.message);
    throw e;
  }
}

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

/**
 * Personnalisation de profil premium : le modèle déclare la colonne mais
 * sync({ alter: false }) ne l'ajoute pas sur une table users déjà créée.
 */
async function ensureUsersProfileCustomizationColumn() {
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
      ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_customization JSONB NOT NULL DEFAULT '{}'::jsonb;
    `);
    // Habillage mis de côté à l'expiration de l'abonnement, rendu au
    // réabonnement. Nullable : NULL = rien en attente.
    await sequelize.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_customization_archive JSONB NULL;
    `);
  } catch (e) {
    logger.error('[schema] ensureUsersProfileCustomizationColumn:', e.message);
    throw e;
  }
}

/**
 * Monnaies communautaires : `creator_id` / `is_user_created` sont exposés par le
 * modèle mais sync({ alter: false }) ne les crée pas sur la table existante.
 * NF et EUR restent à creator_id NULL — ce sont des monnaies système.
 */
async function ensureVirtualCurrencyCreatorColumns() {
  try {
    const [tables] = await sequelize.query(
      `SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'virtual_currencies'
      ) AS exists`,
      { type: Sequelize.QueryTypes.SELECT }
    );
    if (!tables || !tables.exists) {
      return;
    }
    await sequelize.query(`
      ALTER TABLE virtual_currencies
        ADD COLUMN IF NOT EXISTS creator_id UUID NULL REFERENCES users(id) ON DELETE SET NULL;
    `);
    await sequelize.query(`
      ALTER TABLE virtual_currencies
        ADD COLUMN IF NOT EXISTS is_user_created BOOLEAN NOT NULL DEFAULT FALSE;
    `);
    await sequelize.query(`
      CREATE INDEX IF NOT EXISTS virtual_currencies_creator_id_idx
        ON virtual_currencies (creator_id);
    `);
  } catch (e) {
    logger.error('[schema] ensureVirtualCurrencyCreatorColumns:', e.message);
    throw e;
  }
}

/**
 * Compteur dénormalisé des likes de stories. `story_views.reaction` reste la
 * source par utilisateur ; ce compteur évite un COUNT pour chaque story du fil.
 */
async function ensureStoryLikesCountColumn() {
  try {
    const [tables] = await sequelize.query(
      `SELECT
        to_regclass('public.stories') IS NOT NULL AS stories_exists,
        to_regclass('public.story_views') IS NOT NULL AS views_exists`,
      { type: Sequelize.QueryTypes.SELECT }
    );
    if (!tables || !tables.stories_exists) return;
    await sequelize.query(`
      ALTER TABLE stories
        ADD COLUMN IF NOT EXISTS likes_count INTEGER NOT NULL DEFAULT 0;
    `);
    if (tables.views_exists) {
      await sequelize.query(`
        UPDATE stories s
        SET likes_count = reactions.total
        FROM (
          SELECT story_id, COUNT(*)::integer AS total
          FROM story_views
          WHERE reaction = 'like'
          GROUP BY story_id
        ) reactions
        WHERE reactions.story_id = s.id
          AND s.likes_count <> reactions.total;
      `);
    }
  } catch (e) {
    logger.error('[schema] ensureStoryLikesCountColumn:', e.message);
    throw e;
  }
}

/** Comptes privés : le modèle expose `is_private_account` mais sync({ alter: false }) ne crée pas la colonne. */
async function ensureUsersPrivacyColumn() {
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
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_private_account BOOLEAN NOT NULL DEFAULT false;
    `);
  } catch (e) {
    logger.error('[schema] ensureUsersPrivacyColumn:', e.message);
    throw e;
  }
}

/**
 * Comptes privés : `UserFollow.status` gagne la valeur `pending` (demande de
 * suivi non encore approuvée). `ALTER TYPE ... ADD VALUE` ne peut pas être
 * dans le même bloc de transaction qu'une requête qui l'utilise déjà, mais
 * en requête isolée (comme ici) ça passe sans souci sur PG12+.
 */
async function ensureUserFollowsPendingStatus() {
  try {
    const [tables] = await sequelize.query(
      `SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'user_follows'
      ) AS exists`,
      { type: Sequelize.QueryTypes.SELECT }
    );
    if (!tables || !tables.exists) {
      return;
    }
    await sequelize.query(`
      ALTER TYPE "enum_user_follows_status" ADD VALUE IF NOT EXISTS 'pending';
    `);
  } catch (e) {
    logger.error('[schema] ensureUserFollowsPendingStatus:', e.message);
    throw e;
  }
}

/**
 * Messages vocaux et images : `message_type` gagne 'image'/'audio' côté
 * modèle, mais `sync({ alter: false })` ne rattrape jamais un ENUM Postgres
 * déjà créé en prod — sans ceci, `Message.create({ message_type: 'image' })`
 * échoue avec "invalid input value for enum".
 */
async function ensureMessagesMediaTypes() {
  try {
    const [tables] = await sequelize.query(
      `SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'messages'
      ) AS exists`,
      { type: Sequelize.QueryTypes.SELECT }
    );
    if (!tables || !tables.exists) {
      return;
    }
    await sequelize.query(`
      ALTER TYPE "enum_messages_message_type" ADD VALUE IF NOT EXISTS 'image';
      ALTER TYPE "enum_messages_message_type" ADD VALUE IF NOT EXISTS 'audio';
    `);
  } catch (e) {
    logger.error('[schema] ensureMessagesMediaTypes:', e.message);
    throw e;
  }
}

/**
 * Revue communautaire : colonnes ajoutées après la création initiale des tables
 * — `sync({alter:false})` ne les aurait jamais posées tout seul. Toutes en
 * TEXT/JSONB brut plutôt qu'en vrai type ENUM Postgres : plus simple à ajouter
 * à une table qui existe déjà, et la validation des valeurs se fait côté modèle.
 *
 * `severity_answers` n'est plus alimentée depuis que le questionnaire de
 * gravité a disparu (le palier est choisi par un modèle arbitre, voir
 * `communityReviewAdjudicator`). Elle reste créée et conservée : les lignes
 * écrites avant le changement portent des réponses réelles, et les effacer
 * détruirait la traçabilité des sanctions déjà exécutées.
 */
async function ensureCommunityReviewColumns() {
  try {
    const [tables] = await sequelize.query(
      `SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'community_review_items'
      ) AS exists`,
      { type: Sequelize.QueryTypes.SELECT }
    );
    if (!tables || !tables.exists) return;
    await sequelize.query(`
      ALTER TABLE community_review_items ADD COLUMN IF NOT EXISTS sanction            TEXT;
      ALTER TABLE community_review_items ADD COLUMN IF NOT EXISTS adjudication_status TEXT;
      ALTER TABLE community_review_items ADD COLUMN IF NOT EXISTS adjudication        JSONB;
      ALTER TABLE community_review_votes ADD COLUMN IF NOT EXISTS severity_answers    JSONB;
    `);
    // Le balayage de rattrapage cherche les arbitrages restés en plan : sans
    // index, il refait un seq scan sur toute la table à chaque passage.
    await sequelize.query(`
      CREATE INDEX IF NOT EXISTS community_review_items_pending_adjudication_idx
        ON community_review_items (closed_at)
        WHERE adjudication_status = 'pending';
    `);
  } catch (e) {
    logger.error('[schema] ensureCommunityReviewColumns:', e.message);
    throw e;
  }
}

/**
 * Signalement v2 : catégorie structurée, notation côté serveur et traçabilité
 * de l'escalade. Le modèle expose ces colonnes mais `sync({ alter: false })`
 * ne les pose pas sur une table `reports` qui existe déjà en production.
 * TEXT plutôt qu'ENUM Postgres pour les valeurs fermées — la taxonomie
 * évoluera, et un ALTER TYPE par catégorie ajoutée serait ingérable.
 */
async function ensureReportsV2Columns() {
  try {
    const [tables] = await sequelize.query(
      `SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'reports'
      ) AS exists`,
      { type: Sequelize.QueryTypes.SELECT }
    );
    if (!tables || !tables.exists) {
      return;
    }
    await sequelize.query(`
      ALTER TABLE reports
        ADD COLUMN IF NOT EXISTS category             TEXT,
        ADD COLUMN IF NOT EXISTS details              TEXT,
        ADD COLUMN IF NOT EXISTS source               TEXT,
        ADD COLUMN IF NOT EXISTS reporter_weight      DOUBLE PRECISION,
        ADD COLUMN IF NOT EXISTS weighted_score       DOUBLE PRECISION,
        ADD COLUMN IF NOT EXISTS target_score         DOUBLE PRECISION,
        ADD COLUMN IF NOT EXISTS auto_escalated       BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS escalated_at         TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS escalation_reason    TEXT,
        ADD COLUMN IF NOT EXISTS reporter_notified_at TIMESTAMPTZ;
    `);
    await sequelize.query(`
      CREATE INDEX IF NOT EXISTS reports_status_priority_idx ON reports (status, priority DESC);
      CREATE INDEX IF NOT EXISTS reports_category_idx        ON reports (category);
      CREATE INDEX IF NOT EXISTS reports_open_target_idx     ON reports (target_id, target_type)
        WHERE status IN ('pending', 'investigating');
    `);
  } catch (e) {
    logger.error('[schema] ensureReportsV2Columns:', e.message);
    throw e;
  }
}

/**
 * « Traduction (bêta) » : le modèle Tweet déclare `translation_enabled` mais
 * `sync({ alter: false })` ne l'ajoute pas sur une table tweets déjà créée.
 */
async function ensureTweetsTranslationColumn() {
  try {
    const [tables] = await sequelize.query(
      `SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'tweets'
      ) AS exists`,
      { type: Sequelize.QueryTypes.SELECT }
    );
    if (!tables || !tables.exists) {
      return;
    }
    await sequelize.query(`
      ALTER TABLE tweets
        ADD COLUMN IF NOT EXISTS translation_enabled BOOLEAN NOT NULL DEFAULT false;
    `);
  } catch (e) {
    logger.error('[schema] ensureTweetsTranslationColumn:', e.message);
    throw e;
  }
}

/**
 * Langue de lecture (« Traduction bêta ») : colonne déclarée par le modèle
 * User mais que `sync({ alter: false })` n'ajoute pas sur une table existante.
 * Reste NULL pour les comptes actuels — c'est voulu, voir `preferred_language`
 * dans `models/User.js`.
 */
async function ensureUsersPreferredLanguageColumn() {
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
      ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_language VARCHAR(8) NULL;
    `);
  } catch (e) {
    logger.error('[schema] ensureUsersPreferredLanguageColumn:', e.message);
    throw e;
  }
}

/**
 * Morceau Spotify attaché à un tweet (La Forge : « mettre de la musique dans
 * les tweets »). Même garde-fou que `ensureTweetsTranslationColumn` : colonne
 * déclarée par le modèle `Tweet` mais que `sync({ alter: false })` n'ajoute
 * pas sur la table `tweets` déjà existante.
 */
async function ensureTweetsSpotifyTrackColumn() {
  try {
    const [tables] = await sequelize.query(
      `SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'tweets'
      ) AS exists`,
      { type: Sequelize.QueryTypes.SELECT }
    );
    if (!tables || !tables.exists) {
      return;
    }
    await sequelize.query(`
      ALTER TABLE tweets ADD COLUMN IF NOT EXISTS spotify_track JSONB NULL;
    `);
  } catch (e) {
    logger.error('[schema] ensureTweetsSpotifyTrackColumn:', e.message);
    throw e;
  }
}

/**
 * Message vocal attaché à un tweet (La Forge : « pouvoir ajouter un message
 * vocal dans notre tweet »). Même garde-fou que `ensureTweetsSpotifyTrackColumn` :
 * colonnes déclarées par le modèle `Tweet` mais que `sync({ alter: false })`
 * n'ajoute pas sur la table `tweets` déjà existante.
 */
async function ensureTweetsAudioColumns() {
  try {
    const [tables] = await sequelize.query(
      `SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'tweets'
      ) AS exists`,
      { type: Sequelize.QueryTypes.SELECT }
    );
    if (!tables || !tables.exists) {
      return;
    }
    await sequelize.query(`
      ALTER TABLE tweets
        ADD COLUMN IF NOT EXISTS audio_url TEXT NULL,
        ADD COLUMN IF NOT EXISTS audio_duration INTEGER NULL;
    `);
  } catch (e) {
    logger.error('[schema] ensureTweetsAudioColumns:', e.message);
    throw e;
  }
}

/**
 * Publicité : promouvoir un COMPTE, pas seulement un tweet.
 *
 * Même piège que `ensureUsersCityColumn` : `sequelize.sync({ alter: false })`
 * ne touche jamais une table existante, MAIS il tente quand même de créer les
 * index déclarés sur le modèle (`AdvertisementModel`, champ `target_user_id`)
 * — et ça, il le fait même sans `alter`. Sans ce garde-fou, `sync()` essaie de
 * poser un index sur une colonne qui n'existe pas encore et fait planter tout
 * le démarrage (« column "target_user_id" does not exist »), avant même que
 * la migration ait eu une chance de l'ajouter.
 */
async function ensureAdvertisementsTargetColumns() {
  try {
    const [tables] = await sequelize.query(
      `SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'advertisements'
      ) AS exists`,
      { type: Sequelize.QueryTypes.SELECT }
    );
    if (!tables || !tables.exists) return;

    await sequelize.query(`
      ALTER TABLE advertisements
        ADD COLUMN IF NOT EXISTS target_type VARCHAR(16) NOT NULL DEFAULT 'tweet',
        ADD COLUMN IF NOT EXISTS target_user_id UUID NULL REFERENCES users(id) ON DELETE CASCADE;
      ALTER TABLE advertisements ALTER COLUMN tweet_id DROP NOT NULL;
    `);
    await sequelize.query(`
      DO $constraint$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'advertisements_target_ck'
        ) THEN
          ALTER TABLE advertisements ADD CONSTRAINT advertisements_target_ck CHECK (
            (target_type = 'tweet'   AND tweet_id       IS NOT NULL) OR
            (target_type = 'profile' AND target_user_id IS NOT NULL)
          );
        END IF;
      END
      $constraint$;
    `);
  } catch (e) {
    logger.error('[schema] ensureAdvertisementsTargetColumns:', e.message);
    throw e;
  }
}

/**
 * Suivi vues/clics du mur Explorer (voir
 * `docs/superpowers/specs/2026-08-20-explore-view-click-tracking-design.md`).
 * `view_count` reste inchangé ; ces deux colonnes ne sont lues que par
 * `tweetMonetizationService.js`.
 */
async function ensureTweetsExploreCounters() {
  try {
    const [tables] = await sequelize.query(
      `SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'tweets'
      ) AS exists`,
      { type: Sequelize.QueryTypes.SELECT }
    );
    if (!tables || !tables.exists) return;

    await sequelize.query(`
      ALTER TABLE tweets
        ADD COLUMN IF NOT EXISTS explore_view_count INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS explore_click_count INTEGER NOT NULL DEFAULT 0;
    `);
  } catch (e) {
    logger.error('[schema] ensureTweetsExploreCounters:', e.message);
    throw e;
  }
}

/**
 * `UserBehaviorData.action_type` gagne `tweet_click` (clic sur une carte du
 * mur Explorer). Comme pour `open_tweet`/`algo_check_answer` : ajouter la
 * valeur dans l'ENUM JS du modèle ne suffit pas, `sync({ alter: false })` ne
 * touche jamais un type Postgres existant — sans ceci l'insertion échoue et
 * `behaviorTracker` retombe sur `custom_action` en silence.
 */
async function ensureBehaviorDataTweetClickAction() {
  try {
    const [tables] = await sequelize.query(
      `SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'user_behavior_data'
      ) AS exists`,
      { type: Sequelize.QueryTypes.SELECT }
    );
    if (!tables || !tables.exists) return;

    await sequelize.query(`
      ALTER TYPE "enum_user_behavior_data_action_type" ADD VALUE IF NOT EXISTS 'tweet_click';
    `);
  } catch (e) {
    logger.error('[schema] ensureBehaviorDataTweetClickAction:', e.message);
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
    await ensureUsersTweetGenerationCreditsColumn();
    await ensureUsersCityColumn();
    await ensureUsersSuperHeartsColumns();
    await ensureTweetLikesSuperColumn();
    await ensureUsersBannerColumn();
    await ensureUsersProfileCustomizationColumn();
    await ensureUsersPrivacyColumn();
    await ensureUserFollowsPendingStatus();
    await ensureMessagesMediaTypes();
    await ensureCommunityReviewColumns();
    await ensureVirtualCurrencyCreatorColumns();
    await ensureStoryLikesCountColumn();
    await ensureReportsV2Columns();
    await ensureTweetsTranslationColumn();
    await ensureTweetsSpotifyTrackColumn();
    await ensureTweetsAudioColumns();
    await ensureUsersPreferredLanguageColumn();
    await ensureScheduledTweetsTimeZoneColumn();
    await ensureAdvertisementsTargetColumns();
    await ensureTweetsExploreCounters();
    await ensureBehaviorDataTweetClickAction();

    // ÉTAPE 2: Synchroniser les modèles (créer/modifier les tables)
    logger.info('Synchronisation des modèles...');
    // Utiliser force: false pour ne JAMAIS supprimer de données existantes
    // alter: false pour éviter les modifications de colonnes qui causent des conflits
    await sequelize.sync({ force: false, alter: false });

    // Après sync : sur une base neuve, la table users n'existait pas encore
    // pendant les garde-fous de colonnes ci-dessus.
    const tweetCreditBackfill = await runSubscriberTweetCreditBackfill(sequelize);
    if (tweetCreditBackfill.applied) {
      logger.info(
        `[schema] Crédit de lancement appliqué à ${tweetCreditBackfill.credited} abonné(s) actif(s).`
      );
    }
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

/**
 * 🗃️ Invalidation du cache de feed à la publication.
 *
 * Un hook de modèle plutôt qu'un appel dans les routes : `Tweet.create` est
 * appelé depuis au moins cinq endroits de `tweetRoutes.js` (tweet simple,
 * vidéo, fils, réponses, PolicierCongo). Les instrumenter un par un, c'est
 * garantir d'en oublier un aujourd'hui ou d'en rater un nouveau demain.
 *
 * Seul l'auteur est invalidé. Les fils de ses abonnés restent périmés jusqu'au
 * TTL, ce qui est assumé : quelques dizaines de secondes de retard sur le fil
 * des autres est le prix du cache, alors que ne pas voir son propre tweet
 * juste après l'avoir publié passe pour un bug.
 *
 * `afterCommit` est indispensable quand il y a une transaction : invalider
 * avant le commit rouvrirait une fenêtre où une lecture concurrente remet en
 * cache l'état d'AVANT la publication, et le cache resterait faux jusqu'au TTL.
 */
Tweet.addHook('afterCreate', (tweet, options) => {
  const authorId = tweet?.user_id;
  if (!authorId) return;
  // Chargement paresseux : `feedCache` ne dépend pas des modèles, mais on évite
  // de figer l'ordre des `require` au chargement de ce fichier.
  const purge = () => {
    require('../services/feedCache')
      .invalidateUserFeed(authorId)
      .catch((error) => logger.warn(`[feedCache] Invalidation après publication en échec: ${error.message}`));
  };
  if (options?.transaction) options.transaction.afterCommit(purge);
  else purge();
});

module.exports = {
  sequelize,
  User,
  Tweet,
  TweetLike,
  TweetRetweet,
  Notification,
  UserFollow,
  Report: ReportModel,
  CommunityReviewItem: CommunityReviewItemModel,
  CommunityReviewVote: CommunityReviewVoteModel,
  CommunityReviewAssignment: CommunityReviewAssignmentModel,
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
  TwEvent: TwEventModel,
  TwQuestClaim: TwQuestClaimModel,
  TwQuestSignal: TwQuestSignalModel,
  TwEventPost: TwEventPostModel,
  FeatureFlag,
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
  Session,
  UserLocationEvent,
  UserConsentRecord,
  Conversation,
  ConversationParticipant,
  Message,
  MessageReaction,
  Story,
  StoryView,
  StoryHighlight,
  StoryHighlightItem,
  TweetTranslation,
  UnbanTicket: UnbanTicketModel,
  SupportTicket: SupportTicketModel,
  SupportTicketMessage: SupportTicketMessageModel,
  PaidContent: PaidContentModel,
  ContentPurchase: ContentPurchaseModel,
  ScheduledTweet: ScheduledTweetModel,
  TweetEdit: TweetEditModel,
  ProfileView: ProfileViewModel,
  ImpersonationAlert: ImpersonationAlertModel,
  TweetVelocityAlert: TweetVelocityAlertModel,
  UsernameListing: UsernameListingModel,
  UsernameSale: UsernameSaleModel,
  UsernameReservation: UsernameReservationModel,
  PolicierCongoContract: PolicierCongoContractModel,
  MiningRound: MiningRoundModel,
  CasinoBet: CasinoBetModel,
  DailySpotlight,
  Contest,
  ContestEntry,
  FeatureProposal,
  EventPass: EventPassModel,
  EventPassScan: EventPassScanModel,
  testConnection,
  syncDatabase,
  closeConnection
};
