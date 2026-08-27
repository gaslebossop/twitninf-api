'use strict';

/**
 * 🎯 Moteur d'évaluation des drapeaux de fonctionnalité — PUR.
 *
 * Ce module ne connaît ni la base, ni Redis, ni Express : on lui donne une
 * définition et un contexte, il rend une décision. C'est délibéré, et c'est
 * ce qui rend le système utilisable à l'échelle :
 *
 *   - **Aucune I/O par évaluation.** Les définitions sont chargées une fois
 *     puis mises en cache ; décider si un utilisateur voit une fonctionnalité
 *     coûte un hash, pas une requête. On peut donc appeler `isEnabled()` dans
 *     une boucle de rendu de feed sans y penser.
 *   - **Testable sans infrastructure.**
 *   - **Reproductible.** L'écran d'administration simule « qu'est-ce que
 *     l'utilisateur X verrait ? » avec exactement ce code, donc la simulation
 *     ne peut pas mentir.
 *
 * Le hash est un FNV-1a 32 bits réimplémenté à la main plutôt qu'un
 * `crypto.createHash('sha1')` : le client mobile doit pouvoir calculer le même
 * bucket hors ligne, en JavaScript, sans dépendance native. Un hash
 * cryptographique n'apporterait rien ici — on répartit, on ne protège rien.
 */

/** Granularité du tirage : 10 000 paniers, soit un pas de 0,01 %. */
const BUCKET_SPACE = 10000;

const OPERATORS = [
  'eq',
  'neq',
  'in',
  'not_in',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'starts_with',
  'exists',
  'not_exists',
  'semver_gte',
  'semver_lt',
];

/** Attributs de contexte reconnus, avec leur type — sert aussi à l'UI admin. */
/**
 * Type d'audience d'un drapeau — QUI la fonctionnalité vise, par nature.
 *
 * `rollout` : le comportement historique. L'audience est un pourcentage du
 *   trafic, éventuellement affiné par des segments.
 *
 * `beta` : la fonctionnalité appartient au PROGRAMME BETA. Elle est servie aux
 *   membres, à personne d'autre, et `rollout_percentage` n'est plus consulté
 *   du tout.
 *
 * Pourquoi un type plutôt qu'un segment `is_beta eq true` écrit à la main :
 *   - un segment laisse le palier global actif DERRIÈRE lui. Le relever, même
 *     par mégarde depuis l'écran mobile, sert la fonctionnalité hors de la
 *     beta sans que rien ne le signale ;
 *   - l'écran d'administration mobile ne sait pas lire un segment arbitraire :
 *     il affiche « ciblage personnalisé » et verrouille le bloc. Le type, lui,
 *     est une donnée simple qu'il peut montrer ;
 *   - l'intention est lisible dans la ligne elle-même. « Cette fonctionnalité
 *     est en beta » se lit ; un tableau de conditions se déchiffre.
 */
const AUDIENCES = ['rollout', 'beta'];

const ATTRIBUTES = {
  // Identité
  user_id: 'string',
  username: 'string',
  role: 'string',
  // Statut du compte
  verified: 'boolean',
  premium: 'boolean',
  subscription_tier: 'string',
  account_age_days: 'number',
  followers: 'number',
  tweets: 'number',
  preferred_language: 'string',
  is_data_test: 'boolean',
  // Attributs résolus à la demande (une requête, mise en cache)
  country: 'string',
  nf_balance: 'number',
  // Appartenance au programme beta. Vrai UNIQUEMENT pour un compte dont la
  // ligne `beta_members` est en statut `approved` — voir models/BetaMember.js.
  is_beta: 'boolean',
  // Technique — vient des en-têtes envoyés par le client officiel
  platform: 'string',
  app_version: 'semver',
  client: 'string',
  device_id: 'string',
};

/**
 * Attributs dont la valeur coûte une requête : le service ne les résout que
 * si une règle les mentionne réellement. Un drapeau qui ne cible pas le pays
 * ne doit pas provoquer de lecture supplémentaire.
 */
const LAZY_ATTRIBUTES = ['country', 'nf_balance', 'is_beta'];

