const UserSimilarityService = require('../src/services/userSimilarityService');

async function test() {
    const userId = 'd76b9a1c-9c59-4936-8251-fc02592503d4'; // gas
    console.log(`🧪 Test de similarité pour l'utilisateur: gas (${userId})`);

    try {
        const similarUsers = await UserSimilarityService.findSimilarUsers(userId, 5);
        
        if (similarUsers.length === 0) {
            console.log('⚠️ Aucun utilisateur similaire trouvé. L\'index est peut-être vide ou "gas" n\'a pas assez d\'interactions.');
            
            // Check stats
            const stats = UserSimilarityService.getStats();
            console.log('📊 Stats de l\'index:', stats);
            return;
        }

        console.log(`✅ ${similarUsers.length} utilisateurs similaires trouvés :`);
        similarUsers.forEach((u, i) => {
            console.log(`${i + 1}. @${u.username} (Score: ${(u.similarity_score * 100).toFixed(1)}%)`);
        });

    } catch (err) {
        console.error('❌ Erreur pendant le test:', err.message);
    }
}

test();
