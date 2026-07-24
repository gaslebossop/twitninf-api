const { User, closeConnection } = require('../models');

const SUPER_MODERATION_PERMISSIONS = {
  can_ban_users: true,
  can_suspend_users: true,
  can_delete_tweets: true,
  can_verify_users: true,
  can_view_reports: true,
  can_view_analytics: true,
  can_manage_moderators: true,
  can_manage_economy: true,
  can_moderate_content: true,
  can_exclude_recommendations: true
};

async function main() {
  const user = await User.findOne({ where: { username: 'gas' } });

  if (!user) {
    console.error('Utilisateur @gas introuvable.');
    process.exitCode = 1;
    return;
  }

  const existingPermissions = user.moderation_permissions || {};
  await user.update({
    role: 'superadmin',
    is_suspended: false,
    suspended_at: null,
    suspended_until: null,
    suspension_reason: null,
    moderation_permissions: {
      ...existingPermissions,
      ...SUPER_MODERATION_PERMISSIONS
    }
  });

  console.log(`@gas promu supermoderateur: role=${user.role}`);
}

main()
  .catch((error) => {
    console.error('Erreur promotion @gas:', error);
    process.exitCode = 1;
  })
  .finally(() => closeConnection());
