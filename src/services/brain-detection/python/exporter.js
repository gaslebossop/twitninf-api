/**
 * 📦 BotBrain Python : Data Exporter
 * 
 * Exporte l'intégralité de la table UserBehaviorData en JSON
 * pour l'entraînement du modèle Python.
 */

const { UserBehaviorData } = require('../../../models');
const fs = require('fs');
const path = require('path');

async function exportData() {
    console.log('📡 Récupération des données depuis la base de données...');
    
    try {
        const count = await UserBehaviorData.count();
        console.log(`📊 ${count} enregistrements trouvés. Exportation en cours...`);
        
        // On récupère tout
        const data = await UserBehaviorData.findAll({
            attributes: ['user_id', 'action_type', 'target_id', 'timestamp'],
            order: [['user_id', 'ASC'], ['timestamp', 'ASC']],
            raw: true
        });

        const outputPath = path.join(__dirname, 'human_data.json');
        fs.writeFileSync(outputPath, JSON.stringify(data, null, 2));
        
        console.log(`✅ Exportation terminée : ${outputPath}`);
    } catch (error) {
        console.error('❌ Erreur d\'exportation:', error);
    }
}

exportData().then(() => process.exit(0));
