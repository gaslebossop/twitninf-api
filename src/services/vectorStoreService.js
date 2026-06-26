/**
 * 🗄️ Vector Store Service — Gestion de la base de données vectorielle
 * 
 * Utilise FAISS (via le bridge Python) comme base vectorielle pour :
 * - Stocker les embeddings BERT des tweets
 * - Recherche par similarité sémantique
 * - Cache des interactions utilisateur sous forme vectorielle
 * 
 * Architecture :
 * PostgreSQL → comptes, auth, tweets (contenu), modération
 * FAISS (Python) → embeddings, similarité, recommandations
 */

const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');
const { getAIBridge } = require('./aiRecommendationBridge');

class VectorStoreService {
    constructor() {
        // Cache local des embeddings pour réduire les appels Python
        this.embeddingCache = new Map();
        this.cacheMaxSize = 10000;
        this.cacheExpiry = 30 * 60 * 1000; // 30 minutes

        // Cache des interactions vectorielles
        this.interactionVectors = new Map();
        
        // Stats
        this.stats = {
            totalEmbeddings: 0,
            cacheHits: 0,
            cacheMisses: 0,
            totalSearches: 0,
            avgSearchTime: 0,
        };

        // Interaction data directory
        this.dataDir = path.join(__dirname, '..', '..', '..', 'data', 'vector_store');
        this._ensureDataDir();
    }

    _ensureDataDir() {
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
    }

    /**
     * Obtient l'embedding BERT d'un texte via le bridge Python
     */
    async getEmbedding(text) {
        // Vérifier le cache local
        const cacheKey = text.substring(0, 200); // Clé basée sur les 200 premiers caractères
        
        if (this.embeddingCache.has(cacheKey)) {
            const cached = this.embeddingCache.get(cacheKey);
            if (Date.now() - cached.timestamp < this.cacheExpiry) {
                this.stats.cacheHits++;
                return cached.embedding;
            }
            this.embeddingCache.delete(cacheKey);
        }

        this.stats.cacheMisses++;
        
        const bridge = getAIBridge();
        if (!bridge.ready) {
            throw new Error('AI bridge not ready');
        }

        const result = await bridge.encodeTweet(text);
        if (result.status === 'ok' && result.data) {
            const embedding = result.data.embedding || result.data;
            
            // Stocker dans le cache
            this.embeddingCache.set(cacheKey, {
                embedding,
                timestamp: Date.now(),
            });

            // Purger le cache si trop gros
            if (this.embeddingCache.size > this.cacheMaxSize) {
                const oldest = this.embeddingCache.keys().next().value;
                this.embeddingCache.delete(oldest);
            }

            this.stats.totalEmbeddings++;
            return embedding;
        }

        throw new Error('Failed to get embedding from AI bridge');
    }

    /**
     * Recherche par similarité sémantique dans FAISS
     */
    async searchSimilar(tweetId, topK = 10) {
        const startTime = Date.now();
        
        const bridge = getAIBridge();
        if (!bridge.ready) {
            throw new Error('AI bridge not ready');
        }

        const result = await bridge.findSimilarTweets(tweetId, topK);
        
        const searchTime = Date.now() - startTime;
        this.stats.totalSearches++;
        this.stats.avgSearchTime = 
            (this.stats.avgSearchTime * (this.stats.totalSearches - 1) + searchTime) / this.stats.totalSearches;

        return result;
    }

    /**
     * Enregistre une interaction utilisateur pour améliorer les recommandations
     * Les interactions sont stockées localement et périodiquement synchronisées
     */
    async recordInteraction(userId, tweetId, action, metadata = {}) {
        const interaction = {
            user_id: userId,
            tweet_id: tweetId,
            action, // 'like', 'retweet', 'view', 'click', 'share', 'bookmark'
            timestamp: new Date().toISOString(),
            ...metadata,
        };

        // Stocker dans le cache local
        const userKey = `user_${userId}`;
        if (!this.interactionVectors.has(userKey)) {
            this.interactionVectors.set(userKey, []);
        }
        this.interactionVectors.get(userKey).push(interaction);

        // Limiter à 1000 interactions par utilisateur en mémoire
        const userInteractions = this.interactionVectors.get(userKey);
        if (userInteractions.length > 1000) {
            this.interactionVectors.set(userKey, userInteractions.slice(-500));
        }

        // Sauvegarder périodiquement sur disque
        if (this.interactionVectors.get(userKey).length % 50 === 0) {
            await this._persistInteractions(userId);
        }

        return interaction;
    }

    /**
     * Récupère les interactions d'un utilisateur
     */
    getInteractions(userId, limit = 100) {
        const userKey = `user_${userId}`;
        const interactions = this.interactionVectors.get(userKey) || [];
        return interactions.slice(-limit);
    }

