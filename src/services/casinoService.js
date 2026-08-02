const crypto = require('crypto');
const { CasinoBet } = require('../models');
const { sequelize } = require('../database/index');
const EconomyLedger = require('../economy/ledger');
const EconomyMetrics = require('../economy/metrics');
const { roundTWC, toAmount } = require('../economy/money');
const {
  CASINO_HOUSE_EDGE,
  CASINO_MIN_BET_TWC,
  CASINO_MAX_BET_TWC,
  CASINO_MIN_WIN_CHANCE,
  CASINO_MAX_WIN_CHANCE,
  CASINO_WHEEL_MAX_WIN_SCALE
} = require('../economy/constants');

const WHEEL_MODES = {
  classic: {
    label: 'Classique',
    hint: 'Roue equilibree, gains courts',
    jackpotLabel: 'x4',
    segments: [
      { label: 'LOSE', multiplier: 0 }, { label: 'x1.2', multiplier: 1.2 },
      { label: 'LOSE', multiplier: 0 }, { label: 'x1.8', multiplier: 1.8 },
      { label: 'LOSE', multiplier: 0 }, { label: 'LOSE', multiplier: 0 },
      { label: 'x1.2', multiplier: 1.2 }, { label: 'LOSE', multiplier: 0 },
      { label: 'x4', multiplier: 4 }, { label: 'LOSE', multiplier: 0 },
      { label: 'x1.2', multiplier: 1.2 }, { label: 'LOSE', multiplier: 0 },
      { label: 'LOSE', multiplier: 0 }, { label: 'x1.8', multiplier: 1.8 },
      { label: 'LOSE', multiplier: 0 }, { label: 'x1.2', multiplier: 1.2 },
      { label: 'LOSE', multiplier: 0 }, { label: 'LOSE', multiplier: 0 },
      { label: 'x1.2', multiplier: 1.2 }, { label: 'LOSE', multiplier: 0 }
    ]
  },
  boost: {
    label: 'Boost',
    hint: 'Moins de petits gains, plus de multiplicateurs',
    jackpotLabel: 'x6',
    segments: [
      { label: 'LOSE', multiplier: 0 }, { label: 'x1.5', multiplier: 1.5 },
      { label: 'LOSE', multiplier: 0 }, { label: 'LOSE', multiplier: 0 },
      { label: 'x2', multiplier: 2 }, { label: 'LOSE', multiplier: 0 },
      { label: 'LOSE', multiplier: 0 }, { label: 'x1.5', multiplier: 1.5 },
      { label: 'LOSE', multiplier: 0 }, { label: 'x3', multiplier: 3 },
      { label: 'LOSE', multiplier: 0 }, { label: 'LOSE', multiplier: 0 },
      { label: 'x1.5', multiplier: 1.5 }, { label: 'LOSE', multiplier: 0 },
      { label: 'LOSE', multiplier: 0 }, { label: 'x6', multiplier: 6 },
      { label: 'LOSE', multiplier: 0 }, { label: 'LOSE', multiplier: 0 },
      { label: 'x2', multiplier: 2 }, { label: 'LOSE', multiplier: 0 }
    ]
  },
  jackpot: {
    label: 'Jackpot',
    hint: 'Peu de cases fortes, gros swings',
    jackpotLabel: 'x10',
    segments: [
      { label: 'LOSE', multiplier: 0 }, { label: 'LOSE', multiplier: 0 },
      { label: 'x2', multiplier: 2 }, { label: 'LOSE', multiplier: 0 },
      { label: 'LOSE', multiplier: 0 }, { label: 'LOSE', multiplier: 0 },
      { label: 'x5', multiplier: 5 }, { label: 'LOSE', multiplier: 0 },
      { label: 'LOSE', multiplier: 0 }, { label: 'LOSE', multiplier: 0 },
      { label: 'x2', multiplier: 2 }, { label: 'LOSE', multiplier: 0 },
      { label: 'LOSE', multiplier: 0 }, { label: 'LOSE', multiplier: 0 },
      { label: 'x10', multiplier: 10 }, { label: 'LOSE', multiplier: 0 },
      { label: 'LOSE', multiplier: 0 }, { label: 'LOSE', multiplier: 0 },
      { label: 'x2', multiplier: 2 }, { label: 'LOSE', multiplier: 0 }
    ]
  }
};

