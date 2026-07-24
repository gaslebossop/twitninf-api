const { User } = require('./src/models');

async function unbanUser(username) {
  try {
    console.log(`🔓 Débanage de l'utilisateur: ${username}\n`);

    // Rechercher l'utilisateur
    const user = await User.findOne({
      where: { username }
    });

    if (!user) {
      console.log('❌ Utilisateur non trouvé');
      return;
    }

    console.log('📊 État actuel de l\'utilisateur:');
    console.log(`   - is_suspended: ${user.is_suspended}`);
    console.log(`   - ban_count: ${user.ban_count}`);
    console.log(`   - suspension_reason: ${user.suspension_reason || 'Aucune'}`);
    console.log(`   - suspended_until: ${user.suspended_until || 'Aucune date'}`);

    // Débaner complètement l'utilisateur
    await user.update({
      is_suspended: false,
      ban_count: 0,
      suspension_reason: null,
      suspended_until: null
    });

    console.log('\n✅ Utilisateur débané avec succès!');
    console.log('📊 Nouvel état:');
    console.log(`   - is_suspended: ${user.is_suspended}`);
    console.log(`   - ban_count: ${user.ban_count}`);
    console.log(`   - suspension_reason: ${user.suspension_reason || 'Aucune'}`);
    console.log(`   - suspended_until: ${user.suspended_until || 'Aucune date'}`);

    console.log('\n⚠️  IMPORTANT: L\'utilisateur doit se reconnecter pour obtenir un nouveau token!');
    console.log('   Le token actuel contient encore les anciennes informations de ban.');

  } catch (error) {
    console.error('❌ Erreur lors du débanage:', error);
  }
}

// Récupérer le nom d'utilisateur depuis les arguments
const username = process.argv[2];

if (!username) {
  console.log('❌ Usage: node unban-user.js <username>');
  console.log('   Exemple: node unban-user.js tonusername');
  process.exit(1);
}

// Lancer le débanage
unbanUser(username);
