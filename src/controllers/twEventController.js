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

const { TwEvent } = require('../models');
const eventQuestService = require('../services/eventQuestService');
const logger = require('../utils/logger');

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
}

module.exports = new TwEventController();
