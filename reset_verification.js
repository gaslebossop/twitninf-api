/**
 * Script de réinitialisation des demandes de vérification
 * 
 * Ce script permet de :
 * 1. Supprimer toutes les demandes de vérification d'un utilisateur
 * 2. Retirer son badge vérifié
 * 3. Réinitialiser ses métadonnées de vérification
 *
 * Utilisation depuis le dossier api :
 * node reset_verification.js <username_ou_email_ou_id>
 */

require('dotenv').config();
const { User, VerificationRequest } = require('./src/models');
const { Op } = require('sequelize');

async function resetVerification(identifier) {
  if (!identifier) {
    console.error('❌ Erreur: Veuillez fournir un identifiant (username, email ou ID)');
    console.log('💡 Utilisation: node reset_verification.js <username_ou_email_ou_id>');
    process.exit(1);
  }

  try {
    console.log(`🔍 Recherche de l'utilisateur: ${identifier}...`);
    
    // Rechercher l'utilisateur par ID, username ou email
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
      process.exit(1);
    }

    console.log(`👤 Utilisateur trouvé: @${user.username} (${user.id})`);

    // 1. Supprimer les demandes de vérification existantes
    console.log(`🗑️  Suppression des demandes de vérification...`);
    const deletedCount = await VerificationRequest.destroy({
      where: { user_id: user.id }
    });
    console.log(`✅ ${deletedCount} demande(s) de vérification supprimée(s).`);

    // 2. Mettre à jour le profil utilisateur
    console.log(`🔄 Réinitialisation du profil utilisateur...`);
    await user.update({
      verified: false,
      verification_style: 'default',
      // On peut aussi réinitialiser metadata.verification si on veut être exhaustif
      metadata: {
        ...(user.metadata || {}),
        verification: null
      }
    });
    
    console.log(`✅ Badge de vérification retiré pour @${user.username}.`);
    console.log(`🎉 Réinitialisation terminée avec succès ! L'utilisateur peut refaire une demande.`);
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Une erreur est survenue lors de la réinitialisation:', error);
    process.exit(1);
  }
}

// Récupérer l'argument de la ligne de commande
const targetIdentifier = process.argv[2];
resetVerification(targetIdentifier);
