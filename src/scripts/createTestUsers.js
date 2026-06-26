const bcrypt = require('bcryptjs');
const { sequelize } = require('../database');
const User = require('../models/User');
const logger = require('../utils/logger');

async function createTestUsers() {
  try {
    // Vérifier la connexion à la base de données
    await sequelize.authenticate();
    logger.info('Connexion à la base de données établie');

    const testUsers = [
      {
        username: 'moderateur',
        full_name: 'Modérateur Test',
        email: 'moderateur@test.com',
        password: 'mod123',
        role: 'moderator',
        moderation_permissions: {
          can_ban_users: false,
          can_suspend_users: true,
          can_delete_tweets: true,
          can_verify_users: false,
          can_view_reports: true,
          can_view_analytics: false,
          can_manage_moderators: false
        }
      },
      {
        username: 'admin_test',
        full_name: 'Admin Test',
        email: 'admin@test.com',
        password: 'admin123',
        role: 'admin',
        moderation_permissions: {
          can_ban_users: true,
          can_suspend_users: true,
          can_delete_tweets: true,
          can_verify_users: true,
          can_view_reports: true,
          can_view_analytics: true,
          can_manage_moderators: true
        }
      },
      {
        username: 'classeur',
        full_name: 'Classeur de Tweets',
        email: 'classeur@test.com',
        password: 'class123',
        role: 'classeurdetweets',
        moderation_permissions: {
          can_ban_users: false,
          can_suspend_users: false,
          can_delete_tweets: true,
          can_verify_users: false,
          can_view_reports: false,
          can_view_analytics: false,
          can_manage_moderators: false
        }
      },
      {
        username: 'user_normal',
        full_name: 'Utilisateur Normal',
        email: 'user@test.com',
        password: 'user123',
        role: 'user',
        moderation_permissions: {
          can_ban_users: false,
          can_suspend_users: false,
          can_delete_tweets: false,
          can_verify_users: false,
          can_view_reports: false,
          can_view_analytics: false,
          can_manage_moderators: false
        }
      }
    ];

    for (const userData of testUsers) {
      // Vérifier si l'utilisateur existe déjà
      const existingUser = await User.findOne({
        where: { username: userData.username }
      });

      if (existingUser) {
        logger.info(`L'utilisateur ${userData.username} existe déjà`);
        continue;
      }

      // Créer le mot de passe hashé
      const salt = await bcrypt.genSalt(12);
      const hashedPassword = await bcrypt.hash(userData.password, salt);

      // Créer l'utilisateur
      const user = await User.create({
        username: userData.username,
        full_name: userData.full_name,
        email: userData.email,
        password: hashedPassword,
        platform: 'web',
        verified: true,
        premium: true,
        role: userData.role,
        moderation_permissions: userData.moderation_permissions,
        stats: {
          followers: Math.floor(Math.random() * 1000),
          following: Math.floor(Math.random() * 500),
          tweets: Math.floor(Math.random() * 100),
          likes: Math.floor(Math.random() * 2000)
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

      logger.info(`Utilisateur ${userData.username} créé avec succès:`, {
        id: user.id,
        username: user.username,
        role: user.role
      });

      console.log(`✅ Utilisateur ${userData.username} créé!`);
      console.log(`   📧 Email: ${userData.email}`);
      console.log(`   🔑 Mot de passe: ${userData.password}`);
      console.log(`   👑 Rôle: ${userData.role}`);
      console.log('');
    }

    console.log('🎉 Tous les utilisateurs de test ont été créés avec succès!');

  } catch (error) {
    logger.error('Erreur lors de la création des utilisateurs de test:', error);
    console.error('❌ Erreur:', error.message);
  } finally {
    await sequelize.close();
  }
}

// Exécuter le script si appelé directement
if (require.main === module) {
  createTestUsers();
}

module.exports = createTestUsers;
