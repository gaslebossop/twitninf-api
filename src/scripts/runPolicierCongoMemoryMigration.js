const { sequelize } = require('../models');

async function runPolicierCongoMemoryMigration() {
  try {
    await sequelize.authenticate();

    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS policiercongo_memory_states (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        scope VARCHAR(64) NOT NULL UNIQUE DEFAULT 'global',
        memory_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )
    `);

    console.log('MEMORY_TABLE_OK');
  } finally {
    await sequelize.close();
  }
}

if (require.main === module) {
  runPolicierCongoMemoryMigration().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = runPolicierCongoMemoryMigration;

