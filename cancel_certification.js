/**
 * Script de suppression/annulation des demandes de certification
 * 
 * Ce script est interactif et permet de supprimer toutes les demandes
 * de certification pour un utilisateur spécifique.
 *
 * Utilisation :
 * node cancel_certification.js
 */

require('dotenv').config();
const { User, VerificationRequest } = require('./src/models');
const { Op } = require('sequelize');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function askQuestion(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

async function cancelCertification() {
  console.log('--- Script d\'annulation de certification ---');
  
  const identifier = await askQuestion('Entrez le username, l\'email ou l\'ID de l\'utilisateur : ');

  if (!identifier) {
    console.error('❌ Erreur: L\'identifiant est requis.');
    rl.close();
    process.exit(1);
  }

  try {
    console.log(`🔍 Recherche de l'utilisateur: ${identifier}...`);
    
    // Rechercher l'utilisateur
    const user = await User.findOne({
      where: {
        [Op.or]: [
          { id: identifier.length === 36 ? identifier : null },
          { username: identifier },
          { email: identifier }
        ]
      }
    });

    if (!user) {
      console.error(`❌ Utilisateur non trouvé avec l'identifiant: ${identifier}`);
      rl.close();
      process.exit(1);
    }

    console.log(`👤 Utilisateur trouvé: @${user.username} (${user.id})`);
    
    const confirm = await askQuestion(`Êtes-vous sûr de vouloir annuler TOUTES les demandes de certification pour @${user.username} ? (y/n) : `);
    
    if (confirm.toLowerCase() !== 'y' && confirm.toLowerCase() !== 'o') {
      console.log('🛑 Opération annulée.');
      rl.close();
      process.exit(0);
    }

    // 1. Supprimer les demandes de vérification
    console.log(`🗑️  Suppression des demandes de vérification...`);
    const deletedCount = await VerificationRequest.destroy({
      where: { user_id: user.id }
    });
    console.log(`✅ ${deletedCount} demande(s) de vérification supprimée(s).`);

    // 2. Mettre à jour le profil utilisateur (enlever le badge si présent)
    console.log(`🔄 Mise à jour du profil utilisateur...`);
    await user.update({
      verified: false,
      verification_style: 'default',
      metadata: {
        ...(user.metadata || {}),
        verification: null
      }
    });
    
    console.log(`✅ Profil mis à jour. Badge retiré pour @${user.username}.`);
    console.log(`🎉 Succès ! Toutes les demandes ont été annulées.`);
    
    rl.close();
    process.exit(0);
  } catch (error) {
    console.error('❌ Une erreur est survenue :', error);
    rl.close();
    process.exit(1);
  }
}

cancelCertification();
