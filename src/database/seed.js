const { sequelize } = require('./index');
const User = require('../models/User');
const logger = require('../utils/logger');

// Données de test pour les utilisateurs
const usersData = [
  {
    username: 'admin',
    full_name: 'Administrateur',
    email: 'admin@wtitninf.com',
    phone: '+33123456789',
    password: 'Admin123!',
    platform: 'web',
    verified: true,
    premium: true,
    stats: {
      followers: 1000,
      following: 500,
      tweets: 250,
      likes: 5000
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
  },
  {
    username: 'john_doe',
    full_name: 'John Doe',
    email: 'john@example.com',
    phone: '+33123456790',
    password: 'Password123!',
    platform: 'ios',
    verified: true,
    premium: false,
    stats: {
      followers: 150,
      following: 200,
      tweets: 45,
      likes: 1200
    },
    preferences: {
      language: 'en',
      theme: 'light',
      notifications: {
        push: true,
        email: false,
        sms: false
      }
    }
  },
  {
    username: 'jane_smith',
    full_name: 'Jane Smith',
    email: 'jane@example.com',
    phone: '+33123456791',
    password: 'Password123!',
    platform: 'android',
    verified: true,
    premium: true,
    stats: {
      followers: 800,
      following: 300,
      tweets: 180,
      likes: 3500
    },
    preferences: {
      language: 'en',
      theme: 'dark',
      notifications: {
        push: true,
        email: true,
        sms: true
      }
    }
  },
  {
    username: 'marie_dupont',
    full_name: 'Marie Dupont',
    email: 'marie@example.com',
    phone: '+33123456792',
    password: 'Password123!',
    platform: 'web',
    verified: false,
    premium: false,
    stats: {
      followers: 50,
      following: 100,
      tweets: 20,
      likes: 300
    },
    preferences: {
      language: 'fr',
      theme: 'light',
      notifications: {
        push: false,
        email: true,
        sms: false
      }
    }
  },
  {
    username: 'pierre_martin',
    full_name: 'Pierre Martin',
    email: 'pierre@example.com',
    phone: '+33123456793',
    password: 'Password123!',
    platform: 'ios',
    verified: true,
    premium: false,
    stats: {
      followers: 300,
      following: 150,
      tweets: 75,
      likes: 1800
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
  }
];

// Fonction pour créer des utilisateurs de test
async function seedUsers() {
  try {
    logger.info('Début du seeding des utilisateurs...');

    // Vérifier si des utilisateurs existent déjà
    const existingUsers = await User.count();
    if (existingUsers > 0) {
      logger.info(`${existingUsers} utilisateurs existent déjà. Skipping seeding.`);
      return;
    }

    // Créer les utilisateurs
    const createdUsers = await User.bulkCreate(usersData, {
      validate: true,
      returning: true
    });

    logger.info(`${createdUsers.length} utilisateurs créés avec succès`);

    // Afficher les informations des utilisateurs créés
    createdUsers.forEach(user => {
      logger.info(`Utilisateur créé: ${user.username} (${user.email})`);
    });

  } catch (error) {
    logger.error('Erreur lors du seeding des utilisateurs:', error);
    throw error;
  }
}

// Fonction pour créer des données de test supplémentaires
async function seedAdditionalData() {
  try {
    logger.info('Création de données de test supplémentaires...');

    // Créer des utilisateurs avec des données variées
    const additionalUsers = [];
    
    for (let i = 1; i <= 20; i++) {
      additionalUsers.push({
        username: `user${i}`,
        full_name: `Utilisateur ${i}`,
        email: `user${i}@example.com`,
        phone: `+3312345679${i.toString().padStart(2, '0')}`,
        password: 'Password123!',
        platform: ['ios', 'android', 'web'][Math.floor(Math.random() * 3)],
        verified: Math.random() > 0.3,
        premium: Math.random() > 0.7,
        stats: {
          followers: Math.floor(Math.random() * 1000),
          following: Math.floor(Math.random() * 500),
          tweets: Math.floor(Math.random() * 200),
          likes: Math.floor(Math.random() * 5000)
        },
        preferences: {
          language: Math.random() > 0.5 ? 'fr' : 'en',
          theme: Math.random() > 0.5 ? 'dark' : 'light',
          notifications: {
            push: Math.random() > 0.2,
            email: Math.random() > 0.3,
            sms: Math.random() > 0.8
          }
        }
      });
    }

    await User.bulkCreate(additionalUsers, {
      validate: true,
      returning: false
    });

    logger.info(`${additionalUsers.length} utilisateurs supplémentaires créés`);

  } catch (error) {
    logger.error('Erreur lors de la création des données supplémentaires:', error);
    throw error;
  }
}

// Fonction pour créer des statistiques de test
async function seedStatistics() {
  try {
    logger.info('Création de statistiques de test...');

    // Mettre à jour les statistiques des utilisateurs existants
    const users = await User.findAll();
    
    for (const user of users) {
      // Générer des statistiques aléatoires
      const stats = {
        followers: Math.floor(Math.random() * 2000) + 10,
        following: Math.floor(Math.random() * 1000) + 5,
        tweets: Math.floor(Math.random() * 500) + 1,
        likes: Math.floor(Math.random() * 10000) + 50
      };

      await user.update({ stats });
    }

    logger.info(`Statistiques mises à jour pour ${users.length} utilisateurs`);

  } catch (error) {
    logger.error('Erreur lors de la création des statistiques:', error);
    throw error;
  }
}

// Fonction principale de seeding
async function runSeed() {
  try {
    logger.info('Début du processus de seeding...');

    // Tester la connexion à la base de données
    await sequelize.authenticate();
    logger.info('Connexion à la base de données établie');

    // Créer les utilisateurs de base
    await seedUsers();

    // Créer des données supplémentaires si demandé
    if (process.argv.includes('--full')) {
      await seedAdditionalData();
      await seedStatistics();
    }

    logger.info('Seeding terminé avec succès');

  } catch (error) {
    logger.error('Erreur lors du seeding:', error);
    process.exit(1);
  } finally {
    await sequelize.close();
  }
}

// Exécuter le seeding si ce fichier est appelé directement
if (require.main === module) {
  runSeed();
}

module.exports = {
  runSeed,
  seedUsers,
  seedAdditionalData,
  seedStatistics
};
