const logger = require('../utils/logger');
// authService et User sont requis en LAZY (au runtime) pour éviter toute
// dépendance circulaire (banService → globalBanMiddleware → authService → banService).

// ─────────────────────────────────────────────────────────────────────────────
// Middleware global de blocage des comptes bannis/suspendus.
//
// ⚠️ PROBLÈME HISTORIQUE CORRIGÉ ICI :
// Le JWT (durée 7j) embarque `is_suspended`, `role`, etc. au moment du login, et
// `authenticateToken` faisait simplement `req.user = decoded`. Conséquence : un
// compte banni APRÈS l'émission de son token gardait tous ses droits jusqu'à
// l'expiration (jusqu'à 7 jours). De plus, ce middleware était monté sur `/api`
// AVANT `authenticateToken`, donc `req.user` était toujours indéfini → il ne
// bloquait jamais personne.
//
// Désormais ce gate :
//   1) décode lui-même le token (sans dépendre de req.user),
//   2) vérifie le statut de suspension FRAIS en base (avec un cache court),
//   3) bloque immédiatement les comptes suspendus/bannis/inactifs.
// ─────────────────────────────────────────────────────────────────────────────

// Routes accessibles même à un compte banni (login, déconnexion, consultation
// du statut, notifications). On NE met PAS /api/auth tout entier pour éviter
// qu'un banni continue d'utiliser des sous-routes sensibles d'auth.
const ALLOWED_PREFIXES = [
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/refresh',
  '/api/auth/logout',
  '/api/auth/me',
  '/api/auth/profile',
  '/api/notifications',
  '/api/health',
  '/api/status',
  '/api/ping',
];

// Cache mémoire { userId -> { blocked, info, exp } } pour borner la charge DB.
// TTL court : une bascule de ban prend effet en ≤ TTL (au lieu de 7 jours).
const STATUS_TTL_MS = 30 * 1000;
const STATUS_CACHE_MAX = 50000;
const statusCache = new Map();

function getCached(userId) {
  const e = statusCache.get(userId);
  if (!e) return null;
  if (Date.now() > e.exp) { statusCache.delete(userId); return null; }
  return e;
}

function setCached(userId, value) {
  // Éviction simpliste si la map devient trop grosse.
  if (statusCache.size >= STATUS_CACHE_MAX) statusCache.clear();
  statusCache.set(userId, { ...value, exp: Date.now() + STATUS_TTL_MS });
}

// Invalidation ciblée — à appeler depuis BanService lors d'un ban/déban pour une
// prise d'effet immédiate (optionnel ; sans ça, l'effet est borné par le TTL).
function invalidateUser(userId) {
  if (userId != null) statusCache.delete(String(userId));
}

function extractToken(req) {
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ')) return h.slice(7).trim();
  return null;
}

/**
 * Évalue le statut de blocage d'un utilisateur à partir de la base.
 * @returns {{blocked:boolean, info?:object}}
 */
async function evaluateUserStatus(userId) {
  const cached = getCached(userId);
  if (cached) return cached.value;

  const User = require('../models/User');
  const user = await User.findByPk(userId, {
    attributes: ['id', 'username', 'is_suspended', 'suspended_until', 'ban_count', 'is_active'],
  });

  let value;
  if (!user) {
    // Token valide mais utilisateur inexistant (supprimé) → bloquer.
    value = { blocked: true, info: { reason: 'Compte introuvable', permanent: true } };
  } else if (user.is_active === false) {
    value = { blocked: true, info: { reason: 'Compte désactivé', permanent: true } };
  } else if (user.ban_count >= 5) {
    value = { blocked: true, info: { reason: 'Bannissement définitif (violations répétées)', permanent: true } };
  } else if (user.is_suspended) {
    // Suspension temporaire expirée ? → on laisse passer (le nettoyage DB se fait
    // par ailleurs via BanService.cleanupExpiredSuspensions).
    const until = user.suspended_until ? new Date(user.suspended_until) : null;
    if (until && until < new Date()) {
      value = { blocked: false };
    } else {
      const remaining = until ? Math.ceil((until - new Date()) / (1000 * 60 * 60 * 24)) : null;
      value = {
        blocked: true,
        info: {
          reason: user.suspension_reason || 'Violation des conditions d\'utilisation',
          suspended_until: user.suspended_until,
          remaining_days: remaining,
          is_suspended: true,
        },
      };
    }
  } else {
    value = { blocked: false };
  }

  setCached(userId, { value });
  return value;
}

const globalBanCheck = async (req, res, next) => {
  try {
    // Routes explicitement autorisées aux comptes bannis.
    // On teste req.originalUrl (toujours le chemin COMPLET, ex: /api/auth/login),
    // car ce middleware est monté sur '/api' → Express retire ce préfixe de
    // req.path (qui vaudrait '/auth/login'), ce qui ferait échouer le match.
    const fullPath = (req.originalUrl || req.path || '').split('?')[0];
    if (ALLOWED_PREFIXES.some((p) => fullPath.startsWith(p))) {
      return next();
    }

    // Décoder le token nous-mêmes (indépendamment de authenticateToken).
    const token = extractToken(req);
    if (!token) {
      // Pas de token → la route appliquera (ou non) authenticateToken.
      return next();
    }

    const authService = require('../services/authService');
    const decoded = authService.verifyToken(token);
    if (!decoded || !decoded.id) {
      // Token invalide/expiré → laissé à authenticateToken (401 propre).
      return next();
    }

    let status;
    try {
      status = await evaluateUserStatus(String(decoded.id));
    } catch (dbErr) {
      // Fail-open UNIQUEMENT sur erreur d'infrastructure (DB indisponible) :
      // ne jamais transformer une panne DB en panne totale de l'API. On ne
      // débloque jamais un compte sur la base d'un "suspended" positif.
      logger.warn('[globalBan] Vérification du statut impossible (fail-open):', dbErr.message);
      return next();
    }

    if (status.blocked) {
      logger.info(`🚫 Accès bloqué (compte banni/suspendu) user=${decoded.id} sur ${req.path}`);
      return res.status(403).json({
        success: false,
        message: 'Accès refusé - Compte banni ou suspendu',
        ban_info: status.info || { reason: 'Compte banni' },
      });
    }

    return next();
  } catch (error) {
    logger.error('Erreur dans le middleware global de ban:', error);
    next(error);
  }
};

module.exports = {
  globalBanCheck,
  invalidateUser,
};