function getWheelMode(mode = 'classic') {
  return WHEEL_MODES[mode] || WHEEL_MODES.classic;
}

/**
 * "Pile ou face" : jeu à faible variance, pensé pour perdre moins souvent que
 * la roue/les dés, mais un gain ne rapporte qu'un profit modeste (+20%). La
 * "tranche" (pièce sur la tranche — un vrai phénomène, juste très rare en
 * réalité) sert ici de troisième issue : ni gain ni perte, mise rendue.
 * EV ≈ 0.74 (avantage maison ~26%), du même ordre que la roue/les dés.
 */
const COINFLIP_WIN_CHANCE = 0.45;
const COINFLIP_PUSH_CHANCE = 0.20;
const COINFLIP_WIN_MULTIPLIER = 1.2;

/**
 * "Machine à sous" : jeu à forte variance, l'inverse du pile ou face — très
 * difficile à gagner (~12% toutes combinaisons confondues), mais le symbole
 * le plus rare paie une somme énorme. weight/1000 = probabilité par rouleau;
 * un alignement des 3 rouleaux sur le même symbole paie son multiplicateur.
 * EV ≈ 0.28 (avantage maison ~72%) : assumé et voulu, c'est le jeu "quitte ou
 * double" de la maison — contrairement aux autres jeux, aucune tentative de
 * rapprocher son avantage maison de celui des autres modes.
 */
const SLOT_SYMBOLS = [
  { id: 'cherry', label: '🍒', weight: 450, multiplier: 1.5 },
  { id: 'lemon', label: '🍋', weight: 300, multiplier: 3 },
  { id: 'bell', label: '🔔', weight: 150, multiplier: 10 },
  { id: 'star', label: '⭐', weight: 80, multiplier: 50 },
  { id: 'diamond', label: '💎', weight: 15, multiplier: 250 },
  { id: 'seven', label: '7️⃣', weight: 5, multiplier: 500 }
];
const SLOT_TOTAL_WEIGHT = SLOT_SYMBOLS.reduce((sum, s) => sum + s.weight, 0);
const SLOT_WIN_CHANCE = SLOT_SYMBOLS.reduce((sum, s) => sum + (s.weight / SLOT_TOTAL_WEIGHT) ** 3, 0);

function drawSlotSymbol() {
  let roll = crypto.randomInt(0, SLOT_TOTAL_WEIGHT);
  for (const symbol of SLOT_SYMBOLS) {
    if (roll < symbol.weight) return symbol;
    roll -= symbol.weight;
  }
  return SLOT_SYMBOLS[SLOT_SYMBOLS.length - 1];
}

/**
 * Casino "dice" : le joueur choisit une chance de gain (%), le multiplicateur
 * de gain en découle mathématiquement pour garder l'avantage maison constant
 * quel que soit le pari — comme un vrai casino en ligne (roll < winChance = gagné).
 */
function rollPercent() {
  // 0.0000–99.9999, tirage cryptographique (pas de biais Math.random)
  const value = crypto.randomInt(0, 1000000);
  return Math.round((value / 10000) * 10000) / 10000;
}

function computeMultiplier(winChance) {
  return roundTWC((100 / winChance) * (1 - CASINO_HOUSE_EDGE));
}

function computeNetProfit(bet, payout) {
  return roundTWC(payout - bet);
}

/**
 * Chance de gain de la roue pour CE mode et CETTE mise. Interpole linéairement
 * entre la proportion naturelle de cases gagnantes du mode (à mise minimale)
 * et cette même proportion × CASINO_WHEEL_MAX_WIN_SCALE (à mise maximale) :
 * miser plus donne une vraie meilleure chance de gagner ce tour précis. Les
 * multiplicateurs des cases restent ceux du mode (inchangés), donc plafonner
 * ce facteur (voir constants.js) est ce qui garde l'espérance sous contrôle,
 * pas cette fonction.
 */
function computeWheelWinChance(wheelMode, bet) {
  const baseChance = wheelMode.segments.filter(s => s.multiplier > 0).length / wheelMode.segments.length;
  const t = Math.max(0, Math.min(1, (bet - CASINO_MIN_BET_TWC) / (CASINO_MAX_BET_TWC - CASINO_MIN_BET_TWC)));
  const scale = 1 + t * (CASINO_WHEEL_MAX_WIN_SCALE - 1);
  return Math.min(0.9, baseChance * scale);
}

