/**
 * Contrôleur du système d'événements unifié.
 *
 * Trois routes, et une règle qui les gouverne toutes : le client demande, le
 * serveur tranche. Rien de ce qu'il envoie n'est cru sur parole — ni une
 * progression, ni un droit à une récompense, ni le contenu d'un lot.
 *
 * Aucune de ces routes n'est critique pour l'app : un événement en panne doit
 * laisser lire un tweet. Les échecs répondent donc `200` avec
 * `success: false` et un message lisible, que le mobile affiche tel quel,
 * plutôt qu'un statut d'erreur qui ferait basculer l'écran en état cassé.
 */

const { TwEvent, TwEventPost, User } = require('../models');
const eventQuestService = require('../services/eventQuestService');
const logger = require('../utils/logger');

/** Le mot du livre d'or a la longueur d'un tweet, volontairement. */
const GUESTBOOK_MAX = 280;

/**
 * Ce que le client a le droit de voir d'une quête.
 *
 * `measure` est retiré : c'est le descripteur qui dit au serveur COMMENT
 * compter. Le publier reviendrait à donner la recette — « il suffit de likes
 * de comptes distincts », « la fenêtre va de telle heure à telle heure » — à
 * qui cherche à contourner plutôt qu'à jouer.
 */
function publicQuest(quest) {
  const { measure, ...rest } = quest || {};
  // La table de tirage part aussi : le client n'en montre que le `teaser`.
  if (rest.reward && rest.reward.pool) {
    const { pool, ...reward } = rest.reward;
    return { ...rest, reward };
  }
  return rest;
}

function publicEvent(event) {
  return {
    id: event.id,
    slug: event.slug,
    name: event.name,
    description: event.description,
    starts_at: event.starts_at,
    ends_at: event.ends_at,
    is_active: event.is_active,
    priority: event.priority,
    art: event.art,
    features: event.features || {},
    banner_message: event.banner_message,
    quests: (event.quests || []).map(publicQuest),
  };
}

class TwEventController {
  /**
   * GET /api/events/current
   *
   * `event: null` est une réponse de succès. C'est l'état le plus fréquent, et
   * le traiter comme une erreur ferait afficher un écran d'échec onze mois
   * sur douze.
   */
  async getCurrent(req, res) {
    try {
      const event = await TwEvent.getCurrent();
      if (!event) {
        return res.json({ success: true, message: 'Aucun événement', data: { event: null } });
      }

      const progress = await eventQuestService.measureAll(req.user.id, event);

      return res.json({
        success: true,
        message: 'Événement en cours',
        data: { event: publicEvent(event), progress },
      });
    } catch (error) {
      logger.error('getCurrent evenement:', error);
      // On rend un succès vide plutôt qu'une erreur : l'app perd sa
      // décoration, elle ne perd pas son fil.
      return res.json({ success: true, message: 'Événements indisponibles', data: { event: null } });
    }
  }

  /**
   * POST /api/events/:slug/quests/:questId/claim
   *
   * Le `slug` d'URL n'est pas utilisé pour choisir l'événement : le service
   * repart toujours de l'événement RÉELLEMENT actif. Sans cela, on pourrait
   * réclamer les quêtes d'un événement terminé en passant son ancien slug.
   */
  async claimQuest(req, res) {
    try {
      const result = await eventQuestService.claim(req.user.id, req.params.questId);
      return res.json({
        success: result.ok,
        message: result.message || (result.ok ? 'Récompense récupérée' : 'Récompense indisponible'),
        data: result.ok ? { granted: result.granted } : undefined,
      });
    } catch (error) {
      logger.error('claim quete:', error);
      return res.json({ success: false, message: 'Récompense indisponible pour le moment' });
    }
  }

