/**
 * Stockage DB pour PolicierCongo:
 * - snapshot mémoire
 * - instructions personality / immediate
 */

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('policiercongo_memory_states', {
      id: {
        type: Sequelize.UUID,
        allowNull: false,
        primaryKey: true,
        defaultValue: Sequelize.literal('uuid_generate_v4()')
      },
      scope: {
        type: Sequelize.STRING(64),
        allowNull: false,
        unique: true,
        defaultValue: 'global'
      },
      memory_json: {
        type: Sequelize.JSONB,
        allowNull: false,
        defaultValue: {}
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()')
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()')
      }
    });

    await queryInterface.createTable('policiercongo_instructions', {
      id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        primaryKey: true,
        autoIncrement: true
      },
      instruction_type: {
        type: Sequelize.ENUM('personality', 'immediate_order'),
        allowNull: false
      },
      text: {
        type: Sequelize.TEXT,
        allowNull: false
      },
      admin_id: {
        type: Sequelize.UUID,
        allowNull: true
      },
      status: {
        type: Sequelize.ENUM('pending', 'executed', 'deleted'),
        allowNull: false,
        defaultValue: 'pending'
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()')
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()')
      }
    });

    await queryInterface.addIndex('policiercongo_instructions', ['instruction_type', 'status'], {
      name: 'idx_pc_instructions_type_status'
    });
    await queryInterface.addIndex('policiercongo_instructions', ['created_at'], {
      name: 'idx_pc_instructions_created_at'
    });

    console.log('OK: tables policiercongo memory/instructions créées');
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('policiercongo_instructions');
    await queryInterface.dropTable('policiercongo_memory_states');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_policiercongo_instructions_instruction_type";');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_policiercongo_instructions_status";');
    console.log('OK: rollback policiercongo memory/instructions');
  }
};