class CasinoService {
  static getConfig() {
    return {
      minBet: CASINO_MIN_BET_TWC,
      maxBet: CASINO_MAX_BET_TWC,
      minWinChance: CASINO_MIN_WIN_CHANCE,
      maxWinChance: CASINO_MAX_WIN_CHANCE,
      wheel: {
        defaultMode: 'classic',
        modes: Object.entries(WHEEL_MODES).map(([id, mode]) => ({
          id,
          label: mode.label,
          hint: mode.hint,
          jackpotLabel: mode.jackpotLabel,
          segments: mode.segments.map(segment => segment.label),
          prizes: [...new Set(mode.segments.filter(segment => segment.multiplier > 0).map(segment => segment.label))]
        }))
      },
      coinflip: {
        label: 'Pile ou face',
        hint: 'Petit profit frequent, tres peu risque',
        winChance: roundTWC(COINFLIP_WIN_CHANCE * 100),
        pushChance: roundTWC(COINFLIP_PUSH_CHANCE * 100),
        loseChance: roundTWC((1 - COINFLIP_WIN_CHANCE - COINFLIP_PUSH_CHANCE) * 100),
        winMultiplier: COINFLIP_WIN_MULTIPLIER
      },
      slots: {
        label: 'Machine a sous',
        hint: 'Tres difficile a gagner, jackpot enorme si tu alignes',
        winChance: roundTWC(SLOT_WIN_CHANCE * 100),
        paytable: SLOT_SYMBOLS.map(s => ({
          id: s.id,
          label: s.label,
          multiplier: s.multiplier,
          chancePercent: roundTWC(((s.weight / SLOT_TOTAL_WEIGHT) ** 3) * 100)
        }))
      }
    };
  }

  static async playWheel(userId, currencyId, betAmount, mode = 'classic') {
    const bet = roundTWC(Number(betAmount));

    if (!Number.isFinite(bet) || bet < CASINO_MIN_BET_TWC || bet > CASINO_MAX_BET_TWC) {
      throw new Error(`Mise invalide : entre ${CASINO_MIN_BET_TWC} et ${CASINO_MAX_BET_TWC} NF`);
    }

    const modeId = WHEEL_MODES[mode] ? mode : 'classic';
    const wheelMode = getWheelMode(modeId);
    const winChance = computeWheelWinChance(wheelMode, bet);
    const won = (crypto.randomInt(0, 1000000) / 1000000) < winChance;
    const pool = wheelMode.segments.filter(s => (s.multiplier > 0) === won);
    const segment = pool[crypto.randomInt(0, pool.length)];
    const segmentIndex = wheelMode.segments.indexOf(segment);
    const multiplier = segment.multiplier;
    const payout = won ? roundTWC(bet * multiplier) : 0;
    const netProfit = computeNetProfit(bet, payout);
    const roll = roundTWC(((segmentIndex + 0.5) / wheelMode.segments.length) * 100);

    const dbTransaction = await sequelize.transaction();
    try {
      const spend = await EconomyLedger.spendToTreasury(
        userId,
        currencyId,
        bet,
        { description: `Casino roue ${wheelMode.label} - mise ${bet} NF`, itemType: 'casino', itemId: 'wheel', riskExemption: EconomyLedger.CASINO_RISK_EXEMPTION, metadata: { game: 'wheel', mode: modeId, segment: segment.label, multiplier } },
        dbTransaction
      );

      let newBalance = spend.remainingBalance;
      if (won) {
        const reward = await EconomyLedger.rewardFromTreasury(
          userId,
          currencyId,
          payout,
          `Casino roue ${wheelMode.label} - gain (mise ${bet} NF ${segment.label})`,
          dbTransaction
        );
        newBalance = toAmount(reward.wallet.balance);
      }

      await CasinoBet.create({
        userId,
        currencyId,
        game: 'wheel',
        betAmount: bet,
        winChance: roundTWC(winChance * 100),
        multiplier,
        roll,
        won,
        payout
      }, { transaction: dbTransaction });

      await EconomyMetrics.refresh(currencyId, dbTransaction);
      await dbTransaction.commit();

      return {
        game: 'wheel',
        mode: modeId,
        modeLabel: wheelMode.label,
        won,
        segmentIndex,
        segment: segment.label,
        multiplier,
        bet,
        payout,
        netProfit,
        newBalance
      };
    } catch (error) {
      await dbTransaction.rollback();
      throw error;
    }
  }

