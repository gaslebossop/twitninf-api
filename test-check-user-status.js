const { User } = require('./src/models');

async function checkUserStatus() {
  try {
    console.log('🔍 Vérification de l\'état des utilisateurs...\n');

    // Récupérer tous les utilisateurs avec leurs informations de ban
    const users = await User.findAll({
      attributes: [
        'id', 'username', 'full_name', 'is_active', 
        'is_suspended', 'ban_count', 'suspension_reason', 'suspended_until'
      ],
      order: [['username', 'ASC']]
    });

    console.log(`📊 ${users.length} utilisateurs trouvés:\n`);

    users.forEach(user => {
      const userData = user.toJSON();
      console.log(`👤 ${userData.username}:`);
      console.log(`   - is_active: ${userData.is_active}`);
      console.log(`   - is_suspended: ${userData.is_suspended}`);
      console.log(`   - ban_count: ${userData.ban_count}`);
      console.log(`   - suspension_reason: ${userData.suspension_reason || 'Aucune'}`);
      console.log(`   - suspended_until: ${userData.suspended_until || 'Aucune date'}`);
      console.log('');
    });

    // Vérifier spécifiquement les utilisateurs suspendus
    const suspendedUsers = users.filter(u => u.is_suspended);
    if (suspendedUsers.length > 0) {
      console.log(`🚫 ${suspendedUsers.length} utilisateur(s) suspendu(s):`);
      suspendedUsers.forEach(user => {
        const userData = user.toJSON();
        console.log(`   - ${userData.username} (ban_count: ${userData.ban_count})`);
      });
    } else {
      console.log('✅ Aucun utilisateur suspendu trouvé');
    }

  } catch (error) {
    console.error('❌ Erreur:', error);
  }
}

// Lancer la vérification
checkUserStatus();
