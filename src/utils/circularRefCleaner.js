/**
 * 🧹 Nettoyeur de Références Circulaires
 * 
 * Utilitaire pour nettoyer les références circulaires dans les objets JSON
 * afin d'éviter les erreurs "Converting circular structure to JSON"
 */

/**
 * Nettoie les références circulaires d'un objet avec détection avancée
 * @param {*} obj - Objet à nettoyer
 * @param {Array<string>} excludeKeys - Clés à exclure
 * @returns {*} Objet nettoyé
 */
function cleanCircularReferences(obj, excludeKeys = []) {
  const defaultExcludeKeys = [
    'parent',
    'include',
    '_previousDataValues',
    '_changed',
    '_options',
    '_modelOptions',
    'dataValues',
    '_model',
    'Model',
    'sequelize',
    '$Model',
    '__proto__',
    'constructor',
    'isNewRecord',
    '_customGetters',
    '_customSetters'
  ];

  const allExcludeKeys = [...defaultExcludeKeys, ...excludeKeys];
  const seen = new WeakSet();

  const cleanObject = (value, key = null) => {
    // Exclure les clés problématiques
    if (key && allExcludeKeys.includes(key)) {
      return undefined;
    }

    // Valeurs primitives
    if (value === null || typeof value !== 'object') {
      return value;
    }

    // Détecter les références circulaires
    if (seen.has(value)) {
      return '[Circular Reference]';
    }

    seen.add(value);

    try {
      // Gérer les objets Sequelize
      if (value.dataValues && typeof value.get === 'function') {
        return cleanObject(value.get({ plain: true }));
      }

      // Gérer les modèles Sequelize
      if (value.constructor && value.constructor.name === 'Model') {
        return cleanObject(value.get ? value.get({ plain: true }) : value);
      }

      // Arrays
      if (Array.isArray(value)) {
        return value.map(item => cleanObject(item));
      }

      // Objects
      const cleanedObj = {};
      for (const [objKey, objValue] of Object.entries(value)) {
        const cleanedValue = cleanObject(objValue, objKey);
        if (cleanedValue !== undefined) {
          cleanedObj[objKey] = cleanedValue;
        }
      }
      return cleanedObj;

    } finally {
      seen.delete(value);
    }
  };

  try {
    return cleanObject(obj);
  } catch (error) {
    console.error('❌ Erreur lors du nettoyage des références circulaires:', error);
    // Fallback avec JSON.stringify plus agressif
    return JSON.parse(JSON.stringify(obj, (key, value) => {
      if (allExcludeKeys.includes(key)) return undefined;
      if (value && typeof value === 'object' && value.dataValues) {
        return value.dataValues;
      }
      return value;
    }));
  }
}

/**
 * Nettoie spécifiquement les tweets avec leurs relations
 * @param {Array|Object} tweets - Tweet(s) à nettoyer
 * @returns {Array|Object} Tweet(s) nettoyé(s)
 */
function cleanTweets(tweets) {
  if (!tweets) return tweets;

  return cleanCircularReferences(tweets, [
    'parentTweet',
    'replies',
    'likes',
    'retweets',
    'mentions',
    'quoteTweets'
  ]);
}

/**
 * Nettoie les résultats de recommandation
 * @param {Object} recommendationResult - Résultat de recommandation
 * @returns {Object} Résultat nettoyé
 */
function cleanRecommendationResult(recommendationResult) {
  if (!recommendationResult) return recommendationResult;

  return {
    ...recommendationResult,
    tweets: cleanTweets(recommendationResult.tweets),
    recommendations: cleanTweets(recommendationResult.recommendations),
    // Préserver les autres propriétés
    pagination: recommendationResult.pagination,
    metadata: recommendationResult.metadata,
    recommendation: recommendationResult.recommendation
  };
}

/**
 * Force la conversion de tous les modèles Sequelize en objets plats
 * @param {*} obj - Objet à convertir
 * @returns {*} Objet converti
 */
function forceSequelizeToPlain(obj) {
  if (!obj) return obj;

  const convert = (value) => {
    if (value === null || typeof value !== 'object') {
      return value;
    }

    // Si c'est un modèle Sequelize, forcer la conversion
    if (value.get && typeof value.get === 'function') {
      return convert(value.get({ plain: true }));
    }

    // Si c'est un array
    if (Array.isArray(value)) {
      return value.map(item => convert(item));
    }

    // Si c'est un objet
    if (value.constructor === Object || value.constructor.name === 'Object') {
      const result = {};
      for (const [key, val] of Object.entries(value)) {
        result[key] = convert(val);
      }
      return result;
    }

    return value;
  };

  return convert(obj);
}

/**
 * Nettoyage ultra-sécurisé pour les réponses API
 * @param {*} data - Données à nettoyer
 * @returns {*} Données nettoyées
 */
function ultraSafeClean(data) {
  try {
    // 1. Convertir tous les modèles Sequelize
    const plainData = forceSequelizeToPlain(data);
    
    // 2. Nettoyer les références circulaires
    const cleanedData = cleanCircularReferences(plainData);
    
    // 3. Test de sérialisation JSON
    JSON.stringify(cleanedData);
    
    return cleanedData;
  } catch (error) {
    console.error('❌ Erreur nettoyage ultra-sécurisé:', error);
    
    // Fallback extrême : retourner un objet vide avec message d'erreur
    return {
      error: 'Data cleaning failed',
      message: 'Unable to serialize response data safely',
      timestamp: new Date().toISOString()
    };
  }
}

module.exports = {
  cleanCircularReferences,
  cleanTweets,
  cleanRecommendationResult,
  forceSequelizeToPlain,
  ultraSafeClean
};
