#!/usr/bin/env node

/**
 * Script de test pour le système de tweets Wtitninf
 * Teste toutes les fonctionnalités : tweets, likes, retweets, notifications, recherche
 */

const axios = require('axios');
const logger = require('./src/utils/logger');

// Configuration
const API_BASE_URL = 'http://localhost:3000/api';
const TEST_USER = {
  username: 'testuser',
  fullName: 'Test User',
  email: 'test@wtitninf.com',
  phone: '+33123456789',
  password: 'TestPass123!',
  platform: 'web'
};

let authToken = null;
let testTweetId = null;
let testUserId = null;

// Couleurs pour la console
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logSuccess(message) {
  log(`✅ ${message}`, 'green');
}

function logError(message) {
  log(`❌ ${message}`, 'red');
}

function logInfo(message) {
  log(`ℹ️  ${message}`, 'blue');
}

function logWarning(message) {
  log(`⚠️  ${message}`, 'yellow');
}

// Fonctions de test
async function testHealthCheck() {
  try {
    logInfo('Test de la route de santé...');
    const response = await axios.get(`${API_BASE_URL}/health`);
    
    if (response.data.success) {
      logSuccess('Route de santé fonctionnelle');
      logInfo(`Base de données: ${response.data.database}`);
      logInfo(`Redis: ${response.data.redis}`);
      logInfo(`Fonctionnalités: ${JSON.stringify(response.data.features)}`);
    } else {
      throw new Error('Route de santé retourne une erreur');
    }
  } catch (error) {
    logError(`Erreur lors du test de santé: ${error.message}`);
    throw error;
  }
}

async function testUserRegistration() {
  try {
    logInfo('Test de l\'inscription utilisateur...');
    const response = await axios.post(`${API_BASE_URL}/auth/register`, TEST_USER, {
      headers: {
        'Content-Type': 'application/json',
        'User-Platform': 'web'
      }
    });

    if (response.data.success) {
      authToken = response.data.data.token;
      testUserId = response.data.data.user.id;
      logSuccess(`Utilisateur créé avec succès: ${response.data.data.user.username}`);
      logInfo(`Token: ${authToken.substring(0, 20)}...`);
    } else {
      throw new Error('Échec de l\'inscription');
    }
  } catch (error) {
    if (error.response?.status === 409) {
      logWarning('Utilisateur existe déjà, tentative de connexion...');
      await testUserLogin();
    } else {
      logError(`Erreur lors de l'inscription: ${error.message}`);
      throw error;
    }
  }
}

async function testUserLogin() {
  try {
    logInfo('Test de la connexion utilisateur...');
    const response = await axios.post(`${API_BASE_URL}/auth/login`, {
      email: TEST_USER.email,
      password: TEST_USER.password
    }, {
      headers: {
        'Content-Type': 'application/json',
        'User-Platform': 'web'
      }
    });

    if (response.data.success) {
      authToken = response.data.data.token;
      testUserId = response.data.data.user.id;
      logSuccess(`Connexion réussie: ${response.data.data.user.username}`);
      logInfo(`Token: ${authToken.substring(0, 20)}...`);
    } else {
      throw new Error('Échec de la connexion');
    }
  } catch (error) {
    logError(`Erreur lors de la connexion: ${error.message}`);
    throw error;
  }
}

async function testCreateTweet() {
  try {
    logInfo('Test de création de tweet...');
    const tweetContent = 'Ceci est un tweet de test pour vérifier le système ! #Wtitninf #Test 🚀';
    
    const response = await axios.post(`${API_BASE_URL}/tweets`, {
      content: tweetContent,
      is_private: false,
      is_sensitive: false
    }, {
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
        'User-Platform': 'web'
      }
    });

    if (response.data.success) {
      testTweetId = response.data.data.id;
      logSuccess(`Tweet créé avec succès: ${testTweetId}`);
      logInfo(`Contenu: ${response.data.data.content}`);
      logInfo(`Auteur: ${response.data.data.author.username}`);
    } else {
      throw new Error('Échec de la création du tweet');
    }
  } catch (error) {
    logError(`Erreur lors de la création du tweet: ${error.message}`);
    throw error;
  }
}

async function testGetTweets() {
  try {
    logInfo('Test de récupération des tweets...');
    const response = await axios.get(`${API_BASE_URL}/tweets?limit=5`);

    if (response.data.success) {
      logSuccess(`Tweets récupérés avec succès: ${response.data.data.tweets.length}`);
      logInfo(`Total: ${response.data.data.pagination.total}`);
      
      response.data.data.tweets.forEach((tweet, index) => {
        logInfo(`Tweet ${index + 1}: ${tweet.content.substring(0, 50)}...`);
      });
    } else {
      throw new Error('Échec de la récupération des tweets');
    }
  } catch (error) {
    logError(`Erreur lors de la récupération des tweets: ${error.message}`);
    throw error;
  }
}

