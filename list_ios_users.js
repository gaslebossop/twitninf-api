/**
 * Script de liste des utilisateurs possédant le badge iOS natif
 * 
 * Ce script interroge la base de données pour lister tous les utilisateurs
 * ayant été détectés sur l'application iOS native.
 *
 * Utilisation :
 * node list_ios_users.js
 */

require('dotenv').config();
const { User } = require('./src/models');
const { Op } = require('sequelize');

async function listIosUsers() {
  console.log('--- 🍎 Liste des utilisateurs iOS natifs ---');
  
  try {
    console.log('🔍 Recherche des utilisateurs avec le badge is_ios_native...');
    
    const users = await User.findAll({
      where: {
        is_ios_native: true
      },
      attributes: ['id', 'username', 'full_name', 'email', 'last_activity', 'created_at'],
      order: [['last_activity', 'DESC']]
    });

    if (users.length === 0) {
      console.log('ℹ️  Aucun utilisateur n\'a encore été détecté sur l\'application iOS native.');
      process.exit(0);
    }

    console.log(`✅ ${users.length} utilisateur(s) trouvé(s) :\n`);
    
    // Affichage sous forme de tableau simple
    console.log('--------------------------------------------------------------------------------');
    console.log('| Username         | Nom Complet          | Dernière Activité    | Date Création |');
    console.log('--------------------------------------------------------------------------------');
    
    users.forEach(user => {
      const username = user.username.padEnd(16).substring(0, 16);
      const fullName = (user.full_name || 'N/A').padEnd(20).substring(0, 20);
      const lastActivity = user.last_activity ? new Date(user.last_activity).toLocaleDateString() : 'Jamais';
      const createdAt = new Date(user.created_at).toLocaleDateString();
      
      console.log(`| @${username} | ${fullName} | ${lastActivity.padEnd(20)} | ${createdAt.padEnd(13)} |`);
    });
    
    console.log('--------------------------------------------------------------------------------');
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Une erreur est survenue :', error);
    process.exit(1);
  }
}

listIosUsers();
