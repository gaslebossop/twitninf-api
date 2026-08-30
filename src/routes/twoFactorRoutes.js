const express = require('express');
const { body, validationResult } = require('express-validator');
const QRCode = require('qrcode');
const { User, TwoFactorRecoveryCode } = require('../models');
const authService = require('../services/authService');
const twoFactorService = require('../services/twoFactorService');
const mailService = require('../services/mailService');
const { authenticateToken } = require('../middleware/authMiddleware');
const logger = require('../utils/logger');

const router = express.Router();

function handleValidationErrors(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, message: 'Requête invalide', errors: errors.array() });
  }
  return next();
}

function sessionContextFrom(req) {
  return {
    deviceId: req.headers['x-device-id'] || null,
    platform: req.headers['user-platform'] || null,
    appVersion: req.headers['x-app-version'] || null,
    userAgent: req.headers['user-agent'] || null,
    ip: req.ip || null,
  };
}

/** Remplace le jeu de codes de secours et rend les codes EN CLAIR, une fois. */
async function issueRecoveryCodes(userId) {
  const codes = twoFactorService.generateRecoveryCodes();
  await TwoFactorRecoveryCode.destroy({ where: { user_id: userId } });
  await TwoFactorRecoveryCode.bulkCreate(
    codes.map((code) => ({ user_id: userId, code_hash: twoFactorService.hash(code) })),
  );
  return codes;
}

// ─── Parcours de CONNEXION (pas de jeton : le défi tient lieu d'identité) ────

/**
 * Redemande un code par e-mail pour un défi en cours.
 *
 * Utile quand le compte a les DEUX facteurs : le code n'est alors pas envoyé
 * d'office à la connexion, puisque l'utilisateur peut préférer son
 * application — inutile de lui écrire à chaque fois.
 */
router.post('/challenge/email', [
  body('challengeId').isString().isLength({ min: 10, max: 200 }),
  handleValidationErrors,
], async (req, res) => {
  try {
    const challenge = await twoFactorService.readChallenge(req.body.challengeId);
    if (!challenge) {
      return res.status(410).json({ success: false, message: 'Session de vérification expirée. Reconnecte-toi.' });
    }
    if (!challenge.methods.includes('email')) {
      return res.status(400).json({ success: false, message: 'Le code par e-mail n’est pas activé sur ce compte.' });
    }

    const user = await User.findByPk(challenge.userId, { attributes: ['id', 'email'] });
    if (!user || !user.email) {
      return res.status(409).json({ success: false, message: 'Aucune adresse e-mail sur ce compte.' });
    }

    await twoFactorService.sendEmailCode(req.body.challengeId, user.email);
    return res.json({ success: true, message: 'Code envoyé' });
  } catch (error) {
    if (error.code === 'smtp_not_configured') {
      return res.status(503).json({ success: false, message: 'Envoi d’e-mails indisponible sur ce serveur.' });
    }
    logger.error('[2fa] challenge/email:', error);
    return res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
  }
});

/**
 * Vérifie le second facteur et ouvre la session.
 *
 * Les trois formes (code e-mail, code TOTP, code de secours) arrivent par la
 * MÊME route : le client ne sait pas ce que l'utilisateur a tapé, et trois
 * routes l'obligeraient à le deviner.
 */