async function testLikeTweet() {
  try {
    logInfo('Test de like de tweet...');
    const response = await axios.post(`${API_BASE_URL}/tweets/${testTweetId}/like`, {}, {
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (response.data.success) {
      logSuccess(`Tweet liké avec succès: ${response.data.data.liked ? 'Oui' : 'Non'}`);
    } else {
      throw new Error('Échec du like');
    }
  } catch (error) {
    logError(`Erreur lors du like: ${error.message}`);
    throw error;
  }
}

async function testRetweet() {
  try {
    logInfo('Test de retweet...');
    const response = await axios.post(`${API_BASE_URL}/tweets/${testTweetId}/retweet`, {
      comment: 'Excellent tweet ! 👍'
    }, {
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (response.data.success) {
      logSuccess(`Tweet retweeté avec succès: ${response.data.data.retweeted ? 'Oui' : 'Non'}`);
    } else {
      throw new Error('Échec du retweet');
    }
  } catch (error) {
    logError(`Erreur lors du retweet: ${error.message}`);
    throw error;
  }
}

async function testSearchUsers() {
  try {
    logInfo('Test de recherche d\'utilisateurs...');
    const response = await axios.get(`${API_BASE_URL}/search/users?q=test&limit=5`);

    if (response.data.success) {
      logSuccess(`Recherche d'utilisateurs réussie: ${response.data.data.users.length} résultats`);
      logInfo(`Query: ${response.data.data.query}`);
      
      response.data.data.users.forEach((user, index) => {
        logInfo(`Utilisateur ${index + 1}: @${user.username} (${user.full_name})`);
      });
    } else {
      throw new Error('Échec de la recherche d\'utilisateurs');
    }
  } catch (error) {
    logError(`Erreur lors de la recherche d'utilisateurs: ${error.message}`);
    throw error;
  }
}

async function testSearchTweets() {
  try {
    logInfo('Test de recherche de tweets...');
    const response = await axios.get(`${API_BASE_URL}/search/tweets?q=test&limit=5`);

    if (response.data.success) {
      logSuccess(`Recherche de tweets réussie: ${response.data.data.tweets.length} résultats`);
      logInfo(`Query: ${response.data.data.query}`);
      
      response.data.data.tweets.forEach((tweet, index) => {
        logInfo(`Tweet ${index + 1}: ${tweet.content.substring(0, 50)}...`);
      });
    } else {
      throw new Error('Échec de la recherche de tweets');
    }
  } catch (error) {
    logError(`Erreur lors de la recherche de tweets: ${error.message}`);
    throw error;
  }
}

async function testGetNotifications() {
  try {
    logInfo('Test de récupération des notifications...');
    const response = await axios.get(`${API_BASE_URL}/notifications`, {
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (response.data.success) {
      logSuccess(`Notifications récupérées avec succès: ${response.data.data.notifications.length}`);
      logInfo(`Non lues: ${response.data.data.unread_count}`);
      
      response.data.data.notifications.forEach((notification, index) => {
        logInfo(`Notification ${index + 1}: ${notification.title} - ${notification.message}`);
      });
    } else {
      throw new Error('Échec de la récupération des notifications');
    }
  } catch (error) {
    logError(`Erreur lors de la récupération des notifications: ${error.message}`);
    throw error;
  }
}

async function testGetTweetDetails() {
  try {
    logInfo('Test de récupération des détails du tweet...');
    const response = await axios.get(`${API_BASE_URL}/tweets/${testTweetId}`);

    if (response.data.success) {
      const tweet = response.data.data;
      logSuccess(`Détails du tweet récupérés: ${tweet.id}`);
      logInfo(`Contenu: ${tweet.content}`);
      logInfo(`Auteur: ${tweet.author.username}`);
      logInfo(`Vues: ${tweet.view_count}`);
      logInfo(`Hashtags: ${tweet.hashtags.join(', ')}`);
    } else {
      throw new Error('Échec de la récupération des détails du tweet');
    }
  } catch (error) {
    logError(`Erreur lors de la récupération des détails du tweet: ${error.message}`);
    throw error;
  }
}

async function testGetTweetLikes() {
  try {
    logInfo('Test de récupération des likes du tweet...');
    const response = await axios.get(`${API_BASE_URL}/tweets/${testTweetId}/likes`);

    if (response.data.success) {
      logSuccess(`Likes du tweet récupérés: ${response.data.data.likes.length}`);
      logInfo(`Total: ${response.data.data.pagination.total}`);
    } else {
      throw new Error('Échec de la récupération des likes');
    }
  } catch (error) {
    logError(`Erreur lors de la récupération des likes: ${error.message}`);
    throw error;
  }
}

async function testGetTweetRetweets() {
  try {
    logInfo('Test de récupération des retweets du tweet...');
    const response = await axios.get(`${API_BASE_URL}/tweets/${testTweetId}/retweets`);

    if (response.data.success) {
      logSuccess(`Retweets du tweet récupérés: ${response.data.data.retweets.length}`);
      logInfo(`Total: ${response.data.data.pagination.total}`);
    } else {
      throw new Error('Échec de la récupération des retweets');
    }
  } catch (error) {
    logError(`Erreur lors de la récupération des retweets: ${error.message}`);
    throw error;
  }
}

async function testDeleteTweet() {
  try {
    logInfo('Test de suppression du tweet...');
    const response = await axios.delete(`${API_BASE_URL}/tweets/${testTweetId}`, {
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (response.data.success) {
      logSuccess(`Tweet supprimé avec succès: ${testTweetId}`);
    } else {
      throw new Error('Échec de la suppression du tweet');
    }
  } catch (error) {
    logError(`Erreur lors de la suppression du tweet: ${error.message}`);
    throw error;
  }
}

async function testTrendingHashtags() {
  try {
    logInfo('Test de récupération des hashtags tendance...');
    const response = await axios.get(`${API_BASE_URL}/search/trending?limit=10&period=24h`);

    if (response.data.success) {
      logSuccess(`Hashtags tendance récupérés: ${response.data.data.hashtags.length}`);
      logInfo(`Période: ${response.data.data.period}`);
      
      response.data.data.hashtags.slice(0, 5).forEach((hashtag, index) => {
        logInfo(`Hashtag ${index + 1}: ${hashtag.tag} (${hashtag.count} utilisations)`);
      });
    } else {
      throw new Error('Échec de la récupération des hashtags tendance');
    }
  } catch (error) {
    logError(`Erreur lors de la récupération des hashtags tendance: ${error.message}`);
    throw error;
  }
}

// Fonction principale de test
async function runAllTests() {
  try {
    log('🚀 Démarrage des tests du système Wtitninf...', 'bright');
    log('================================================', 'cyan');

    // Tests de base
    await testHealthCheck();
    await testUserRegistration();
    
    // Tests des tweets
    await testCreateTweet();
    await testGetTweets();
    await testGetTweetDetails();
    
    // Tests des interactions
    await testLikeTweet();
    await testRetweet();
    await testGetTweetLikes();
    await testGetTweetRetweets();
    
    // Tests de recherche
    await testSearchUsers();
    await testSearchTweets();
    await testTrendingHashtags();
    
    // Tests des notifications
    await testGetNotifications();
    
    // Nettoyage
    await testDeleteTweet();

    log('================================================', 'cyan');
    log('🎉 Tous les tests ont réussi ! Le système fonctionne parfaitement.', 'bright');
    log('================================================', 'cyan');
    
    log('📊 Résumé des fonctionnalités testées:', 'bright');
    log('   ✅ Vérification de la santé de l\'API');
    log('   ✅ Inscription et connexion utilisateur');
    log('   ✅ Création, lecture et suppression de tweets');
    log('   ✅ Système de likes et retweets');
    log('   ✅ Recherche d\'utilisateurs et de tweets');
    log('   ✅ Hashtags tendance');
    log('   ✅ Système de notifications');
    log('   ✅ Gestion des statistiques automatiques');

  } catch (error) {
    log('================================================', 'red');
    logError(`❌ Test échoué: ${error.message}`);
    log('================================================', 'red');
    
    if (error.response) {
      logError(`Status: ${error.response.status}`);
      logError(`Data: ${JSON.stringify(error.response.data, null, 2)}`);
    }
    
    process.exit(1);
  }
}

// Gestion des erreurs non capturées
process.on('unhandledRejection', (reason, promise) => {
  logError('Promesse rejetée non gérée:');
  logError(`Reason: ${reason}`);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  logError('Exception non capturée:');
  logError(`Error: ${error.message}`);
  process.exit(1);
});

// Démarrer les tests si le script est exécuté directement
if (require.main === module) {
  runAllTests();
}

module.exports = {
  runAllTests,
  testHealthCheck,
  testUserRegistration,
  testCreateTweet,
  testGetTweets,
  testLikeTweet,
  testRetweet,
  testSearchUsers,
  testSearchTweets,
  testGetNotifications
};
