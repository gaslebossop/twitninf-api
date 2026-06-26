/**
 * 🚜 SCRIPT: Advanced Click Farm Simulator (V5.2 - Ultra Debug)
 * 
 * Simule une ferme à clicks intelligente avec logs d'erreurs détaillés.
 */

const axios = require('axios');

// CONFIGURATION
const TARGET_USERNAME = 'essayedemeban';
const TARGET_PASSWORD = 'myytre88';

// Helpers
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const randomRange = (min, max) => Math.floor(Math.random() * (max - min + 1) + min);

async function simulateBot() {
  console.log(`🚀 Démarrage de la simulation pour @${TARGET_USERNAME}...`);

  const baseUrl = 'https://twitninf.duckdns.org/api';
  let token = '';

  try {
    process.stdout.write(`🔍 Connexion à ${baseUrl}... `);
    const loginRes = await axios.post(`${baseUrl}/auth/login`, {
      username: TARGET_USERNAME,
      password: TARGET_PASSWORD
    }, {
      headers: { 'user-platform': 'ios' },
      timeout: 10000
    });

    token = loginRes.data.token || loginRes.data.data?.token;
    console.log('✅');
  } catch (e) {
    console.log(`❌\nErreur login: ${e.response?.data?.message || e.message}`);
    return;
  }

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'user-platform': 'ios'
  };

  try {
    console.log('📋 Récupération du feed...');
    const feedRes = await axios.get(`${baseUrl}/recommendations`, { headers });
    let tweets = feedRes.data.data?.recommendations || [];

    if (tweets.length === 0) {
      console.log('⚠️ Feed vide.');
      return;
    }

    tweets = tweets.sort(() => Math.random() - 0.5);
    console.log(`📸 ${tweets.length} tweets trouvés.`);
    while (true) {
      for (let i = 0; i < tweets.length; i++) {
        const tweetId = tweets[i].id;
        console.log(`\n📖 [${i + 1}/${tweets.length}] Tweet ${tweetId}`);

        try {
          // --- COMPORTEMENT CHAOTIQUE ALÉATOIRE ---
          const actionsToPerform = ['tweet_view'];
          if (Math.random() > 0.2) actionsToPerform.push('time_spent');
          if (Math.random() > 0.5) actionsToPerform.push('tweet_like');

          // On mélange l'ordre pour ne pas avoir toujours la même séquence
          actionsToPerform.sort(() => Math.random() - 0.5);

          for (const action of actionsToPerform) {
            if (action === 'tweet_view') {
              process.stdout.write(`  👀 Envoi tweet_view... `);
              await axios.post(`${baseUrl}/behavior/action`, {
                action_type: 'tweet_view',
                target_id: tweetId, target_type: 'tweet'
              }, { headers });
            } else if (action === 'time_spent') {
              const readingTime = randomRange(1, 4);
              process.stdout.write(`  ⏳ Envoi time_spent (${readingTime}s)... `);
              await axios.post(`${baseUrl}/behavior/action`, {
                action_type: 'time_spent',
                target_id: tweetId, target_type: 'tweet',
                context_data: { duration: readingTime }
              }, { headers });
            } else if (action === 'tweet_like') {
              process.stdout.write(`  ❤️ Envoi tweet_like... `);
              await axios.post(`${baseUrl}/behavior/tweet-interaction`, {
                tweet_id: tweetId, interaction_type: 'tweet_like'
              }, { headers });
            }
            console.log('✅');
            await sleep(randomRange(1000, 1000) * 5); // Micro-pause entre actions
          }

          const delay = randomRange(1000, 1000 * 5); // 0.8s à 3.8s entre tweets
          console.log(`⏳ Attente ${delay}ms...`);
          await sleep(delay);

        } catch (error) {
          if (error.response?.status === 400) {
            console.log(`❌ ERREUR 400: ${JSON.stringify(error.response.data)}`);
          } else if (error.response?.status === 403) {
            console.log(`\n🚫 BAN DÉTECTÉ: ${error.response.data.message}`);
            if (error.response.data.meta?.ai?.reasons) {
              console.log(`🧐 MOTIFS IA : ${error.response.data.meta.ai.reasons.join(', ')}`);
            }
            return;
          } else {
            console.log(`❌ Erreur: ${error.message}`);
          }
          await sleep(50);
        }
      }
    }
  } catch (error) {
    console.error('❌ Erreur critique:', error.response?.data || error.message);
  }
}

simulateBot();
