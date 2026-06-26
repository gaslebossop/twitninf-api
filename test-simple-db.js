const { Sequelize } = require('sequelize');
const config = require('./src/config/config');

async function testDatabase() {
  const sequelize = new Sequelize(
    config.database.database,
    config.database.username,
    config.database.password,
    {
      host: config.database.host,
      port: config.database.port,
      dialect: config.database.dialect,
      logging: console.log
    }
  );

  try {
    console.log('🔌 Test de connexion à PostgreSQL...');
    await sequelize.authenticate();
    console.log('✅ Connexion réussie');

    console.log('\n📋 Vérification des tables existantes...');
    const tables = await sequelize.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
      { type: Sequelize.QueryTypes.SELECT }
    );
    
    console.log('Tables trouvées:');
    tables.forEach(table => {
      console.log(`   - ${table.table_name}`);
    });

    // Vérifier si la table users existe
    const usersTableExists = tables.some(table => table.table_name === 'users');
    
    if (!usersTableExists) {
      console.log('\n⚠️  Table users non trouvée, création...');
      
      // Créer la table users manuellement
      await sequelize.query(`
        CREATE TABLE users (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          username VARCHAR(30) UNIQUE NOT NULL,
          full_name VARCHAR(100) NOT NULL,
          email VARCHAR(255) UNIQUE NOT NULL,
          phone VARCHAR(20) UNIQUE NOT NULL,
          password VARCHAR(255) NOT NULL,
          avatar VARCHAR(255) DEFAULT 'https://via.placeholder.com/150x150/4A90E2/FFFFFF?text=U',
          verified BOOLEAN DEFAULT false,
          premium BOOLEAN DEFAULT false,
          platform VARCHAR(10) NOT NULL,
          last_activity TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          id_notif VARCHAR(255) UNIQUE,
          is_active BOOLEAN DEFAULT true,
          email_verified BOOLEAN DEFAULT false,
          phone_verified BOOLEAN DEFAULT false,
          reset_password_token VARCHAR(255),
          reset_password_expires TIMESTAMP,
          stats JSONB DEFAULT '{"followers": 0, "following": 0, "tweets": 0, "likes": 0}',
          preferences JSONB DEFAULT '{"language": "fr", "theme": "dark", "notifications": {"push": true, "email": true, "sms": false}}',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);
      
      console.log('✅ Table users créée avec succès');
    } else {
      console.log('\n✅ Table users existe déjà');
    }

    console.log('\n🎉 Test terminé avec succès !');
    
  } catch (error) {
    console.error('❌ Erreur:', error.message);
  } finally {
    await sequelize.close();
  }
}

testDatabase();
