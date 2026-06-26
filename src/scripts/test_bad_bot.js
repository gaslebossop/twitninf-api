const axios = require('axios');
const crypto = require('crypto');

const baseUrl = 'https://twitninf.duckdns.org/api';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function startBadBot() {
    const username = `badbot_${crypto.randomBytes(3).toString('hex')}`;
    const password = 'password123';

    try {
        console.log(`🤖 [BAD BOT] Démarrage de la simulation pour @${username}...`);

        // 1. INSCRIPTION
        console.log('📝 Inscription...');
        const registerRes = await axios.post(`${baseUrl}/auth/register`, {
            username,
            password,
            password_confirmation: password,
            email: `${username}@example.com`,
            fullName: 'Méchant Bot'
        });
        const token = registerRes.data.token || registerRes.data.data?.token;
        if (!token) {
            console.error('❌ Erreur: Token absent');
            return;
        }
        const headers = { 'Authorization': `Bearer ${token}` };
        console.log('✅ Compte créé avec succès.');

        // 2. RÉCUPÉRATION DU PROFIL CIBLE (policiercongo)
        console.log('🔍 Recherche du compte cible (@policiercongo)...');
        const profileRes = await axios.get(`${baseUrl}/users/profile/policiercongo`);
        const targetUserId = profileRes.data.data?.user?.id;

        if (!targetUserId) {
            console.error('❌ Impossible de trouver le profil @policiercongo');
            return;
        }

        // 3. RÉCUPÉRATION DES TWEETS DE LA CIBLE
        console.log(`📋 Récupération des tweets de l'utilisateur ${targetUserId}...`);
        const tweetsRes = await axios.get(`${baseUrl}/users/${targetUserId}/tweets?limit=100`, { headers });
        const tweets = tweetsRes.data.data?.tweets || [];
        console.log(`📸 ${tweets.length} tweets trouvés pour @policiercongo.`);

        if (tweets.length === 0) {
            console.log('⚠️ Aucun tweet à liker.');
            return;
        }

        // 4. BOURRINAGE FURTIF (view avant like, scrolls intercalés, délais variés)
        console.log(`\n🕵️ Début du bourrinage FURTIF (view+scroll+like, délais variés)...`);
        const numLikes = Math.min(10, tweets.length);

        for (let i = 0; i < numLikes; i++) {
            const targetTweet = tweets[i];

            // -- VIEW d'abord (comme un humain qui scrolle son feed) --
            process.stdout.write(`[${i + 1}/${numLikes}] 👀 tweet_view ${targetTweet.id.substring(0, 8)}... `);
            try {
                await axios.post(`${baseUrl}/behavior/tweet-interaction`, {
                    tweet_id: targetTweet.id,
                    interaction_type: 'tweet_view'
                }, { headers });
                console.log('✅');
            } catch (e) {
                if (e.response?.status === 403) { console.log(`\n🚫 BAN (view): ${e.response.data.message}`); return; }
                console.log(`❌ ${e.response?.data?.message || e.message}`);
            }
            await sleep(1500 + Math.random() * 2000); // 1.5s - 3.5s

            // -- SCROLL aléatoire (1 fois sur 2) --
            if (Math.random() > 0.5) {
                process.stdout.write(`       📜 scroll_50... `);
                try {
                    await axios.post(`${baseUrl}/behavior/action`, {
                        action_type: 'scroll_50',
                        target_id: targetTweet.id
                    }, { headers });
                    console.log('✅');
                } catch (e) {
                    if (e.response?.status === 403) { console.log(`\n🚫 BAN (scroll): ${e.response.data.message}`); return; }
                    console.log(`❌`);
                }
                await sleep(800 + Math.random() * 1200);
            }

            // -- TIME SPENT (2 fois sur 3) --
            if (Math.random() > 0.33) {
                const seconds = Math.floor(2 + Math.random() * 4);
                process.stdout.write(`       ⏳ time_spent ${seconds}s... `);
                try {
                    await axios.post(`${baseUrl}/behavior/action`, {
                        action_type: 'time_spent',
                        target_id: targetTweet.id,
                        duration: seconds
                    }, { headers });
                    console.log('✅');
                } catch (e) {
                    if (e.response?.status === 403) { console.log(`\n🚫 BAN (time): ${e.response.data.message}`); return; }
                    console.log(`❌`);
                }
                await sleep(500 + Math.random() * 800);
            }

            // -- LIKE (l'objectif final) --
            process.stdout.write(`       ❤️  tweet_like ${targetTweet.id.substring(0, 8)}... `);
            try {
                await axios.post(`${baseUrl}/behavior/tweet-interaction`, {
                    tweet_id: targetTweet.id,
                    interaction_type: 'tweet_like'
                }, { headers });
                console.log('✅');
            } catch (postErr) {
                if (postErr.response?.status === 403) {
                    console.log(`\n🚫 BAN DÉTECTÉ !! : ${postErr.response.data.message}`);
                    if (postErr.response.data.meta?.ai?.reasons) {
                        console.log(`🧐 MOTIFS IA : ${postErr.response.data.meta.ai.reasons.join(', ')}`);
                    }
                    return;
                } else {
                    console.log(`❌ Erreur: ${postErr.response?.data?.message || postErr.message}`);
                }
            }

            // Délai humain variable entre chaque tweet (4s - 9s)
            const delay = 4000 + Math.random() * 5000;
            console.log(`       💤 Pause ${(delay / 1000).toFixed(1)}s...`);
            await sleep(delay);
        }

        console.log('\n❌ Le bot a fini son exécution sans être banni !');

    } catch (error) {
        console.error('❌ Erreur critique:', error.response?.data || error.message);
    }
}

startBadBot();
