const bcrypt = require('bcryptjs');
const { sequelize } = require('../database');
const User = require('../models/User');
const logger = require('../utils/logger');

async function createAdminUser() {
  try {
    // Vérifier la connexion à la base de données
    await sequelize.authenticate();
    logger.info('Connexion à la base de données établie');

    // Vérifier si l'admin existe déjà
    const existingAdmin = await User.findOne({
      where: { username: 'admin' }
    });

    if (existingAdmin) {
      logger.info('L\'utilisateur admin existe déjà');
      return;
    }

    // Créer le mot de passe hashé
    const salt = await bcrypt.genSalt(12);
    const hashedPassword = await bcrypt.hash('admin123', salt);

    // Créer l'utilisateur admin
    const adminUser = await User.create({
      username: 'admin',
      full_name: 'Administrateur Principal',
      email: 'admin@twitnin.com',
      password: hashedPassword,
      platform: 'web',
      verified: true,
      premium: true,
      role: 'superadmin',
      moderation_permissions: {
        can_ban_users: true,
        can_suspend_users: true,
        can_delete_tweets: true,
        can_verify_users: true,
        can_view_reports: true,
        can_view_analytics: true,
        can_manage_moderators: true
      },
      stats: {
        followers: 0,
        following: 0,
        tweets: 0,
        likes: 0
      },
      preferences: {
        language: 'fr',
        theme: 'dark',
        notifications: {
          push: true,
          email: true,
          sms: false
        }
      }
    });

    logger.info('Utilisateur admin créé avec succès:', {
      id: adminUser.id,
      username: adminUser.username,
      role: adminUser.role
    });

    console.log('✅ Utilisateur admin créé avec succès!');
    console.log('📧 Email: admin@twitnin.com');
    console.log('🔑 Mot de passe: admin123');
    console.log('👑 Rôle: superadmin');

  } catch (error) {
    logger.error('Erreur lors de la création de l\'utilisateur admin:', error);
    console.error('❌ Erreur:', error.message);
  } finally {
    await sequelize.close();
  }
}

// Exécuter le script si appelé directement
if (require.main === module) {
  createAdminUser();
}

module.exports = createAdminUser;