  static async playDice(userId, currencyId, betAmount, winChance) {
    const bet = roundTWC(Number(betAmount));
    const chance = Math.round(Number(winChance) * 100) / 100;

    if (!Number.isFinite(bet) || bet < CASINO_MIN_BET_TWC || bet > CASINO_MAX_BET_TWC) {
      throw new Error(`Mise invalide : entre ${CASINO_MIN_BET_TWC} et ${CASINO_MAX_BET_TWC} NF`);
    }
    if (!Number.isFinite(chance) || chance < CASINO_MIN_WIN_CHANCE || chance > CASINO_MAX_WIN_CHANCE) {
      throw new Error(`Chance de gain invalide : entre ${CASINO_MIN_WIN_CHANCE} % et ${CASINO_MAX_WIN_CHANCE} %`);
    }

    const multiplier = computeMultiplier(chance);
    const roll = rollPercent();
    const won = roll < chance;
    const payout = won ? roundTWC(bet * multiplier) : 0;
    const netProfit = computeNetProfit(bet, payout);

    const dbTransaction = await sequelize.transaction();
    try {
      const spend = await EconomyLedger.spendToTreasury(
        userId,
        currencyId,
        bet,
        { description: `Casino dés — mise ${bet} NF (${chance}% de chance)`, itemType: 'casino', itemId: 'dice', riskExemption: EconomyLedger.CASINO_RISK_EXEMPTION, metadata: { game: 'dice', winChance: chance, multiplier } },
        dbTransaction
      );

      let newBalance = spend.remainingBalance;
      if (won) {
        const reward = await EconomyLedger.rewardFromTreasury(
          userId,
          currencyId,
          payout,
          `Casino dés — gain (mise ${bet} NF x${multiplier})`,
          dbTransaction
        );
        newBalance = toAmount(reward.wallet.balance);
      }

      await CasinoBet.create({
        userId,
        currencyId,
        game: 'dice',
        betAmount: bet,
        winChance: chance,
        multiplier,
        roll,
        won,
        payout
      }, { transaction: dbTransaction });

      await EconomyMetrics.refresh(currencyId, dbTransaction);
      await dbTransaction.commit();

      return { won, roll, winChance: chance, multiplier, bet, payout, netProfit, newBalance };
    } catch (error) {
      await dbTransaction.rollback();
      throw error;
    }
  }

  static async playCoinflip(userId, currencyId, betAmount, choice) {
    const bet = roundTWC(Number(betAmount));
    const pick = choice === 'face' ? 'face' : 'pile';

    if (!Number.isFinite(bet) || bet < CASINO_MIN_BET_TWC || bet > CASINO_MAX_BET_TWC) {
      throw new Error(`Mise invalide : entre ${CASINO_MIN_BET_TWC} et ${CASINO_MAX_BET_TWC} NF`);
    }

    // L'issue (gain/tranche/perte) est tirée directement selon les chances
    // cibles — pas une pièce "juste" biaisée après coup : la tranche n'existe
    // pas dans un tirage pile/face à 2 issues, elle est une 3e catégorie à
    // part entière, comme un vrai jeton qui atterrit sur sa tranche.
    const roll = crypto.randomInt(0, 1000000) / 1000000;
    let outcome, result, payout;
    if (roll < COINFLIP_WIN_CHANCE) {
      outcome = 'win'; result = pick; payout = roundTWC(bet * COINFLIP_WIN_MULTIPLIER);
    } else if (roll < COINFLIP_WIN_CHANCE + COINFLIP_PUSH_CHANCE) {
      outcome = 'push'; result = 'tranche'; payout = bet;
    } else {
      outcome = 'lose'; result = pick === 'pile' ? 'face' : 'pile'; payout = 0;
    }
    const won = outcome === 'win';
    const netProfit = computeNetProfit(bet, payout);

    const dbTransaction = await sequelize.transaction();
    try {
      const spend = await EconomyLedger.spendToTreasury(
        userId,
        currencyId,
        bet,
        { description: `Casino pile ou face — mise ${bet} NF sur ${pick}`, itemType: 'casino', itemId: 'coinflip', riskExemption: EconomyLedger.CASINO_RISK_EXEMPTION, metadata: { game: 'coinflip', choice: pick, outcome } },
        dbTransaction
      );

      let newBalance = spend.remainingBalance;
      if (payout > 0) {
        const reward = await EconomyLedger.rewardFromTreasury(
          userId,
          currencyId,
          payout,
          outcome === 'push'
            ? `Casino pile ou face — tranche, mise ${bet} NF rendue`
            : `Casino pile ou face — gain (mise ${bet} NF x${COINFLIP_WIN_MULTIPLIER})`,
          dbTransaction
        );
        newBalance = toAmount(reward.wallet.balance);
      }

      await CasinoBet.create({
        userId,
        currencyId,
        game: 'coinflip',
        betAmount: bet,
        winChance: roundTWC(COINFLIP_WIN_CHANCE * 100),
        multiplier: outcome === 'win' ? COINFLIP_WIN_MULTIPLIER : (outcome === 'push' ? 1 : 0),
        roll: roundTWC(roll * 100),
        won,
        payout
      }, { transaction: dbTransaction });

      await EconomyMetrics.refresh(currencyId, dbTransaction);
      await dbTransaction.commit();

      return { game: 'coinflip', choice: pick, result, outcome, won, bet, payout, netProfit, newBalance };
    } catch (error) {
      await dbTransaction.rollback();
      throw error;
    }
  }

