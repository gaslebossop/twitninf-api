/**
 * Concours : la cagnotte devient une vraie somme, prélevée d'avance.
 *
 * Avant : `prize_currency` était un code saisi à la main (« EUR », « XAF »…)
 * et rien n'était débité — le concours ne promettait qu'un montant sur le
 * papier. Désormais la cagnotte est libellée dans une monnaie du catalogue
 * (`virtual_currencies`, monnaies communautaires comprises), prélevée à la
 * création et versée aux gagnants au tirage.
 *
 * ⚠️ `sequelize.sync({ force: false })` n'ajoute AUCUNE colonne à une table
 * existante. `contests` a déjà été créée et contient des lignes en
 * production : sans cette migration (rejouée aussi par
 * `scripts/autoMigration.js` au démarrage), les colonnes de séquestre
 * n'existeraient jamais et toute création de concours échouerait.
 *
 * Les concours créés AVANT gardent `currency_id = NULL` et
 * `escrow_status = 'none'` : ils restent déclaratifs et le code sait ne rien
 * verser pour eux, plutôt que de tenter un paiement sur une cagnotte qui n'a
 * jamais été prélevée.
 */

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const table = await queryInterface.describeTable('contests');

    if (!table.currency_id) {
      await queryInterface.addColumn('contests', 'currency_id', {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'virtual_currencies', key: 'id' },
        onDelete: 'SET NULL',
      });
      await queryInterface.addIndex('contests', ['currency_id']);
    }

    if (!table.escrow_total) {
      await queryInterface.addColumn('contests', 'escrow_total', {
        type: Sequelize.DECIMAL(20, 8),
        allowNull: false,
        defaultValue: 0,
      });
    }

    if (!table.escrow_status) {
      await queryInterface.sequelize.query(`
        DO $$ BEGIN
          CREATE TYPE "enum_contests_escrow_status" AS ENUM ('none','held','paid','refunded');
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$;
      `);
      await queryInterface.sequelize.query(`
        ALTER TABLE contests
          ADD COLUMN IF NOT EXISTS escrow_status "enum_contests_escrow_status"
          NOT NULL DEFAULT 'none';
      `);
    }

    // Les portefeuilles sont en DECIMAL(20,8) : garder la cagnotte en (14,2)
    // ferait perdre des décimales dès qu'un montant transite par le grand
    // livre. Élargir un DECIMAL ne perd aucune donnée existante.
    await queryInterface.sequelize.query(
      'ALTER TABLE contests ALTER COLUMN prize_amount TYPE DECIMAL(20,8);'
    );

    console.log('OK: colonnes de sequestre ajoutees a contests');
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('contests', 'escrow_status');
    await queryInterface.removeColumn('contests', 'escrow_total');
    await queryInterface.removeColumn('contests', 'currency_id');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_contests_escrow_status";');
    console.log('OK: colonnes de sequestre retirees');
  },
};
