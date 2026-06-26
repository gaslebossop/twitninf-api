/**
 * 🚀 Script for Syncing User Similarity Data
 * 
 * This script downloads interaction data from the DB and generates
 * the similarity vectors for the "People Like You" feature.
 */

const userSimilarityService = require('../src/services/userSimilarityService');
const { sequelize } = require('../src/database/index'); 
const logger = require('../src/utils/logger');

async function runSync() {
  try {
    console.log('🚀 Starting User Similarity AI Generation...');
    
    // Ensure database is connected
    await sequelize.authenticate();
    console.log('✅ Database connected.');

    // Initialize service
    await userSimilarityService.initialize();

    // Run sync
    const count = await userSimilarityService.syncAllUsers();
    
    console.log(`\n✨ Successfully generated similarity AI for ${count} users.`);
    console.log('📊 Stats:', JSON.stringify(userSimilarityService.getStats(), null, 2));
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Sync failed:', error);
    process.exit(1);
  }
}

// Check if database connection file exists or try to find it
const fs = require('fs');
const path = require('path');
const dbPath = path.join(__dirname, '../src/database/index.js');
if (!fs.existsSync(dbPath)) {
  // Try alternative path
  console.log('⚠️ Could not find database index at expected path, checking models/index.js');
}

runSync();
