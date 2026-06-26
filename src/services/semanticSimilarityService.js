const { createLocalEmbedQuery, cosineSimilarity } = require('./policiercongo/policiercongoV2Embeddings');
const logger = require('../utils/logger');
const { Tweet } = require('../models');
const fs = require('fs').promises;
const path = require('path');

class SemanticSimilarityService {
    constructor() {
        this.embedder = createLocalEmbedQuery({ isQuery: false });
        this.index = new Map(); // id -> { vector, content }
        this.indexPath = path.join(__dirname, '..', '..', 'data', 'tweet_semantic_index.json');
        this.isInitialized = false;
        this._ensureDataDir();
    }

    async _ensureDataDir() {
        const dir = path.dirname(this.indexPath);
        try {
            await fs.access(dir);
        } catch {
            await fs.mkdir(dir, { recursive: true });
        }
    }

    /**
     * Initialise l'index en chargeant les tweets et leurs embeddings persistés
     */
    async initialize() {
        if (this.isInitialized) return;
        
        try {
            logger.info('🧠 [Semantic] Initialisation de l\'index sémantique global...');
            
            // 1. Charger l'index depuis le fichier s'il existe
            try {
                const data = await fs.readFile(this.indexPath, 'utf8');
                const savedIndex = JSON.parse(data);
                Object.entries(savedIndex).forEach(([id, info]) => {
                    this.index.set(id, info);
                });
                logger.info(`✅ [Semantic] ${this.index.size} embeddings chargés depuis le cache local`);
            } catch (err) {
                logger.info('ℹ️ [Semantic] Aucun index local trouvé, création d\'un nouvel index...');
            }

            // 2. Synchroniser avec la DB (chercher les nouveaux tweets non indexés)
            const allTweets = await Tweet.findAll({
                where: {
                    parent_tweet_id: null, // Uniquement tweets originaux
                    moderation_status: 'approved',
                    deleted_at: null
                },
                attributes: ['id', 'content'],
                order: [['created_at', 'DESC']]
            });

            const newTweets = allTweets.filter(t => !this.index.has(t.id));
            if (newTweets.length > 0) {
                logger.info(`⏳ [Semantic] Indexation de ${newTweets.length} nouveaux tweets...`);
                
                // Indexation SÉQUENTIELLE pour éviter de saturer le CPU/RAM
                let count = 0;
                for (const tweet of newTweets) {
                    try {
                        const vec = await this.embedder(tweet.content, 'passage');
                        if (vec && vec.length > 0) {
                            this.index.set(tweet.id, { vector: vec, content: tweet.content });
                        }
                        
                        count++;
                        if (count % 20 === 0) {
                            logger.info(`   Indexation en cours: ${count}/${newTweets.length}...`);
                            // Sauvegarde intermédiaire tous les 100 tweets
                            if (count % 100 === 0) await this.saveIndex();
                            // Petite pause pour laisser l'event loop respirer
                            await new Promise(resolve => setTimeout(resolve, 50));
                        }
                    } catch (err) {
                        logger.warn(`⚠️ [Semantic] Erreur sur tweet ${tweet.id}: ${err.message}`);
                    }
                }
                
                await this.saveIndex();
                logger.info(`✅ [Semantic] Indexation terminée. Total: ${this.index.size} tweets`);
            }

            this.isInitialized = true;
        } catch (error) {
            logger.error('❌ [Semantic] Erreur initialisation index:', error);
        }
    }

    async saveIndex() {
        try {
            const data = {};
            this.index.forEach((val, key) => {
                data[key] = val;
            });
            await fs.writeFile(this.indexPath, JSON.stringify(data), 'utf8');
        } catch (error) {
            logger.error('❌ [Semantic] Erreur sauvegarde index:', error);
        }
    }

    /**
     * Ajoute ou met à jour un tweet dans l'index
     */
    async indexTweet(tweet) {
        if (tweet.parent_tweet_id) return null; // Pas de réponses
        
        try {
            const vec = await this.embedder(tweet.content, 'passage');
            if (vec && vec.length > 0) {
                this.index.set(tweet.id, { vector: vec, content: tweet.content });
                await this.saveIndex();
                return vec;
            }
            return null;
        } catch (error) {
            logger.error(`❌ [Semantic] Erreur indexation tweet ${tweet.id}:`, error);
            return null;
        }
    }

    /**
     * Recherche les tweets les plus proches sémantiquement dans TOUTE la plateforme
     */
    async getSimilarTweets(sourceTweet, pool = null, topK = 3) {
        try {
            if (!this.isInitialized) await this.initialize();
            
            // 1. Obtenir le vecteur source
            let sourceVec;
            const cachedSource = this.index.get(sourceTweet.id);
            if (cachedSource) {
                sourceVec = cachedSource.vector;
            } else {
                sourceVec = await this.embedder(sourceTweet.content, 'query');
            }

            if (!sourceVec || sourceVec.length === 0) return [];

            // 2. Chercher dans TOUT l'index
            const scoredResults = [];
            this.index.forEach((info, id) => {
                if (id === sourceTweet.id) return;
                
                const score = cosineSimilarity(sourceVec, info.vector);
                if (score > 0.35) { // Seuil de pertinence
                    scoredResults.push({ id, score });
                }
            });

            // 3. Trier et récupérer les IDs
            const topResults = scoredResults
                .sort((a, b) => b.score - a.score)
                .slice(0, topK);

            if (topResults.length === 0) return [];

            // 4. Récupérer les objets Tweet complets depuis la DB
            const resultTweets = await Tweet.findAll({
                where: { id: topResults.map(r => r.id) }
            });

            // Garder l'ordre de score
            return topResults
                .map(r => resultTweets.find(t => t.id === r.id))
                .filter(Boolean);

        } catch (error) {
            logger.error('❌ [Semantic] Erreur recherche global:', error);
            return [];
        }
    }
}

module.exports = new SemanticSimilarityService();
