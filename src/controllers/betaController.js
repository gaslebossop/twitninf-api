'use strict';

/**
 * 🧪 Programme beta — surface HTTP.
 *
 * Trois publics, trois niveaux de détail :
 *   - le VISITEUR (`/public`) ne voit que des compteurs et le texte de la
 *     vitrine. Jamais un pseudo, jamais une liste : publier la composition
 *     de la cohorte depuis une page ouverte serait exactement le défaut déjà
 *     évité côté drapeaux ;
 *   - l'UTILISATEUR connecté voit son propre statut et rien d'autre ;
 *   - l'ADMIN voit la file, le roster et les réglages.
 *
 * Le contrôleur ne décide rien : il lit la requête, appelle `betaService` et
 * traduit une `BetaError` en réponse. Toute la logique métier est dans le
 * service, y compris la purge du cache d'attributs.
 */

const beta = require('../services/betaService');
const logger = require('../utils/logger');

function fail(res, status, message, extra = {}) {
  return res.status(status).json({ success: false, message, ...extra });
}

/**
 * Traduit une erreur en réponse. Une `BetaError` porte déjà son statut et un
 * message écrit pour être affiché ; tout le reste est un vrai incident et
 * part dans le journal en `error`.
 */
function handle(res, error, context) {
  if (error instanceof beta.BetaError) {
    return fail(res, error.status, error.message, error.extra);
  }
  logger.error(`[beta] ${context} : ${error.message}`);
  return fail(res, 500, 'Erreur interne du programme beta.');
}

/** D'où vient la candidature, lu sur les en-têtes du client officiel. */
function originFromRequest(req) {
  const platform = (req.get('User-Platform') || '').toLowerCase() || null;
  const client = (req.get('X-TwitNinf-Client') || '').toLowerCase() || null;

  let source = 'web';
  if (platform === 'ios' || platform === 'android') source = 'mobile';
  else if (platform === 'windows' || client === 'windows') source = 'windows';

  return {
    source,
    platform: platform || (source === 'web' ? 'web' : null),
    app_version: req.get('X-App-Version') || null,
  };
}

// ─────────────────────────────── Public ───────────────────────────────

exports.publicProgram = async (req, res) => {
  try {
    const program = await beta.publicProgram();
    return res.json({ success: true, program });
  } catch (error) {
    return handle(res, error, 'publicProgram');
  }
};

// ───────────────────────────── Utilisateur ─────────────────────────────

exports.me = async (req, res) => {
  try {
    const status = await beta.statusFor(req.user.id);
    return res.json({ success: true, ...status });
  } catch (error) {
    return handle(res, error, 'me');
  }
};

exports.apply = async (req, res) => {
  try {
    await beta.apply(req.user.id, {
      motivation: req.body?.motivation ?? null,
      ...originFromRequest(req),
    });
    const status = await beta.statusFor(req.user.id);
    return res.json({ success: true, message: 'Candidature enregistrée.', ...status });
  } catch (error) {
    return handle(res, error, 'apply');
  }
};

exports.leave = async (req, res) => {
  try {
    await beta.leave(req.user.id);
    const status = await beta.statusFor(req.user.id);
    return res.json({ success: true, message: 'Tu as quitté la beta.', ...status });
  } catch (error) {
    return handle(res, error, 'leave');
  }
};

// ─────────────────────────────── Admin ───────────────────────────────

exports.listMembers = async (req, res) => {
  try {
    const { total, members } = await beta.listMembers({
      status: req.query.status || null,
      q: req.query.q || null,
      limit: req.query.limit,
      offset: req.query.offset,
    });

    return res.json({
      success: true,
      total,
      members: members.map((member) => ({
        user_id: member.user_id,
        status: member.status,
        motivation: member.motivation ?? null,
        source: member.source ?? null,
        platform: member.platform ?? null,
        app_version: member.app_version ?? null,
        applied_at: member.applied_at,
        reviewed_at: member.reviewed_at,
        approved_at: member.approved_at,
        revoked_at: member.revoked_at,
        review_note: member.review_note ?? null,
        user: member.user
          ? {
              id: member.user.id,
              username: member.user.username,
              full_name: member.user.full_name,
              avatar: member.user.avatar,
              verified: member.user.verified,
            }
          : null,
      })),
    });
  } catch (error) {
    return handle(res, error, 'listMembers');
  }
};

exports.approve = async (req, res) => {
  try {
    await beta.approve(req.params.userId, req.user.id, {
      force: req.body?.force === true || req.query.force === 'true',
      note: req.body?.note ?? null,
    });
    return res.json({ success: true, message: 'Compte admis dans la beta.' });
  } catch (error) {
    return handle(res, error, 'approve');
  }
};

exports.reject = async (req, res) => {
  try {
    await beta.reject(req.params.userId, req.user.id, { note: req.body?.note ?? null });
    return res.json({ success: true, message: 'Candidature refusée.' });
  } catch (error) {
    return handle(res, error, 'reject');
  }
};

exports.revoke = async (req, res) => {
  try {
    await beta.revoke(req.params.userId, req.user.id, { note: req.body?.note ?? null });
    return res.json({ success: true, message: 'Membre retiré de la beta.' });
  } catch (error) {
    return handle(res, error, 'revoke');
  }
};

exports.invite = async (req, res) => {
  try {
    const member = await beta.invite(
      { user_id: req.body?.user_id ?? null, username: req.body?.username ?? null },
      req.user.id,
      { note: req.body?.note ?? null }
    );
    return res.json({ success: true, message: 'Compte ajouté à la beta.', user_id: member.user_id });
  } catch (error) {
    return handle(res, error, 'invite');
  }
};

exports.stats = async (req, res) => {
  try {
    const stats = await beta.stats();
    return res.json({ success: true, ...stats });
  } catch (error) {
    return handle(res, error, 'stats');
  }
};

exports.getSettings = async (req, res) => {
  try {
    const settings = await beta.getSettings();
    return res.json({
      success: true,
      settings: {
        is_open: settings.is_open,
        capacity: settings.capacity ?? null,
        headline: settings.headline,
        pitch: settings.pitch ?? null,
        updated_at: settings.updated_at,
      },
    });
  } catch (error) {
    return handle(res, error, 'getSettings');
  }
};

exports.updateSettings = async (req, res) => {
  try {
    const settings = await beta.updateSettings(req.body || {}, req.user.id);
    return res.json({
      success: true,
      message: 'Réglages enregistrés.',
      settings: {
        is_open: settings.is_open,
        capacity: settings.capacity ?? null,
        headline: settings.headline,
        pitch: settings.pitch ?? null,
        updated_at: settings.updated_at,
      },
    });
  } catch (error) {
    return handle(res, error, 'updateSettings');
  }
};
