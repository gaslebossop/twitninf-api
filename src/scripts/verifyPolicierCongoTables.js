const { sequelize } = require('../models');

async function verifyPolicierCongoTables() {
  try {
    await sequelize.authenticate();
    const [rows] = await sequelize.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('policiercongo_memory_states', 'policiercongo_instructions')
      ORDER BY table_name
    `);
    console.log(rows);
  } finally {
    await sequelize.close();
  }
}

if (require.main === module) {
  verifyPolicierCongoTables().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = verifyPolicierCongoTables;