  static async playSlots(userId, currencyId, betAmount) {
    const bet = roundTWC(Number(betAmount));

    if (!Number.isFinite(bet) || bet < CASINO_MIN_BET_TWC || bet > CASINO_MAX_BET_TWC) {
      throw new Error(`Mise invalide : entre ${CASINO_MIN_BET_TWC} et ${CASINO_MAX_BET_TWC} NF`);
    }

    const reels = [drawSlotSymbol(), drawSlotSymbol(), drawSlotSymbol()];
    const won = reels[0].id === reels[1].id && reels[1].id === reels[2].id;
    const matchedSymbol = won ? reels[0] : null;
    const multiplier = won ? matchedSymbol.multiplier : 0;
    const payout = won ? roundTWC(bet * multiplier) : 0;
    const netProfit = computeNetProfit(bet, payout);

    const dbTransaction = await sequelize.transaction();
    try {
      const spend = await EconomyLedger.spendToTreasury(
        userId,
        currencyId,
        bet,
        { description: `Casino machine a sous — mise ${bet} NF`, itemType: 'casino', itemId: 'slots', riskExemption: EconomyLedger.CASINO_RISK_EXEMPTION, metadata: { game: 'slots', reels: reels.map(r => r.id) } },
        dbTransaction
      );

      let newBalance = spend.remainingBalance;
      if (won) {
        const reward = await EconomyLedger.rewardFromTreasury(
          userId,
          currencyId,
          payout,
          `Casino machine a sous — ${matchedSymbol.label}${matchedSymbol.label}${matchedSymbol.label} (x${multiplier}) sur mise ${bet} NF`,
          dbTransaction
        );
        newBalance = toAmount(reward.wallet.balance);
      }

      await CasinoBet.create({
        userId,
        currencyId,
        game: 'slots',
        betAmount: bet,
        winChance: roundTWC(SLOT_WIN_CHANCE * 100),
        multiplier,
        roll: 0,
        won,
        payout
      }, { transaction: dbTransaction });

      await EconomyMetrics.refresh(currencyId, dbTransaction);
      await dbTransaction.commit();

      return {
        game: 'slots',
        reels: reels.map(r => ({ id: r.id, label: r.label })),
        won,
        matchedSymbol: matchedSymbol?.id || null,
        multiplier,
        bet,
        payout,
        netProfit,
        newBalance
      };
    } catch (error) {
      await dbTransaction.rollback();
      throw error;
    }
  }

  static async getHistory(userId, limit = 30) {
    const rows = await CasinoBet.findAll({
      where: { userId },
      order: [['createdAt', 'DESC']],
      limit: Math.max(1, Math.min(100, Number(limit) || 30))
    });
    return rows.map(row => ({
      id: row.id,
      game: row.game,
      betAmount: toAmount(row.betAmount),
      winChance: toAmount(row.winChance),
      multiplier: toAmount(row.multiplier),
      roll: toAmount(row.roll),
      won: row.won,
      payout: toAmount(row.payout),
      netProfit: computeNetProfit(toAmount(row.betAmount), toAmount(row.payout)),
      createdAt: row.createdAt
    }));
  }
}

module.exports = CasinoService;
