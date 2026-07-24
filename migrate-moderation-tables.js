const { Pool } = require('pg');
const config = require('./src/config/config');

// Configuration de la base de données
const pool = new Pool({
  host: config.database.host,
  port: config.database.port,
  database: config.database.name,
  user: config.database.username,
  password: config.database.password,
});

async function migrateModerationTables() {
  const client = await pool.connect();
  
  try {
    console.log('🚀 Début de la migration des tables de modération...');
    
    // 1. Créer la table reports
    console.log('📋 Création de la table reports...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS reports (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        type VARCHAR(20) NOT NULL CHECK (type IN ('tweet', 'user', 'comment')),
        reporter_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        target_id UUID NOT NULL,
        target_type VARCHAR(20) NOT NULL CHECK (target_type IN ('tweet', 'user', 'comment')),
        reason TEXT NOT NULL,
        severity VARCHAR(20) DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
        status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'investigating', 'resolved', 'dismissed')),
        priority INTEGER DEFAULT 1,
        moderator_notes TEXT,
        resolved_at TIMESTAMP,
        resolved_by UUID REFERENCES users(id),
        resolution_action VARCHAR(20) CHECK (resolution_action IN ('none', 'warn', 'suspend', 'ban', 'delete')),
        resolution_reason TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // 2. Créer la table moderation_actions
    console.log('⚡ Création de la table moderation_actions...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS moderation_actions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        type VARCHAR(20) NOT NULL CHECK (type IN ('ban', 'suspend', 'delete', 'warn', 'approve', 'reject')),
        target_type VARCHAR(20) NOT NULL CHECK (target_type IN ('user', 'tweet', 'comment')),
        target_id UUID NOT NULL,
        moderator_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        reason TEXT,
        duration INTEGER,
        status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'expired', 'reversed')),
        expires_at TIMESTAMP,
        reversed_at TIMESTAMP,
        reversed_by UUID REFERENCES users(id),
        reversal_reason TEXT,
        metadata JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // 3. Créer les index pour les performances
    console.log('🔍 Création des index...');
    
    // Index pour reports
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_reports_type_status ON reports(type, status);
      CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(target_id, target_type);
      CREATE INDEX IF NOT EXISTS idx_reports_reporter ON reports(reporter_id);
      CREATE INDEX IF NOT EXISTS idx_reports_severity ON reports(severity);
      CREATE INDEX IF NOT EXISTS idx_reports_created_at ON reports(created_at);
    `);
    
    // Index pour moderation_actions
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_moderation_actions_type_status ON moderation_actions(type, status);
      CREATE INDEX IF NOT EXISTS idx_moderation_actions_target ON moderation_actions(target_id, target_type);
      CREATE INDEX IF NOT EXISTS idx_moderation_actions_moderator ON moderation_actions(moderator_id);
      CREATE INDEX IF NOT EXISTS idx_moderation_actions_created_at ON moderation_actions(created_at);
      CREATE INDEX IF NOT EXISTS idx_moderation_actions_expires_at ON moderation_actions(expires_at);
    `);
    
    // 4. Créer des données de test pour les signalements
    console.log('🧪 Création de données de test...');
    
    // Vérifier s'il y a déjà des données
    const existingReports = await client.query('SELECT COUNT(*) FROM reports');
    if (parseInt(existingReports.rows[0].count) === 0) {
      // Créer quelques signalements de test
      await client.query(`
        INSERT INTO reports (type, reporter_id, target_id, target_type, reason, severity, status, priority)
        VALUES 
          ('tweet', (SELECT id FROM users LIMIT 1), (SELECT id FROM tweets LIMIT 1), 'tweet', 'Contenu inapproprié', 'high', 'pending', 1),
          ('user', (SELECT id FROM users LIMIT 1), (SELECT id FROM users LIMIT 1 OFFSET 1), 'user', 'Comportement abusif', 'critical', 'investigating', 2),
          ('tweet', (SELECT id FROM users LIMIT 1 OFFSET 1), (SELECT id FROM tweets LIMIT 1 OFFSET 1), 'tweet', 'Spam', 'medium', 'pending', 1)
      `);
      console.log('✅ Données de test créées pour les signalements');
    }
    
    // 5. Créer des données de test pour les actions de modération
    const existingActions = await client.query('SELECT COUNT(*) FROM moderation_actions');
    if (parseInt(existingActions.rows[0].count) === 0) {
      // Créer quelques actions de test
      await client.query(`
        INSERT INTO moderation_actions (type, target_type, target_id, moderator_id, reason, duration, status)
        VALUES 
          ('warn', 'user', (SELECT id FROM users LIMIT 1), (SELECT id FROM users WHERE role = 'moderator' OR role = 'admin' OR role = 'superadmin' LIMIT 1), 'Premier avertissement', 30, 'active'),
          ('suspend', 'user', (SELECT id FROM users LIMIT 1 OFFSET 1), (SELECT id FROM users WHERE role = 'moderator' OR role = 'admin' OR role = 'superadmin' LIMIT 1), 'Suspension temporaire', 7, 'active'),
          ('delete', 'tweet', (SELECT id FROM tweets LIMIT 1), (SELECT id FROM users WHERE role = 'moderator' OR role = 'admin' OR role = 'superadmin' LIMIT 1), 'Contenu supprimé', NULL, 'active')
      `);
      console.log('✅ Données de test créées pour les actions de modération');
    }
    
    console.log('🎉 Migration terminée avec succès !');
    
  } catch (error) {
    console.error('❌ Erreur lors de la migration:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

// Exécuter la migration
if (require.main === module) {
  migrateModerationTables()
    .then(() => {
      console.log('✅ Migration terminée avec succès');
      process.exit(0);
    })
    .catch((error) => {
      console.error('❌ Migration échouée:', error);
      process.exit(1);
    });
}

module.exports = { migrateModerationTables };