/** FNV-1a 32 bits. Déterministe, stable entre Node et Hermes. */
function hash32(input) {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    // Multiplication par 16777619 en arithmétique 32 bits non signée.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/**
 * Panier stable d'une unité pour un drapeau donné, dans [0, 9999].
 * La clé du drapeau entre dans le hash : deux drapeaux à 10 % ne ciblent donc
 * pas les mêmes personnes, sinon les cohortes de test se superposeraient et
 * les résultats seraient inexploitables.
 */
function bucketOf(flagKey, salt, unitId) {
  return hash32(`${flagKey}:${salt || 'v1'}:${unitId}`) % BUCKET_SPACE;
}

/** Compare deux versions sémantiques. Renvoie -1, 0 ou 1. */
function compareSemver(a, b) {
  const parse = (v) =>
    String(v || '0')
      .split('-')[0]
      .split('.')
      .map((n) => parseInt(n, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const l = left[i] || 0;
    const r = right[i] || 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined || value === '') return [];
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function looseEquals(a, b) {
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    const norm = (v) => v === true || v === 'true' || v === 1 || v === '1';
    return norm(a) === norm(b);
  }
  if (typeof a === 'number' || typeof b === 'number') {
    return Number(a) === Number(b);
  }
  return String(a).toLowerCase() === String(b).toLowerCase();
}

/** Une condition unitaire : `{ attribute, operator, value }`. */
function matchCondition(condition, context) {
  if (!condition || !condition.attribute) return false;
  const actual = context[condition.attribute];
  const expected = condition.value;

  switch (condition.operator) {
    case 'exists':
      return actual !== null && actual !== undefined && actual !== '';
    case 'not_exists':
      return actual === null || actual === undefined || actual === '';
    default:
      break;
  }

  // Un attribut absent ne matche aucun opérateur de comparaison. C'est le
  // choix prudent : une app trop ancienne pour envoyer sa version ne doit pas
  // se retrouver incluse dans un ciblage « version >= X » par défaut.
  if (actual === null || actual === undefined || actual === '') return false;

  switch (condition.operator) {
    case 'eq':
      return looseEquals(actual, expected);
    case 'neq':
      return !looseEquals(actual, expected);
    case 'in':
      return asArray(expected).some((item) => looseEquals(actual, item));
    case 'not_in':
      return !asArray(expected).some((item) => looseEquals(actual, item));
    case 'gt':
      return Number(actual) > Number(expected);
    case 'gte':
      return Number(actual) >= Number(expected);
    case 'lt':
      return Number(actual) < Number(expected);
    case 'lte':
      return Number(actual) <= Number(expected);
    case 'contains':
      return String(actual).toLowerCase().includes(String(expected).toLowerCase());
    case 'starts_with':
      return String(actual).toLowerCase().startsWith(String(expected).toLowerCase());
    case 'semver_gte':
      return compareSemver(actual, expected) >= 0;
    case 'semver_lt':
      return compareSemver(actual, expected) < 0;
    default:
      return false;
  }
}

/** Un segment matche quand TOUTES ses conditions matchent (ET logique). */
function matchRule(rule, context) {
  const conditions = Array.isArray(rule?.conditions) ? rule.conditions : [];
  if (conditions.length === 0) return true; // segment « tout le monde »
  return conditions.every((condition) => matchCondition(condition, context));
}

/**
 * Choisit une variante par poids, avec un hash DIFFÉRENT de celui du rollout.
 *
 * Pourquoi un sel `:variant` : sans lui, l'utilisateur qui entre tout juste
 * dans le rollout (bucket bas) tomberait systématiquement sur la première
 * variante. Les premiers 10 % seraient tous en A, et le test A/B serait faussé
 * exactement au moment où on le regarde le plus.
 */
function pickVariant(flag, unitId) {
  const variants = Array.isArray(flag.variants) ? flag.variants.filter((v) => v && v.key) : [];
  if (variants.length === 0) return null;

  const total = variants.reduce((sum, v) => sum + (Number(v.weight) > 0 ? Number(v.weight) : 0), 0);
  if (total <= 0) return variants[0];

  const point = (bucketOf(`${flag.key}:variant`, flag.salt, unitId) / BUCKET_SPACE) * total;
  let cursor = 0;
  for (const variant of variants) {
    cursor += Number(variant.weight) > 0 ? Number(variant.weight) : 0;
    if (point < cursor) return variant;
  }
  return variants[variants.length - 1];
}

/**
 * Le `@` initial est retiré des deux côtés : une liste de testeurs est saisie
 * à la main, et « @kospor » y est au moins aussi naturel que « kospor ». Sans
 * ça, la liste échoue silencieusement — le pire mode de panne possible pour un
 * mécanisme dont tout l'intérêt est de garantir l'accès.
 */
function normalizeIdentifier(value) {
  return String(value).trim().replace(/^@/, '').toLowerCase();
}

function listedIn(list, context) {
  if (!Array.isArray(list) || list.length === 0) return false;
  const candidates = [context.user_id, context.username, context.device_id]
    .filter(Boolean)
    .map(normalizeIdentifier);
  return list.some((entry) => candidates.includes(normalizeIdentifier(entry)));
}

/**
 * Unité sur laquelle porte le tirage.
 * Renvoie `null` quand elle manque (ex. `bucket_by: 'user'` sans compte) :
 * l'appelant doit alors répondre OFF plutôt que d'inventer une unité, sinon
 * un visiteur non connecté changerait de camp à chaque requête.
 */
function unitFor(flag, context) {
  switch (flag.bucket_by) {
    case 'device':
      return context.device_id || context.user_id || null;
    case 'session':
      return context.session_id || context.device_id || context.user_id || null;
    case 'user':
    default:
      return context.user_id || null;
  }
}

/**
 * Décision complète pour un drapeau.
 *
 * @returns {{enabled: boolean, variant: string|null, payload: any, reason: string, bucket: number|null, rule: string|null}}
 *   `reason` est le code de la règle qui a tranché — c'est lui qui rend le
 *   système débogable : « pourquoi je ne vois pas la fonctionnalité ? » a
 *   toujours une réponse exacte, jamais « le hasard ».
 */
function evaluate(flag, context = {}, now = new Date()) {
  const off = (reason, extra = {}) => ({
    enabled: false,
    variant: null,
    payload: null,
    reason,
    bucket: null,
    rule: null,
    ...extra,
  });

  if (!flag) return off('unknown_flag');
  if (flag.archived_at) return off('archived');
  if (!flag.enabled) return off('kill_switch');

  const at = now instanceof Date ? now : new Date(now);
  if (flag.start_at && at < new Date(flag.start_at)) return off('before_start');
  if (flag.end_at && at > new Date(flag.end_at)) return off('after_end');

  if (listedIn(flag.blocklist, context)) return off('blocklist');

  const unit = unitFor(flag, context);

  // L'allowlist passe avant le tirage : un testeur interne doit voir la
  // fonctionnalité même à 0 %, c'est tout l'intérêt de la liste.
  if (listedIn(flag.allowlist, context)) {
    const variant = unit ? pickVariant(flag, unit) : null;
    return {
      enabled: true,
      variant: variant ? variant.key : null,
      payload: variant ? variant.payload ?? null : flag.payload ?? null,
      reason: 'allowlist',
      bucket: unit ? bucketOf(flag.key, flag.salt, unit) : null,
      rule: null,
    };
  }

  // ── Porte du programme beta ──
  //
  // Placée APRÈS l'allowlist (un testeur interne reste servi sans être membre)
  // et AVANT le tirage, qu'elle remplace entièrement : sur un drapeau de type
  // `beta`, `rollout_percentage` n'est jamais consulté. C'est ce qui rend
  // impossible la fuite hors de la beta par une montée de palier.
  //
  // `is_beta` absent vaut « pas membre » : un contexte incomplet ferme la
  // porte, il ne l'ouvre pas.
  if (flag.audience === 'beta') {
    if (context.is_beta !== true) return off('not_beta');

    const variant = pickVariant(flag, unit);
    return {
      enabled: true,
      variant: variant ? variant.key : null,
      payload: variant ? variant.payload ?? flag.payload ?? null : flag.payload ?? null,
      reason: 'beta',
      bucket: unit ? bucketOf(flag.key, flag.salt, unit) : null,
      rule: null,
    };
  }

  if (!unit) return off('no_bucket_unit');

  const bucket = bucketOf(flag.key, flag.salt, unit);

  // Premier segment qui matche : c'est lui qui décide, on ne retombe PAS sur
  // le pourcentage global derrière. Sinon un segment volontairement à 0 %
  // (« pas encore les comptes pro ») serait rattrapé par le rollout général.
  const rules = Array.isArray(flag.rules) ? flag.rules : [];
  for (const rule of rules) {
    if (!matchRule(rule, context)) continue;

    const percentage = rulePercentage(rule, flag);

    if (bucket >= percentage * (BUCKET_SPACE / 100)) {
      return off('rule_rollout_excluded', { bucket, rule: rule.id || rule.label || null });
    }

    const variant = rule.variant
      ? (flag.variants || []).find((v) => v.key === rule.variant) || { key: rule.variant, payload: null }
      : pickVariant(flag, unit);

    return {
      enabled: true,
      variant: variant ? variant.key : null,
      payload: variant ? variant.payload ?? flag.payload ?? null : flag.payload ?? null,
      reason: 'rule',
      bucket,
      rule: rule.id || rule.label || null,
    };
  }

  const rollout = Math.max(0, Math.min(100, Number(flag.rollout_percentage) || 0));
  if (bucket >= rollout * (BUCKET_SPACE / 100)) {
    return off('rollout_excluded', { bucket });
  }

  const variant = pickVariant(flag, unit);
  return {
    enabled: true,
    variant: variant ? variant.key : null,
    payload: variant ? variant.payload ?? flag.payload ?? null : flag.payload ?? null,
    reason: 'rollout',
    bucket,
    rule: null,
  };
}

/**
 * Palier d'un segment : absolu, ou RELATIF au palier global (« boost »).
 *
 * Un segment ordinaire porte un pourcentage figé — il est donc EXCLUSIF : les
 * abonnés à 30 %, tout le monde à 0 %. Ça ne sait pas exprimer « les abonnés
 * d'abord, mais pas qu'eux », qui est pourtant le cas courant : on veut que
 * tout le monde avance, et que certains avancent plus vite.
 *
 * D'où `boost`, un multiplicateur du palier global. `boost: 2` avec un palier
 * global à 10 % sert 20 % des abonnés et 10 % des autres. Deux propriétés en
 * découlent, et ce sont elles qui font préférer un multiplicateur à un second
 * pourcentage à tenir à jour :
 *
 *   - le segment ne peut pas être oublié à une valeur périmée : il suit le
 *     palier global, y compris quand une montée automatique le fait grimper ;
 *   - il sature à 100 % en même temps que tout le monde, donc la fonctionnalité
 *     finit bien par être servie à tous. Un boost donne de l'avance, jamais
 *     l'exclusivité.
 */
function rulePercentage(rule, flag) {
  const clamp = (value) => Math.max(0, Math.min(100, value));

  const boost = Number(rule?.boost);
  if (Number.isFinite(boost) && boost > 0) {
    const base = clamp(Number(flag?.rollout_percentage) || 0);
    return clamp(Math.round(base * boost));
  }

  if (rule?.percentage === undefined || rule?.percentage === null) return 100;
  return clamp(Number(rule.percentage) || 0);
}

/** Un segment relatif au palier global plutôt qu'à un pourcentage figé. */
function isBoostRule(rule) {
  const boost = Number(rule?.boost);
  return Number.isFinite(boost) && boost > 0;
}

/** Attributs réellement référencés par un drapeau — pour la résolution paresseuse. */
function referencedAttributes(flag) {
  const found = new Set();
  // Un drapeau de type `beta` référence `is_beta` sans qu'aucune condition ne
  // l'écrive. L'omettre ici serait le défaut le plus vicieux du dispositif :
  // `resolveLazyAttributes` ne résoudrait pas l'attribut, `context.is_beta`
  // vaudrait `undefined`, et la porte se refermerait sur TOUS les membres.
  if (flag?.audience === 'beta') found.add('is_beta');
  for (const rule of Array.isArray(flag?.rules) ? flag.rules : []) {
    for (const condition of Array.isArray(rule?.conditions) ? rule.conditions : []) {
      if (condition?.attribute) found.add(condition.attribute);
    }
  }
  return found;
}

module.exports = {
  BUCKET_SPACE,
  OPERATORS,
  AUDIENCES,
  ATTRIBUTES,
  LAZY_ATTRIBUTES,
  hash32,
  bucketOf,
  compareSemver,
  matchCondition,
  matchRule,
  rulePercentage,
  isBoostRule,
  pickVariant,
  evaluate,
  referencedAttributes,
};
