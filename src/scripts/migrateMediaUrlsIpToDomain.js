/**
 * Remplace dans la base les URLs qui pointent vers l’IP du serveur par le domaine public (HTTPS).
 * Utile après correction de l’upload d’avatars / médias (iOS ATS, certificats).
 *
 * Usage (depuis le dossier api):
 *   node src/scripts/migrateMediaUrlsIpToDomain.js
 *   DRY_RUN=1 node src/scripts/migrateMediaUrlsIpToDomain.js
 *
 * Variables d’environnement:
 *   MIGRATE_FROM_IP   IP à remplacer — OBLIGATOIRE (plus de valeur par défaut :
 *                     l'IP de l'ancien serveur était écrite ici, dans un dépôt
 *                     destiné à passer en public)
 *   MIGRATE_TO_ORIGIN ou PUBLIC_BASE_URL — origine sans slash final (défaut: https://twitninf.duckdns.org)
 */

const { Op } = require('sequelize');
const { User, Tweet, Conversation, sequelize, closeConnection } = require('../models');
const logger = require('../utils/logger');

const FROM_IP = (process.env.MIGRATE_FROM_IP || '').trim();
if (!FROM_IP) {
  console.error('MIGRATE_FROM_IP est obligatoire : préciser l\'IP à remplacer.');
  process.exit(1);
}
const TO_ORIGIN = (
  process.env.MIGRATE_TO_ORIGIN ||
  process.env.PUBLIC_BASE_URL ||
  'https://twitninf.duckdns.org'
)
  .trim()
  .replace(/\/$/, '');
const DRY_RUN =
  process.env.DRY_RUN === '1' ||
  process.env.DRY_RUN === 'true' ||
  process.env.DRY_RUN === 'yes';

function makeIpRegex(ip) {
  const escaped = ip.replace(/\./g, '\\.');
  return new RegExp(`https?://${escaped}(:\\d+)?`, 'gi');
}

function rewriteUrl(str, regex) {
  if (typeof str !== 'string') return str;
  return str.replace(regex, TO_ORIGIN);
}

async function migrateUsers(ipRegex) {
  const users = await User.findAll({
    where: { avatar: { [Op.like]: `%${FROM_IP}%` } },
    attributes: ['id', 'username', 'avatar']
  });
  let count = 0;
  for (const u of users) {
    const next = rewriteUrl(u.avatar, ipRegex);
    if (next === u.avatar) continue;
    logger.info(`[users] @${u.username}: ${u.avatar} -> ${next}`);
    if (!DRY_RUN) {
      await u.update({ avatar: next });
    }
    count += 1;
  }
  return count;
}

async function migrateConversations(ipRegex) {
  const rows = await Conversation.findAll({
    where: { avatar: { [Op.like]: `%${FROM_IP}%` } },
    attributes: ['id', 'avatar']
  });
  let count = 0;
  for (const c of rows) {
    const next = rewriteUrl(c.avatar, ipRegex);
    if (next === c.avatar) continue;
    logger.info(`[conversations] ${c.id}: ${c.avatar} -> ${next}`);
    if (!DRY_RUN) {
      await c.update({ avatar: next });
    }
    count += 1;
  }
  return count;
}

async function migrateTweets(ipRegex) {
  const safeIp = FROM_IP.replace(/[^0-9.]/g, '');
  if (safeIp !== FROM_IP) {
    throw new Error('MIGRATE_FROM_IP invalide (caractères non autorisés)');
  }

  const tweets = await Tweet.findAll({
    where: sequelize.literal(`media_urls::text LIKE '%${safeIp}%'`),
    attributes: ['id', 'media_urls']
  });
  let count = 0;
  for (const t of tweets) {
    const arr = t.media_urls;
    if (!Array.isArray(arr)) continue;
    const nextArr = arr.map((u) => rewriteUrl(u, ipRegex));
    if (JSON.stringify(nextArr) === JSON.stringify(arr)) continue;
    logger.info(`[tweets] ${t.id}: ${JSON.stringify(arr)} -> ${JSON.stringify(nextArr)}`);
    if (!DRY_RUN) {
      await t.update({ media_urls: nextArr });
    }
    count += 1;
  }
  return count;
}

async function main() {
  const ipRegex = makeIpRegex(FROM_IP);

  try {
    logger.info(
      `Migration URLs: ${FROM_IP} -> ${TO_ORIGIN} | DRY_RUN=${DRY_RUN}`
    );

    const nUsers = await migrateUsers(ipRegex);
    const nConv = await migrateConversations(ipRegex);
    const nTweets = await migrateTweets(ipRegex);

    logger.info(
      `Terminé — users: ${nUsers}, conversations: ${nConv}, tweets: ${nTweets}${
        DRY_RUN ? ' (aucune écriture, DRY_RUN)' : ''
      }`
    );
  } catch (err) {
    logger.error('Erreur migration URLs:', err);
    process.exitCode = 1;
  } finally {
    await closeConnection();
  }
}

main();
