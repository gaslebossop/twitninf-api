/**
 * 👥 User Similarity Service — "People Like You" Engine
 * 
 * finds similar users based on shared interactions (likes, retweets, comments, views).
 * Uses Feature Hashing to map sparse interaction data to dense vectors.
 */

const { UserBehaviorData, User, UserFollow } = require('../models');
const { Op } = require('sequelize');
const { VectorStore, createVec, vecNormalize, hashToken, hashSign } = require('./similarity/vectorEngine');
const path = require('path');
const logger = require('../utils/logger');
const fs = require('fs');

class UserSimilarityService {
  constructor() {
    this.dataDir = path.join(__dirname, '../../storage/similarity');
    this.store = new VectorStore('user_interactions', this.dataDir);
    this.isInitialized = false;
    
    // Weights for different action types
    this.weights = {
      'tweet_like': 3.0,
      'tweet_retweet': 5.0,
      'tweet_reply': 4.0,
      'tweet_view': 1.0,
      'profile_view': 0.5,
      'user_follow': 8.0
    };

    // Watch for file changes to reload vectors automatically
    this.setupWatcher();
  }

  setupWatcher() {
    const vdbPath = path.join(this.dataDir, 'user_interactions.vdb');
    if (fs.existsSync(vdbPath)) {
      fs.watch(vdbPath, (eventType) => {
        if (eventType === 'change') {
          logger.info('🔄 User similarity database file changed. Reloading...');
          this.initialize(true);
        }
      });
    }
  }

  /**
   * 🚀 Initialize the service and load existing vectors
   */
  async initialize(force = false) {
    if (this.isInitialized && !force) return;
    
    try {
      const count = this.store.load();
      logger.info(`👥 UserSimilarityService: ${count} vectors loaded ${force ? '(forced reload)' : ''}.`);
      this.isInitialized = true;
    } catch (error) {
      logger.error('❌ UserSimilarityService initialization error:', error);
    }
  }

  /**
   * 🔄 Sync all users interaction data and update vectors
   */
  async syncAllUsers() {
    try {
      logger.info('🔄 Starting full sync of user similarity vectors...');
      
      // 1. Get all interactions (no time limit)
      const interactions = await UserBehaviorData.findAll({
        attributes: ['user_id', 'action_type', 'target_id'],
        where: {
          action_type: { [Op.in]: Object.keys(this.weights) },
          target_id: { [Op.not]: null }
        },
        raw: true
      });

      logger.info(`📊 Fetched ${interactions.length} interactions for sync.`);

      // 2. Group interactions by user
      const userInteractions = new Map();
      for (const inter of interactions) {
        if (!userInteractions.has(inter.user_id)) {
          userInteractions.set(inter.user_id, []);
        }
        userInteractions.get(inter.user_id).push(inter);
      }

      logger.info(`👥 Processing ${userInteractions.size} unique users...`);

      // 3. Generate vectors using Feature Hashing
      let syncCount = 0;
      for (const [userId, items] of userInteractions) {
        const vec = this.generateUserVector(items);
        this.store.upsert(userId, vec);
        syncCount++;
      }

      // 4. Save to disk and reload in memory
      this.store.save();
      await this.initialize(true);
      logger.info(`✅ User similarity sync complete: ${syncCount} users updated.`);
      
      return syncCount;
    } catch (error) {
      logger.error('❌ UserSimilarityService sync error:', error);
      throw error;
    }
  }

  /**
   * 🧬 Generate a dense vector from a list of interactions
   */
  generateUserVector(interactions) {
    const vec = createVec();
    
    for (const item of interactions) {
      const weight = this.weights[item.action_type] || 1.0;
      const targetId = item.target_id;
      
      // Feature Hashing Trick (same as vectorEngine.js tokenize/vectorize)
      const idx = hashToken(targetId);
      const sign = hashSign(targetId);
      
      vec[idx] += sign * weight;
    }
    
    return vecNormalize(vec);
  }

  /**
   * 🔍 Find similar users
   */
  async findSimilarUsers(userId, limit = 10) {
    await this.initialize();
    
    const userVec = this.store.get(userId);
    if (!userVec) {
      logger.warn(`⚠️ No interaction data for user ${userId}`);
      return [];
    }

    // Search in vector store
    const results = this.store.search(userVec, limit + 1);
    
    // Filter out self and get user details
    const similarUserIds = results
      .filter(r => r.id !== userId)
      .slice(0, limit)
      .map(r => r.id);

    if (similarUserIds.length === 0) return [];

    const users = await User.findAll({
      where: { id: { [Op.in]: similarUserIds } },
      attributes: ['id', 'username', 'full_name', 'avatar', 'bio', 'verified'],
      raw: true
    });

    // Sort by similarity score and check follow status
    const followings = await UserFollow.findAll({
      where: {
        follower_id: userId,
        following_id: { [Op.in]: similarUserIds }
      },
      attributes: ['following_id'],
      raw: true
    });
    
    const followingIds = new Set(followings.map(f => f.following_id));

    return users.map(user => {
      const score = results.find(r => r.id === user.id)?.score || 0;
      return { 
        ...user, 
        similarity_score: score,
        is_followed: followingIds.has(user.id)
      };
    }).sort((a, b) => b.similarity_score - a.similarity_score);
  }

  /**
   * 📉 Get raw stats
   */
  getStats() {
    return this.store.getStats();
  }
}

module.exports = new UserSimilarityService();