    /**
     * Calcule le profil vectoriel d'un utilisateur basé sur ses interactions
     */
    async getUserVectorProfile(userId) {
        const interactions = this.getInteractions(userId, 50);
        
        if (interactions.length === 0) {
            return null;
        }

        // Pondérer les types d'interactions
        const weights = {
            'like': 1.0,
            'retweet': 1.5,
            'bookmark': 2.0,
            'share': 2.5,
            'view': 0.3,
            'click': 0.5,
            'dislike': -1.0,
            'report': -2.0,
        };

        return {
            user_id: userId,
            interaction_count: interactions.length,
            interaction_distribution: interactions.reduce((acc, i) => {
                acc[i.action] = (acc[i.action] || 0) + 1;
                return acc;
            }, {}),
            weighted_score: interactions.reduce((sum, i) => {
                return sum + (weights[i.action] || 0);
            }, 0),
            last_interaction: interactions[interactions.length - 1]?.timestamp,
        };
    }

    /**
     * Persiste les interactions sur disque
     */
    async _persistInteractions(userId) {
        try {
            const userKey = `user_${userId}`;
            const interactions = this.interactionVectors.get(userKey) || [];
            
            const filePath = path.join(this.dataDir, `interactions_${userId}.json`);
            
            // Charger les interactions existantes
            let existing = [];
            if (fs.existsSync(filePath)) {
                try {
                    existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                } catch (e) {
                    existing = [];
                }
            }

            // Merger et déduquer
            const merged = [...existing, ...interactions];
            const unique = merged.filter((item, index, self) =>
                index === self.findIndex(t => 
                    t.user_id === item.user_id && 
                    t.tweet_id === item.tweet_id && 
                    t.action === item.action &&
                    t.timestamp === item.timestamp
                )
            );

            // Garder les 5000 dernières
            const trimmed = unique.slice(-5000);

            fs.writeFileSync(filePath, JSON.stringify(trimmed, null, 2), 'utf8');
            logger.debug(`💾 [VectorStore] ${trimmed.length} interactions persistées pour user ${userId}`);
        } catch (err) {
            logger.warn(`⚠️ [VectorStore] Erreur persistence interactions user ${userId}: ${err.message}`);
        }
    }

    /**
     * Charge les interactions depuis le disque au démarrage
     */
    async loadPersistedInteractions() {
        try {
            if (!fs.existsSync(this.dataDir)) return;

            const files = fs.readdirSync(this.dataDir).filter(f => f.startsWith('interactions_'));
            let totalLoaded = 0;

            for (const file of files) {
                try {
                    const userId = file.replace('interactions_', '').replace('.json', '');
                    const data = JSON.parse(fs.readFileSync(path.join(this.dataDir, file), 'utf8'));
                    this.interactionVectors.set(`user_${userId}`, data);
                    totalLoaded += data.length;
                } catch (e) {
                    // Skip corrupt files
                }
            }

            logger.info(`📂 [VectorStore] ${totalLoaded} interactions chargées depuis ${files.length} fichiers`);
        } catch (err) {
            logger.warn(`⚠️ [VectorStore] Erreur chargement interactions: ${err.message}`);
        }
    }

    /**
     * Synchronise les interactions de PostgreSQL vers le vector store
     */
    async syncInteractionsFromDB(sequelizeModels) {
        const { TweetLike, TweetRetweet } = sequelizeModels;
        
        logger.info('🔄 [VectorStore] Synchronisation des interactions depuis PostgreSQL...');
        
        try {
            // Récupérer les derniers likes
            const likes = await TweetLike.findAll({
                attributes: ['user_id', 'tweet_id', 'created_at'],
                order: [['created_at', 'DESC']],
                limit: 10000,
                raw: true,
            });

            for (const like of likes) {
                await this.recordInteraction(like.user_id, like.tweet_id, 'like', {
                    source: 'postgres_sync',
                    original_timestamp: like.created_at,
                });
            }

            // Récupérer les derniers retweets
            const retweets = await TweetRetweet.findAll({
                attributes: ['user_id', 'tweet_id', 'created_at'],
                order: [['created_at', 'DESC']],
                limit: 10000,
                raw: true,
            });

            for (const rt of retweets) {
                await this.recordInteraction(rt.user_id, rt.tweet_id, 'retweet', {
                    source: 'postgres_sync',
                    original_timestamp: rt.created_at,
                });
            }

            logger.info(`✅ [VectorStore] Sync terminée: ${likes.length} likes, ${retweets.length} retweets`);
            return { likes: likes.length, retweets: retweets.length };
        } catch (err) {
            logger.error(`❌ [VectorStore] Erreur sync: ${err.message}`);
            throw err;
        }
    }

    /**
     * Obtient les statistiques du vector store
     */
    getStats() {
        return {
            ...this.stats,
            cacheSize: this.embeddingCache.size,
            usersWithInteractions: this.interactionVectors.size,
            totalInteractionsInMemory: Array.from(this.interactionVectors.values())
                .reduce((sum, arr) => sum + arr.length, 0),
        };
    }
}

// Singleton
let instance = null;

function getVectorStore() {
    if (!instance) {
        instance = new VectorStoreService();
    }
    return instance;
}

module.exports = { VectorStoreService, getVectorStore };
