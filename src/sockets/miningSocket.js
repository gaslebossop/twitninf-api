const authService = require('../services/authService');
const NewEconomyService = require('../services/newEconomyService');
const logger = require('../utils/logger');

/**
 * Minage temps réel (app Windows) : distribution des rounds et soumission des
 * nonces en WebSocket plutôt qu'en polling REST. Bénéfice principal : dès
 * qu'un round est résolu, tous les mineurs de la salle reçoivent le nouveau
 * défi instantanément, au lieu de le découvrir via un 409 puis un GET.
 */

const roomKey = (currencyId, engine) => `mining_${currencyId}_${engine}`;

// Un timer par salle : si personne ne résout le round avant son expiration,
// on en crée un nouveau et on le pousse à tout le monde sans attendre qu'un
// client relance une requête.
const expiryTimers = new Map();

function scheduleExpiryBroadcast(io, currencyId, engine, round) {
  const room = roomKey(currencyId, engine);
  const existing = expiryTimers.get(room);
  if (existing) clearTimeout(existing);

  const delay = Math.max(1000, new Date(round.expiresAt).getTime() - Date.now());
  const timer = setTimeout(async () => {
    try {
      const sockets = await io.in(room).fetchSockets();
      if (sockets.length === 0) {
        expiryTimers.delete(room);
        return;
      }
      const fresh = await NewEconomyService.getOrCreateMiningRound(currencyId, engine);
      io.to(room).emit('mining:round', serializeRound(fresh));
      scheduleExpiryBroadcast(io, currencyId, engine, fresh);
    } catch (error) {
      logger.error('[mining ws] erreur renouvellement round expiré:', error);
      expiryTimers.delete(room);
    }
  }, delay);

  expiryTimers.set(room, timer);
}

function serializeRound(round) {
  return {
    roundId: round.id,
    challenge: round.challenge,
    difficulty: round.difficulty,
    target: Number(round.target),
    reward: round.reward,
    engineType: round.engineType,
    expiresAt: round.expiresAt
  };
}

function registerMiningHandlers(io, socket) {
  socket.on('mining:join', async (payload = {}) => {
    try {
      const decoded = authService.verifyToken(payload.token);
      if (!decoded?.id) {
        socket.emit('mining:error', { message: 'Authentification requise' });
        return;
      }
      const { currencyId } = payload;
      const engine = payload.engine === 'gpu' ? 'gpu' : 'cpu';
      if (!currencyId) {
        socket.emit('mining:error', { message: 'currencyId requis' });
        return;
      }

      socket.data.miningUserId = decoded.id;
      socket.join(roomKey(currencyId, engine));

      const round = await NewEconomyService.getOrCreateMiningRound(currencyId, engine);
      socket.emit('mining:round', serializeRound(round));
      scheduleExpiryBroadcast(io, currencyId, engine, round);
    } catch (error) {
      logger.error('[mining ws] erreur mining:join:', error);
      socket.emit('mining:error', { message: 'Erreur serveur interne' });
    }
  });

  socket.on('mining:submit', async (payload = {}) => {
    try {
      const userId = socket.data.miningUserId;
      if (!userId) {
        socket.emit('mining:error', { message: 'Rejoignez un round avant de soumettre (mining:join)' });
        return;
      }

      const { currencyId, roundId, nonce } = payload;
      const engine = payload.engine === 'gpu' ? 'gpu' : 'cpu';
      if (!currencyId || !roundId || !nonce) {
        socket.emit('mining:error', { message: 'Paramètres de soumission invalides' });
        return;
      }

      const result = await NewEconomyService.submitMiningProof(userId, currencyId, roundId, nonce);

      socket.emit('mining:result', {
        reward: result.reward,
        difficulty: result.difficulty,
        newBalance: result.newBalance,
        dailyMiningCount: result.dailyMiningCount,
        dailyLimit: result.dailyLimit,
        currentPrice: result.currentPrice,
        priceMultiplier: result.priceMultiplier
      });

      // Diffusion instantanée du nouveau défi à toute la salle (y compris le gagnant).
      const room = roomKey(currencyId, result.engineType || engine);
      io.to(room).emit('mining:round', serializeRound(result.nextRound));
      scheduleExpiryBroadcast(io, currencyId, result.engineType || engine, result.nextRound);
    } catch (error) {
      const raced = error.code === 'ROUND_TAKEN' || error.code === 'ROUND_NOT_FOUND';
      const invalid = error.code === 'INVALID_PROOF';
      const limited = error.code === 'MINING_DAILY_LIMIT';
      if (!raced && !invalid && !limited) logger.error('[mining ws] erreur mining:submit:', error);
      socket.emit('mining:error', {
        code: error.code,
        message: (raced || invalid || limited) ? error.message : 'Erreur serveur interne'
      });
    }
  });
}

module.exports = { registerMiningHandlers };
