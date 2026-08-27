// Scopes disponibles pour la plateforme développeur (OAuth). Toute la
// validation d'un scope demandé — à l'autorisation comme à la vérification
// d'un token — passe par cette liste.
const OAUTH_SCOPES = ['read:profile', 'read:tweets', 'write:tweets', 'write:interactions'];

function sanitizeScopes(requested) {
  if (!Array.isArray(requested)) return [];
  const unique = new Set(requested.filter((s) => OAUTH_SCOPES.includes(s)));
  return [...unique];
}

module.exports = { OAUTH_SCOPES, sanitizeScopes };
