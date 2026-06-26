/**
 * 🕹️ SIMULATOR: Bot vs Human v5.0 (The Ultimate Test)
 */

const BehaviorDataCollector = require('c:\\Users\\nouno\\OneDrive\\Bureau\\IAFILTRE\\api\\src\\services\\behaviorDataCollector');
const BotDetectionService = require('c:\\Users\\nouno\\OneDrive\\Bureau\\IAFILTRE\\api\\src\\services\\BotDetectionService');
const { User, UserBehaviorData, sequelize } = require('c:\\Users\\nouno\\OneDrive\\Bureau\\IAFILTRE\\api\\src\\models');

async function simulate(name, type, userId) {
    console.log(`\n🚀 [SIMULATION] Démarrage simulation pour: ${name} (${type})`);
    const collector = new BehaviorDataCollector();
    const baseTime = Date.now();
    
    // Nettoyer les anciennes actions pour le test
    await UserBehaviorData.destroy({ where: { user_id: userId } });

    let actions = [];
    if (type === 'FAST_BOT') {
        // Rafale extrême (10 actions en 500ms)
        const targetId = 'e814cc33-c213-4e1b-aa20-1967e19a0a4f';
        for(let i=0; i<15; i++) {
            actions.push({ type: 'tweet_like', target: targetId, delay: i * 30 }); // 30ms entre chaque
        }
    } else if (type === 'STEALTH_BOT') {
        const targetId = 'f825dd44-d324-5f2c-bb31-2078f20b1b5e';
        // Bot lent mais régulier, sans signaux humains
        for(let i=0; i<10; i++) {
            actions.push({ type: 'tweet_like', target: targetId, delay: i * 2000 }); // Toutes les 2s pile
        }
    } else {
        const targetId = 'a1b2c3d4-e5f6-4a5b-bc6d-7e8f9a0b1c2d';
        // HUMAIN
        for(let i=0; i<8; i++) {
            actions.push({ 
                type: 'tweet_view', 
                target: targetId, 
                delay: i * 3000 + Math.random() * 2000, // Délais aléatoires
                context: { duration_ms: Math.round(200 + Math.random() * 300) }
            });
            actions.push({ 
                type: 'tap_gesture', 
                target: targetId, 
                delay: i * 3000 + 100, 
                context: { duration_ms: Math.round(80 + Math.random() * 100) } // Taps variables
            });
            actions.push({
                type: 'device_motion_noise',
                target: 'app',
                delay: i * 3000 + 500,
                context: { variance: Number((0.02 + Math.random() * 0.05).toFixed(4)) } // Tremblement
            });
        }
    }

    // Injection des actions
    for (const a of actions) {
        await collector.recordUserAction(
            userId, 
            a.type, 
            a.target, 
            'tweet', 
            { client_timestamp: new Date(baseTime + a.delay).toISOString(), ...(a.context || {}) }
        );
    }

    // Lancement de la détection
    console.log(`🔍 Analyse du comportement de ${name}...`);
    const result = await BotDetectionService.analyzeAndSanction(userId);
    
    console.log(`🏁 RESULTAT ${name}:`);
    console.log(`   - isBot: ${result.isBot}`);
    console.log(`   - Score: ${result.score || 0}%`);
    console.log(`   - Raisons: ${result.reasons?.join(', ') || 'N/A'}`);
    
    return result;
}

async function runAll() {
    try {
        const user = await User.findOne();
        if(!user) return;

        await simulate("Robot-Rafale", "FAST_BOT", user.id);
        await simulate("Robot-Discret", "STEALTH_BOT", user.id);
        await simulate("Humain-Variable", "HUMAN", user.id);

    } catch (e) {
        console.error(e);
    } finally {
        console.log('\n⏳ Attente de la fin des traitements asynchrones...');
        await new Promise(r => setTimeout(r, 3000));
        await sequelize.close();
        console.log('✅ Connexion DB fermée.');
    }
}

runAll();
