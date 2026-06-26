/**
 * Script de migration pour ajouter la colonne is_ios_native
 * 
 * Ce script ajoute physiquement la colonne à la table 'users' dans PostgreSQL
 * en utilisant l'interface de requête de Sequelize.
 * 
 * Utilisation :
 * node add_is_ios_native_column.js
 */

require('dotenv').config();
const { sequelize } = require('./src/models');
const { DataTypes } = require('sequelize');

async function addColumn() {
  console.log('--- 🛡️  Migration de la base de données ---');
  
  const queryInterface = sequelize.getQueryInterface();
  const tableName = 'users'; // Le nom pluriel par défaut de Sequelize pour User
  const columnName = 'is_ios_native';

  try {
    console.log(`🔍 Vérification de l'existence de la colonne '${columnName}' dans la table '${tableName}'...`);
    
    const tableInfo = await queryInterface.describeTable(tableName);
    
    if (tableInfo[columnName]) {
      console.log(`✅ La colonne '${columnName}' existe déjà dans la table '${tableName}'.`);
      process.exit(0);
    }

    console.log(`➕ Ajout de la colonne '${columnName}'...`);
    
    await queryInterface.addColumn(tableName, columnName, {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      allowNull: false
    });

    console.log(`🎉 Succès ! La colonne '${columnName}' a été ajoutée avec succès.`);
    process.exit(0);
  } catch (error) {
    console.error('❌ Erreur lors de l\'ajout de la colonne :', error);
    
    // Essayer de voir si c'est un problème de casse du nom de la table
    if (error.name === 'SequelizeDatabaseError' && error.message.includes('relation "users" does not exist')) {
      console.log('⚠️  Table "users" non trouvée, essai avec "Users"...');
      try {
        await queryInterface.addColumn('Users', columnName, {
          type: DataTypes.BOOLEAN,
          defaultValue: false,
          allowNull: false
        });
        console.log(`🎉 Succès ! La colonne '${columnName}' a été ajoutée à la table 'Users'.`);
        process.exit(0);
      } catch (innerError) {
        console.error('❌ Échec final :', innerError.message);
        process.exit(1);
      }
    } else {
      process.exit(1);
    }
  }
}

addColumn();
