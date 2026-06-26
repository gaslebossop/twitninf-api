const { sequelize, UserBehaviorData } = require('../models');

async function main() {
  try {
    console.log('📊 Récupération des statistiques comportementales...');
    
    // Total distinct users
    const userCount = await UserBehaviorData.count({
      distinct: true,
      col: 'user_id'
    });
    
    // Total events
    const totalEvents = await UserBehaviorData.count();

    // Group by category (action_type)
    const categoryStats = await UserBehaviorData.findAll({
      attributes: [
        'action_type', 
        [sequelize.fn('COUNT', sequelize.col('id')), 'count']
      ],
      group: ['action_type'],
      raw: true,
      // order: [[sequelize.col('count'), 'DESC']] 
    });
    
    // Trie en javascript pour s'assurer que ça marche avec n'importe quelle BDD
    categoryStats.sort((a, b) => Number(b.count) - Number(a.count));

    console.log('\n======================================================');
    console.log('         📈 STATISTIQUES DE COMPORTEMENTS');
    console.log('======================================================');
    console.log(`👥 Utilisateurs distincts trackés : ${userCount}`);
    console.log(`📝 Événements totaux enregistrés  : ${totalEvents}`);
    console.log('------------------------------------------------------');
    console.log('Répartition par type d\'action :\n');
    
    categoryStats.forEach(stat => {
      console.log(`  - ${stat.action_type.padEnd(25, ' ')} : ${stat.count} événement(s)`);
    });
    
    console.log('======================================================\n');
    
  } catch (error) {
    console.error('Erreur lors de la récupération des stats:', error);
  } finally {
    await sequelize.close();
  }
}

main();
