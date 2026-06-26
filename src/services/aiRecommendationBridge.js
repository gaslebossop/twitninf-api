/**
 * 🧠 AI Recommendation Bridge — Communication avec le moteur Python IA
 * 
 * Copié et adapté depuis server/python-bridge.js (qui FONCTIONNE).
 * Spawne ai/bridge.py et communique via stdin/stdout JSON.
 * 
 * Pipeline: TweetEncoder (BERT) → NCF → DeepRanker → FAISS
 */

const { spawn } = require('child_process');
const path = require('path');
const EventEmitter = require('events');
const logger = require('../utils/logger');

class AIRecommendationBridge extends EventEmitter {
    constructor() {
        super();
        this.process = null;
        this.ready = false;
        this.pending = new Map();
        this.requestId = 0;
        this.buffer = '';
        this.startTime = null;
        this.stats = {
            totalRequests: 0,
            successfulRequests: 0,
            failedRequests: 0,
            avgResponseTime: 0,
        };
    }

    /**
     * Démarre le processus Python bridge
     * Copié depuis server/python-bridge.js avec ajout dataset
     */
    start() {
        return new Promise((resolve, reject) => {
            const pythonScript = path.join(__dirname, '..', '..', '..', 'ai', 'bridge.py');
            const projectRoot = path.join(__dirname, '..', '..', '..');
            const dataset = process.env.AI_DATASET || 'live_api';

            logger.info('🧠 [AI Bridge] Démarrage du moteur IA Python...');
            logger.info(`   Script: ${pythonScript}`);
            logger.info(`   📂 Dataset: ${dataset}`);
            this.startTime = Date.now();

            const fs = require('fs');
            let pythonBin = 'python';

            const possibleVenvPaths = [
                path.join(projectRoot, 'venv', 'bin', 'python'),
                path.join(projectRoot, '.venv', 'bin', 'python'),
                path.join(projectRoot, 'ai', 'venv', 'bin', 'python'),
                path.join(projectRoot, 'ai', '.venv', 'bin', 'python'),
                path.join(projectRoot, 'venv', 'Scripts', 'python.exe'),
                path.join(projectRoot, '.venv', 'Scripts', 'python.exe'),
                path.join(projectRoot, 'ai', 'venv', 'Scripts', 'python.exe'),
                path.join(projectRoot, 'ai', '.venv', 'Scripts', 'python.exe')
            ];

            for (const p of possibleVenvPaths) {
                if (fs.existsSync(p)) {
                    pythonBin = p;
                    break;
                }
            }

            logger.info(`   Exécutable Python: ${pythonBin}`);

            // Spawn Python
            this.process = spawn(pythonBin, [pythonScript, '--dataset', dataset], {
                stdio: ['pipe', 'pipe', 'pipe'],
                cwd: projectRoot,
            });

            // Buffer pour les données partielles
            this.process.stdout.on('data', (data) => {
                this.buffer += data.toString();
                const lines = this.buffer.split('\n');
                this.buffer = lines.pop(); // Garder le dernier fragment incomplet

                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const response = JSON.parse(line);
                        this._handleResponse(response);
                    } catch (e) {
                        logger.warn(`⚠️ [AI Bridge] JSON parse error: ${e.message}`);
                    }
                }
            });

            this.process.stderr.on('data', (data) => {
                const msg = data.toString().trim();
                if (msg) {
                    // Filtrer les messages de progression PyTorch
                    if (!msg.includes('Epoch') && !msg.includes('%|') && !msg.includes('Downloading')) {
                        logger.info(`   🐍 [Python] ${msg}`);
                    }
                }
            });

            this.process.on('close', (code) => {
                logger.warn(`🐍 [AI Bridge] Python bridge fermé (code: ${code})`);
                this.ready = false;
                this.emit('close', code);
            });

            this.process.on('error', (err) => {
                logger.error(`❌ [AI Bridge] Erreur Python bridge: ${err.message}`);
                reject(err);
            });

            // Attendre le signal "ready"
            const readyTimeout = setTimeout(() => {
                reject(new Error('Python AI bridge timeout (120s)'));
            }, 120000);

            this.once('ready', () => {
                clearTimeout(readyTimeout);
                const loadTime = Date.now() - this.startTime;
                logger.info(`✅ [AI Bridge] Moteur IA prêt en ${loadTime}ms`);
                resolve();
            });
        });
    }

    /**
     * Traite les réponses du processus Python
     */
    _handleResponse(response) {
        if (response.status === 'ready') {
            this.ready = true;
            logger.info('   ✅ [AI Bridge] Python bridge prêt !');
            this.emit('ready');
            return;
        }

        // Résoudre la promise en attente (FIFO)
        if (this.pending.size > 0) {
            const [id, { resolve }] = this.pending.entries().next().value;
            this.pending.delete(id);
            resolve(response);
        }
    }

    /**
     * Envoie une commande au processus Python
     */
    send(command) {
        return new Promise((resolve, reject) => {
            if (!this.ready || !this.process) {
                reject(new Error('AI Python bridge not ready'));
                return;
            }

            const id = ++this.requestId;
            const startTime = Date.now();

            const timeout = setTimeout(() => {
                this.pending.delete(id);
                this.stats.failedRequests++;
                reject(new Error('AI bridge request timeout (60s)'));
            }, 60000);

            this.pending.set(id, {
                resolve: (data) => {
                    clearTimeout(timeout);
                    const responseTime = Date.now() - startTime;
                    this.stats.totalRequests++;
                    this.stats.successfulRequests++;
                    this.stats.avgResponseTime = 
                        (this.stats.avgResponseTime * (this.stats.totalRequests - 1) + responseTime) / this.stats.totalRequests;
                    resolve(data);
                },
                reject: (err) => {
                    clearTimeout(timeout);
                    this.stats.failedRequests++;
                    reject(err);
                }
            });

            const json = JSON.stringify(command) + '\n';
            this.process.stdin.write(json);
        });
    }

    // ═══════════════════════════════════════════════════════════════════
    // HIGH-LEVEL RECOMMENDATION API
    // ═══════════════════════════════════════════════════════════════════

    async recommend(userId, topK = 20) {
        return this.send({ action: 'recommend', user_id: userId, top_k: topK });
    }

    async encodeTweet(text) {
        return this.send({ action: 'test_encode', text });
    }

    async computeSimilarity(text1, text2) {
        return this.send({ action: 'test_similarity', text1, text2 });
    }

    async ncfScore(userId, tweetId) {
        return this.send({ action: 'test_ncf', user_id: userId, tweet_id: tweetId });
    }

    async findSimilarTweets(tweetId, topK = 10) {
        return this.send({ action: 'similar_tweets', tweet_id: tweetId, top_k: topK });
    }

    async getUserInfo(userId) {
        return this.send({ action: 'user_info', user_id: userId });
    }

    async getStats() {
        return this.send({ action: 'stats' });
    }

    async getTweetsList(limit = 50) {
        return this.send({ action: 'tweets_list', limit });
    }

    async setDataset(datasetName) {
        return this.send({ action: 'set_dataset', dataset: datasetName });
    }

    async listDatasets() {
        return this.send({ action: 'list_datasets' });
    }

    async ping() {
        return this.send({ action: 'ping' });
    }

    getBridgeStats() {
        return {
            ready: this.ready,
            uptime: this.startTime ? Date.now() - this.startTime : 0,
            ...this.stats,
        };
    }

    async close() {
        if (this.process) {
            try {
                await this.send({ action: 'quit' });
            } catch (e) {
                // Ignore
            }
            this.process.kill();
            this.process = null;
            this.ready = false;
        }
    }
}

// Singleton
let instance = null;

function getAIBridge() {
    if (!instance) {
        instance = new AIRecommendationBridge();
    }
    return instance;
}

module.exports = { AIRecommendationBridge, getAIBridge };