  /**
   * POST /api/events/:slug/quests/:questId/report
   *
   * `amount` est ignoré volontairement. Le client propose un incrément ; le
   * serveur ne compte que des signaux DISTINCTS, dédupliqués par clé. Accepter
   * un montant reviendrait à laisser le client décider de sa progression, ce
   * que toute cette refonte cherche justement à empêcher.
   */
  async reportQuestSignal(req, res) {
    try {
      const { idempotency_key: idempotencyKey } = req.body || {};
      if (!idempotencyKey) {
        return res.json({ success: false, message: 'Clé d\'idempotence manquante' });
      }

      const event = await TwEvent.getCurrent();
      if (!event || event.slug !== req.params.slug) {
        return res.json({ success: false, message: 'Aucun événement en cours' });
      }

      const ok = await eventQuestService.reportSignal(
        req.user.id,
        event.slug,
        req.params.questId,
        idempotencyKey
      );
      return res.json({ success: ok, message: ok ? 'Signal enregistré' : 'Signal refusé' });
    } catch (error) {
      logger.error('signal de quete:', error);
      return res.json({ success: false, message: 'Signal refusé' });
    }
  }

  /**
   * GET /api/events/:slug/guestbook
   *
   * Le livre d'or : ce que les gens ont écrit. C'est la seule partie de
   * l'événement qui soit du contenu — donc la seule qui donne une raison de
   * revenir une fois les quêtes finies.
   */
  async getGuestbook(req, res) {
    try {
      const limit = Math.min(60, Math.max(1, parseInt(req.query.limit, 10) || 30));
      const posts = await TwEventPost.findAll({
        where: { event_slug: req.params.slug, hidden: false },
        order: [['created_at', 'DESC']],
        limit,
        include: [{ model: User, as: 'author', attributes: ['id', 'username', 'avatar', 'verified'] }],
      });

      const mine = await TwEventPost.findOne({
        where: { user_id: req.user.id, event_slug: req.params.slug },
      });

      return res.json({
        success: true,
        message: 'Livre d\'or',
        data: {
          posts: posts.map((p) => ({
            id: p.id,
            message: p.message,
            created_at: p.created_at,
            author: p.author
              ? {
                  id: p.author.id,
                  username: p.author.username,
                  avatar: p.author.avatar,
                  verified: p.author.verified,
                }
              : null,
          })),
          // Le client en a besoin pour montrer « tu as déjà signé » plutôt que
          // de proposer un champ qui sera refusé.
          mine: mine ? { id: mine.id, message: mine.message, created_at: mine.created_at } : null,
        },
      });
    } catch (error) {
      logger.error('livre d or (lecture):', error);
      return res.json({ success: true, message: 'Livre d\'or indisponible', data: { posts: [], mine: null } });
    }
  }

  /**
   * POST /api/events/:slug/guestbook
   *
   * Un message par compte, garanti par l'index unique et non par le contrôle
   * qui le précède : deux envois simultanés passent au travers d'un findOne.
   *
   * Écrire VALIDE aussi la quête du livre d'or — c'est le serveur qui pose le
   * signal, pas le client. Une quête dont l'accomplissement dépendrait d'un
   * appel séparé du mobile serait réclamable sans avoir rien écrit.
   */
  async postGuestbook(req, res) {
    try {
      const event = await TwEvent.getCurrent();
      if (!event || event.slug !== req.params.slug) {
        return res.json({ success: false, message: 'Aucun événement en cours' });
      }

      const message = String(req.body?.message ?? '').trim();
      if (!message) return res.json({ success: false, message: 'Message vide' });
      if (message.length > GUESTBOOK_MAX) {
        return res.json({ success: false, message: `Message trop long (${GUESTBOOK_MAX} caractères max)` });
      }

      let post;
      try {
        post = await TwEventPost.create({
          user_id: req.user.id,
          event_slug: event.slug,
          message,
        });
      } catch (error) {
        if (error?.name === 'SequelizeUniqueConstraintError') {
          return res.json({ success: false, message: 'Tu as déjà laissé un mot' });
        }
        throw error;
      }

      // La quête se valide ici, côté serveur, sur un fait constaté.
      const quest = (event.quests || []).find((q) => (q.measure || {}).source === 'signals' && q.id === 'guestbook');
      if (quest) {
        await eventQuestService.reportSignal(
          req.user.id,
          event.slug,
          quest.id,
          `${event.slug}:guestbook:${req.user.id}`
        );
      }

      return res.json({
        success: true,
        message: 'Merci pour le mot',
        data: { post: { id: post.id, message: post.message, created_at: post.created_at } },
      });
    } catch (error) {
      logger.error('livre d or (ecriture):', error);
      return res.json({ success: false, message: 'Message non enregistré' });
    }
  }
}

module.exports = new TwEventController();
