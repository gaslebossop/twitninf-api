const axios = require('axios');
const crypto = require('crypto');

const baseUrl = 'https://twitninf.duckdns.org/api';

async function testBasicFlow() {
  const username = `user_${crypto.randomBytes(3).toString('hex')}`;
  const password = 'password123';

  try {
    console.log(`🚀 Démarrage du flux basique pour @${username}...`);

    // 1. INSCRIPTION
    console.log('📝 Inscription...');
    const registerRes = await axios.post(`${baseUrl}/auth/register`, {
      username,
      password,
      password_confirmation: password,
      email: `${username}@example.com`,
      fullName: 'Test User Flux'
    });
    const token = registerRes.data.token || registerRes.data.data?.token;
    if (!token) {
        console.error('❌ Erreur: Token absent de la réponse', registerRes.data);
        return;
    }
    const headers = { 'Authorization': `Bearer ${token}` };
    console.log('✅ Compte créé.');

    // 2. RÉCUPÉRATION DU FEED
    console.log('📋 Lecture du fil...');
    const feedRes = await axios.get(`${baseUrl}/tweets`, { headers });
    // Structure réelle : feedRes.data.data.tweets
    const tweets = feedRes.data.data?.tweets || [];
    console.log(`✅ ${tweets.length} tweets chargés.`);

    // 3. POSTER UN TWEET
    console.log('✍️ Publication d\'un tweet...');
    await axios.post(`${baseUrl}/tweets`, {
      content: 'Ceci est un test de flux basique sans comportement complexe ! #AI #Test'
    }, { headers });
    console.log('✅ Tweet posté.');

    if (tweets.length > 0) {
      console.log(`\n⏳ Début de la phase d'interactions directes (Likes uniquement)...`);
      
      for (let i = 1; i <= 21; i++) {
        const targetTweet = tweets[Math.floor(Math.random() * tweets.length)];
        
        process.stdout.write(`[${i}/21] Envoi du LIKE sur tweet ${targetTweet.id.substring(0,8)}... `);
        
        await axios.post(`${baseUrl}/behavior/tweet-interaction`, {
          tweet_id: targetTweet.id,
          interaction_type: 'tweet_like'
        }, { headers });
        
        console.log('✅');
        
        // Délai humain : 3s à 7s
        const sleepTime = Math.floor(Math.random() * 4000) + 3000;
        await new Promise(resolve => setTimeout(resolve, sleepTime));
      }
    }

    console.log('\n✨ Test de Like direct terminé !');

  } catch (error) {
    console.error('❌ Erreur:', error.response?.data || error.message);
  }
}

testBasicFlow();