router.post('/verify', [
  body('challengeId').isString().isLength({ min: 10, max: 200 }),
  body('code').isString().isLength({ min: 4, max: 32 }),
  handleValidationErrors,
], async (req, res) => {
  try {
    const { challengeId, code } = req.body;
    const challenge = await twoFactorService.readChallenge(challengeId);
    if (!challenge) {
      return res.status(410).json({ success: false, message: 'Session de vérification expirée. Reconnecte-toi.' });
    }

    const user = await User.findByPk(challenge.userId);
    if (!user || !user.is_active) {
      await twoFactorService.dropChallenge(challengeId);
      return res.status(401).json({ success: false, message: 'Identifiants invalides' });
    }

    let accepted = false;

    if (challenge.methods.includes('email') && await twoFactorService.verifyEmailCode(challengeId, code)) {
      accepted = true;
    } else if (challenge.methods.includes('totp') && twoFactorService.verifyTotp(user.two_factor_totp_secret, code)) {
      accepted = true;
    } else {
      // Code de secours : accepté quelle que soit la méthode active, consommé
      // une seule fois. C'est la porte de sortie quand le téléphone est perdu.
      const hashed = twoFactorService.hash(String(code).trim().toUpperCase());
      const recovery = await TwoFactorRecoveryCode.findOne({
        where: { user_id: user.id, code_hash: hashed, used_at: null },
      });
      if (recovery) {
        await recovery.update({ used_at: new Date() });
        accepted = true;
        logger.warn(`[2fa] Code de secours utilisé par ${user.username}`);
      }
    }

    if (!accepted) {
      const remaining = await twoFactorService.bumpAttempts(challengeId, challenge);
      if (!remaining) {
        return res.status(429).json({ success: false, message: 'Trop de tentatives. Reconnecte-toi.' });
      }
      return res.status(401).json({
        success: false,
        message: 'Code incorrect',
        data: { attemptsLeft: twoFactorService.MAX_ATTEMPTS - remaining.attempts },
      });
    }

    await twoFactorService.dropChallenge(challengeId);
    const session = await authService.completeLogin(user, sessionContextFrom(req));
    return res.json(session);
  } catch (error) {
    logger.error('[2fa] verify:', error);
    return res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
  }
});

// ─── RÉGLAGES (compte déjà connecté) ────────────────────────────────────────

router.use(authenticateToken);

router.get('/', async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id, {
      attributes: ['id', 'email', 'two_factor_email_enabled', 'two_factor_totp_enabled', 'two_factor_enabled_at'],
    });
    const unused = await TwoFactorRecoveryCode.count({ where: { user_id: req.user.id, used_at: null } });

    return res.json({
      success: true,
      data: {
        emailEnabled: !!user.two_factor_email_enabled,
        totpEnabled: !!user.two_factor_totp_enabled,
        enabledAt: user.two_factor_enabled_at,
        recoveryCodesLeft: unused,
        hasEmail: !!user.email,
        // Indice d'adresse, jamais l'adresse : il sert à reconnaître SA boîte,
        // pas à en révéler une.
        emailHint: user.email ? String(user.email).replace(/(.{1,2})[^@]*(@.*)/, '$1***$2') : null,
        mailAvailable: mailService.isConfigured(),
      },
    });
  } catch (error) {
    logger.error('[2fa] status:', error);
    return res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
  }
});

/** Envoie un code à l'adresse du compte pour ACTIVER la vérification e-mail. */
router.post('/email/start', async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id, { attributes: ['id', 'email'] });
    if (!user || !user.email) {
      return res.status(409).json({ success: false, message: 'Ajoute une adresse e-mail à ton compte d’abord.' });
    }
    await twoFactorService.sendEmailCode(`setup:${user.id}`, user.email, 'vérification');
    return res.json({ success: true, message: 'Code envoyé' });
  } catch (error) {
    if (error.code === 'smtp_not_configured') {
      return res.status(503).json({ success: false, message: 'Envoi d’e-mails indisponible sur ce serveur.' });
    }
    logger.error('[2fa] email/start:', error);
    return res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
  }
});

router.post('/email/confirm', [
  body('code').isString().isLength({ min: 4, max: 12 }),
  handleValidationErrors,
], async (req, res) => {
  try {
    const ok = await twoFactorService.verifyEmailCode(`setup:${req.user.id}`, req.body.code);
    if (!ok) return res.status(401).json({ success: false, message: 'Code incorrect ou expiré' });

    const user = await User.findByPk(req.user.id);
    await user.update({
      two_factor_email_enabled: true,
      // Recevoir un code prouve l'adresse : c'est exactement ce que
      // `email_verified` affirme, et le laisser à faux mentirait.
      email_verified: true,
      two_factor_enabled_at: user.two_factor_enabled_at || new Date(),
    });

    const codes = await issueRecoveryCodes(user.id);
    return res.json({ success: true, message: 'Vérification par e-mail activée', data: { recoveryCodes: codes } });
  } catch (error) {
    logger.error('[2fa] email/confirm:', error);
    return res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
  }
});

/** Prépare une application d'authentification : secret + QR code. */
router.post('/totp/start', async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id);
    const secret = twoFactorService.generateTotpSecret();
    // Écrit tout de suite mais SANS activer : le drapeau ne passe à vrai
    // qu'après un code valide, sinon un abandon en cours de route enfermerait
    // le compte derrière un secret que personne n'a scanné.
    await user.update({ two_factor_totp_secret: secret });

    const uri = twoFactorService.totpUri(user.username, secret);
    const qr = await QRCode.toDataURL(uri, { margin: 1, width: 320 });
    return res.json({ success: true, data: { secret, uri, qr } });
  } catch (error) {
    logger.error('[2fa] totp/start:', error);
    return res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
  }
});

router.post('/totp/confirm', [
  body('code').isString().isLength({ min: 6, max: 10 }),
  handleValidationErrors,
], async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id);
    if (!user.two_factor_totp_secret) {
      return res.status(409).json({ success: false, message: 'Commence par préparer l’application.' });
    }
    if (!twoFactorService.verifyTotp(user.two_factor_totp_secret, req.body.code)) {
      return res.status(401).json({ success: false, message: 'Code incorrect' });
    }

    await user.update({
      two_factor_totp_enabled: true,
      two_factor_enabled_at: user.two_factor_enabled_at || new Date(),
    });

    const codes = await issueRecoveryCodes(user.id);
    return res.json({ success: true, message: 'Application d’authentification activée', data: { recoveryCodes: codes } });
  } catch (error) {
    logger.error('[2fa] totp/confirm:', error);
    return res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
  }
});

/**
 * Désactivation — mot de passe exigé.
 *
 * C'est l'opération qui AFFAIBLIT le compte : une session volée ne doit pas
 * pouvoir retirer la protection sans reprouver l'identité.
 */
router.post('/disable', [
  body('password').isString().isLength({ min: 1, max: 200 }),
  body('method').optional().isIn(['email', 'totp', 'all']),
  handleValidationErrors,
], async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id);
    if (!await user.comparePassword(req.body.password)) {
      return res.status(401).json({ success: false, message: 'Mot de passe incorrect' });
    }

    const method = req.body.method || 'all';
    const stillOn = (method === 'email' && user.two_factor_totp_enabled)
      || (method === 'totp' && user.two_factor_email_enabled);

    const patch = {};
    if (method === 'email' || method === 'all') patch.two_factor_email_enabled = false;
    if (method === 'totp' || method === 'all') {
      patch.two_factor_totp_enabled = false;
      patch.two_factor_totp_secret = null;
    }
    if (!stillOn) patch.two_factor_enabled_at = null;
    await user.update(patch);

    // Les codes de secours ne survivent pas à l'extinction complète : gardés,
    // ils resteraient une porte d'entrée sur un compte qui croit n'avoir plus
    // que son mot de passe.
    if (!stillOn) await TwoFactorRecoveryCode.destroy({ where: { user_id: user.id } });

    logger.info(`[2fa] Désactivée (${method}) pour ${user.username}`);
    return res.json({ success: true, message: 'Vérification en deux étapes désactivée' });
  } catch (error) {
    logger.error('[2fa] disable:', error);
    return res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
  }
});

/** Regénère les codes de secours (invalide les précédents). */
router.post('/recovery-codes', [
  body('password').isString().isLength({ min: 1, max: 200 }),
  handleValidationErrors,
], async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id);
    if (!await user.comparePassword(req.body.password)) {
      return res.status(401).json({ success: false, message: 'Mot de passe incorrect' });
    }
    const codes = await issueRecoveryCodes(user.id);
    return res.json({ success: true, data: { recoveryCodes: codes } });
  } catch (error) {
    logger.error('[2fa] recovery-codes:', error);
    return res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
  }
});

module.exports = router;
