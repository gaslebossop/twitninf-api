const logger = require('../utils/logger');
const { GoogleGenAI } = require('@google/genai');
// Les clés vivaient en dur ici, une par fonction. Elles viennent maintenant du
// pool partagé, alimenté par `GEMINI_API_KEYS` : une seule liste à tenir à
// jour, et rien de secret dans le dépôt.
const { keysInRotationOrder } = require('../config/geminiKeys');

/**
 * Appelle Gemini 2.0 Flash pour évaluer l'éligibilité d'un tweet aux recommandations
 * Retourne { decision: 'eligible'|'not_eligible'|'ban', eligible: boolean, reason?: string, score?: number }
 */
async function evaluateTweetForRecommendations({ content, authorUsername, isReply = false }) {
    try {
      // Ne vérifier que les tweets originaux (pas les réponses)
      if (isReply) {
        return { decision: 'eligible', eligible: true, reason: 'skip_reply', score: 0.7 };
      }
      const [apiKey] = keysInRotationOrder();
      if (!apiKey) {
        return { decision: 'eligible', eligible: true, reason: 'gemini_not_configured', score: 0.7 };
      }
  
      const ai = new GoogleGenAI({ apiKey });
      
      // Prompt en français avec décision explicite (eligible / not_eligible / ban)
      const prompt = `Tâche : Évaluer un tweet et décider s'il est :
  - "eligible" : OK pour recommandations
  - "not_eligible" : pas recommandé (insultes, langage grossier, contenu gênant, spam léger, contenu non mature, qui repousse de l'application, insulte en abrégé) mais public sur le profil
  - "ban" : contenu ULTRA GRAVE interdit (haine raciale/ethnique, violence explicite, harcèlement grave, sexualité explicite, menaces de mort, apologie terrorisme, doxxing)
  
  IMPORTANT : Réponds uniquement en français et sois bienveillant dans ton évaluation.

  CONTEXTE DE LA PLATEFORME (à connaître avant de juger) :
  TwitNinf est un réseau social francophone avec son propre vocabulaire. Ces
  termes sont NORMAUX et parfaitement compréhensibles pour ses utilisateurs :
  - "ninf", "twitninf", "le ninf" : le nom de la plateforme et de sa communauté
  - "NF", "TWC" : les monnaies internes ; "wallet", "mining", "casino" : ses fonctionnalités
  - "policiercongo", "kospor", "G Corp" : comptes et entités connus de la plateforme
  - argot, verlan, abréviations SMS, emojis, mélange français / lingala / anglais :
    registre habituel des utilisateurs
  Les messages sont courts et informels par nature (annonces de retour, salutations,
  réactions, blagues internes). C'est le format attendu, pas un défaut.

  RÈGLE ABSOLUE : un mot, un pseudo, une abréviation ou une référence que TU ne
  reconnais pas n'est JAMAIS une raison de mettre "not_eligible". Ton
  incompréhension d'un terme ne mesure pas la qualité du message. Dans ce cas,
  réponds "eligible". Ne juge la qualité que sur ce que le message FAIT
  (insulter, spammer, harceler), jamais sur le vocabulaire employé.

  Retourne un JSON strict avec les champs EXACTS suivants :
  - decision (string) : "eligible" | "not_eligible" | "ban"
  - score (0..1) : score de qualité du contenu
  - reason (string) : explication courte en français
  
  CRITÈRES DE DÉCISION :
  
  🟡 "not_eligible" (pas de recommandation, mais visible sur profil) :
  - Insultes et langage grossier visant quelqu'un
  - Contenu gênant ou déplacé
  - Spam léger (répétitions, autopromo insistante)
  - Suite de caractères tapés au hasard, sans aucun mot réel (ex: "gjkgjkjkggjk")
  - Propos méchants ou irrespectueux

  ⚠️ NE PAS mettre "not_eligible" pour :
  - un message court, familier ou banal ("je suis de retour", "bonjour", "ça va ?")
  - du vocabulaire propre à la plateforme, un pseudo, un surnom ou un mot inconnu de toi
  - de l'argot, des abréviations, des fautes d'orthographe ou un mélange de langues
  - un message qui te semble « peu utile » ou « sans valeur informative » : ce n'est
    pas un critère, la conversation ordinaire est le contenu normal du réseau

  🔴 "ban" (contenu ULTRA GRAVE, supprimé) :
  - Haine raciale, ethnique ou religieuse
  - Violence explicite ou apologie d'actes violents
  - Harcèlement grave et répété
  - Sexualité explicite ou pornographique
  - Menaces de mort ou de violence physique
  - Apologie du terrorisme ou d'actes criminels
  - Doxxing (révélation d'informations privées)
  - Contenu pédopornographique
  
  🟢 "eligible" (recommandé) :
  - Tout le reste (contenu normal, créatif, informatif)
  - Si tu hésites, choisis "eligible"
  
  ✅ VALORISER :
  - Originalité et créativité
  - Clarté du message
  - Valeur informative ou divertissante
  - Engagement constructif
  
  Note : Privilégie l'inclusion. Le but est d'exclure seulement le spam et les contenus réellement problématiques, pas d'être restrictif.
  
  Contenu du tweet : ${JSON.stringify(content)}
  Auteur : ${JSON.stringify(authorUsername || 'inconnu')}
  
     IMPORTANT : Réponds UNIQUEMENT avec le JSON brut, SANS backticks, SANS markdown, SANS formatage.
   
   Exemple de réponse attendue :
   {"decision":"eligible","score":0.8,"reason":"Contenu normal"}
   
   Réponds en JSON uniquement :`;
  
            const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
      });

      // LOG de la réponse brute de Gemini
      logger.info(`🔍 RÉPONSE BRUTE GEMINI:`, {
        hasResponse: !!response,
        hasResponseText: !!response?.response,
        responseType: typeof response?.response,
        textType: typeof response?.text,
        fullResponse: JSON.stringify(response, null, 2)
      });

      // Quand le tweet déclenche les filtres de sécurité de Gemini, l'API ne
      // renvoie AUCUN texte, juste un finishReason. Ce cas retombait sur les
      // fallbacks génériques plus bas, qui répondent "eligible" — autrement dit
      // le contenu le plus problématique (insultes crues, violence) passait en
      // recommandation, alors que le refus du modèle en est justement le signal
      // le plus fort. On le traite comme non recommandable, sans le supprimer :
      // ce signal peut avoir des faux positifs, il ne justifie pas un ban.
      const blockedFinishReason = String(response?.candidates?.[0]?.finishReason || '');
      if (['PROHIBITED_CONTENT', 'SAFETY', 'BLOCKLIST', 'SPII'].includes(blockedFinishReason)) {
        logger.warn(`🛑 Gemini a bloqué sa propre réponse (${blockedFinishReason}) — tweet non recommandé`);
        return {
          decision: 'not_eligible',
          eligible: false,
          reason: `gemini_safety_block:${blockedFinishReason}`,
          score: 0.1
        };
      }

            // Extraction robuste du texte de réponse
      let text = '';
      if (response?.response && typeof response.response.text === 'function') {
        try {
          text = response.response.text();
          logger.info(`✅ Texte extrait via response.response.text()`);
        } catch (textError) {
          logger.error(`❌ Erreur lors de l'extraction du texte: ${textError.message}`);
        }
      } else if (typeof response.text === 'function') {
        try { 
          text = response.text(); 
          logger.info(`✅ Texte extrait via response.text()`);
        } catch (textError) {
          logger.error(`❌ Erreur lors de l'extraction du texte: ${textError.message}`);
        }
      } else if (typeof response.text === 'string') {
        text = response.text;
        logger.info(`✅ Texte extrait directement (string)`);
      } else {
        logger.error(`🚨 Impossible d'extraire le texte de la réponse Gemini`);
        logger.error(`📋 Structure de la réponse:`, response);
      }

      // Vérifier que text est bien défini et est une chaîne avant d'appeler .trim()
      if (typeof text !== 'string') {
        logger.error(`🚨 ERREUR: text n'est pas une chaîne de caractères:`, {
          type: typeof text,
          value: text,
          response: response
        });
        return { 
          decision: 'eligible',
          eligible: true, 
          reason: 'gemini_invalid_text_type',
          score: 0.7
        };
      }

      // Nettoyage du texte pour extraire le JSON
      text = text.trim();
      
      // LOG COMPLET DE LA RÉPONSE GEMINI
      logger.info(`🔍 RÉPONSE COMPLÈTE GEMINI pour tweet "${content.substring(0, 50)}..." :`);
      logger.info(`📝 Texte brut: ${text}`);
      logger.info(`📏 Longueur du texte: ${text.length}`);
      
      // Vérifier si le texte contient des caractères JSON
      if (!text.includes('{') || !text.includes('}')) {
        logger.error(`🚨 ERREUR: Réponse Gemini ne contient pas de JSON (pas de { ou })`);
        logger.error(`📝 Texte reçu: "${text}"`);
        return { 
          decision: 'eligible',
          eligible: true, 
          reason: 'gemini_no_json_response',
          score: 0.7
        };
      }
      
      let json;
      try { 
        json = JSON.parse(text); 
        logger.info(`✅ JSON parsé avec succès:`, json);
      } catch (parseError) { 
        logger.warn(`❌ Erreur parsing JSON: ${parseError.message}`);
        logger.warn(`📝 Texte qui a causé l'erreur: "${text}"`);
        json = null; 
      }

      // Tentative d'extraction JSON depuis un texte plus long
      if (!json || (json.decision !== 'eligible' && json.decision !== 'not_eligible' && json.decision !== 'ban')) {
        logger.warn(`⚠️ JSON invalide ou décision incorrecte: ${json?.decision}`);
        logger.warn(`📝 Texte complet: "${text}"`);
        
        // Essayer de trouver un JSON valide dans le texte
        const match = text && text.match(/\{[\s\S]*?\}/);
        if (match) {
          logger.info(`🔍 Tentative d'extraction JSON par regex: "${match[0]}"`);
          try { 
            json = JSON.parse(match[0]); 
            logger.info(`🔄 JSON extrait par regex:`, json);
          } catch (regexError) {
            logger.warn(`❌ Erreur parsing regex: ${regexError.message}`);
            logger.warn(`📝 Texte regex: "${match[0]}"`);
          }
        }
      }

      // Fallback en cas d'échec de parsing
      if (!json || (json.decision !== 'eligible' && json.decision !== 'not_eligible' && json.decision !== 'ban')) {
        logger.error(`🚨 FALLBACK: Gemini retour non JSON strict ou décision invalide`);
        logger.error(`📊 Décision reçue: ${json?.decision || 'undefined'}`);
        logger.error(`📝 Raison reçue: ${json?.reason || 'undefined'}`);
        logger.error(`🎯 Score reçu: ${json?.score || 'undefined'}`);
        logger.error(`📝 Texte complet Gemini: "${text}"`);
        return { 
          decision: 'eligible',
          eligible: true, 
          reason: 'gemini_parse_fallback',
          score: 0.7 // Score neutre par défaut
        };
      }
  
      return {
        decision: json.decision,
        eligible: json.decision === 'eligible',
        reason: json.reason || 'Évaluation automatique',
        score: json.score || 0.7
      };
    } catch (error) {
      logger.error('Erreur Gemini evaluateTweetForRecommendations:', error);
      return { 
        decision: 'eligible',
        eligible: true, 
        reason: 'gemini_error_fallback',
        score: 0.7 
      };
    }
}

/**
 * Génère une réponse de policier pour @policiercongo
 * Retourne { success: boolean, response: string, error?: string }
 */
async function generatePoliceResponse(tweetContent, authorUsername) {
  try {
    const [apiKey] = keysInRotationOrder();
    if (!apiKey) {
      return { success: false, error: 'Clé API Gemini non configurée' };
    }

    const ai = new GoogleGenAI({ apiKey });
    
    const prompt = `Tu es Policier Congo, un jeune policier congolais sympathique et professionnel sur les réseaux sociaux.

TÂCHE : Réponds au tweet mentionné comme si tu étais Policier Congo.

RÈGLES IMPORTANTES :
- Parle comme un jeune policier congolais moderne et sympathique
- Sois professionnel mais décontracté
- Utilise un ton bienveillant et rassurant
- Réponds en français
- Sois concis (max 200 caractères)
- N'utilise pas de hashtags
- Ne mentionne pas d'autres comptes sauf si nécessaire

CONTEXTE :
- Tweet original : "${tweetContent}"
- Auteur : @${authorUsername}

Réponds directement comme Policier Congo (pas besoin de formatage spécial) :`;

          const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
      });

      // LOG de la réponse brute de Gemini
      logger.info(`🔍 RÉPONSE BRUTE GEMINI:`, {
        hasResponse: !!response,
        hasResponseText: !!response?.response,
        responseType: typeof response?.response,
        textType: typeof response?.text,
        fullResponse: JSON.stringify(response, null, 2)
      });

      // Extraction du texte de réponse
      let text = '';
      if (response?.response && typeof response.response.text === 'function') {
        try {
          text = response.response.text();
          logger.info(`✅ Texte extrait via response.response.text()`);
        } catch (textError) {
          logger.error(`❌ Erreur lors de l'extraction du texte: ${textError.message}`);
        }
      } else if (typeof response.text === 'function') {
        try { 
          text = response.text(); 
          logger.info(`✅ Texte extrait via response.text()`);
        } catch (textError) {
          logger.error(`❌ Erreur lors de l'extraction du texte: ${textError.message}`);
        }
      } else if (typeof response.text === 'string') {
        text = response.text;
        logger.info(`✅ Texte extrait directement (string)`);
      } else {
        logger.error(`🚨 Impossible d'extraire le texte de la réponse Gemini`);
        logger.error(`📋 Structure de la réponse:`, response);
      }

      text = text.trim();
      
      if (!text) {
        logger.error(`🚨 ERREUR: Texte vide après extraction de Gemini`);
        return { 
          decision: 'eligible',
          eligible: true, 
          reason: 'gemini_empty_response',
          score: 0.7
        };
      }
    
    if (!text) {
      return { success: false, error: 'Réponse vide de Gemini' };
    }

    // Limiter à 200 caractères
    if (text.length > 200) {
      text = text.substring(0, 197) + '...';
    }

    logger.info(`Réponse policier générée pour @${authorUsername}: ${text}`);
    
    return {
      success: true,
      response: text
    };
  } catch (error) {
    logger.error('Erreur Gemini generatePoliceResponse:', error);
    return { 
      success: false, 
      error: 'Erreur lors de la génération de la réponse policier' 
    };
  }
}

/**
 * Traite un tweet en attente avec Gemini + PolicierCongo + Algorithme Progressif
 * Cette fonction est appelée de manière asynchrone pour traiter les tweets
 * Retourne { success: boolean, moderation_status: string, police_response?: any }
 */
async function processPendingTweet(tweetId, tweetContent, authorUsername, isReply = false) {
  try {
    const { Tweet } = require('../models');
    
    logger.info(`🔄 Traitement du tweet en attente: ${tweetId} par @${authorUsername}`);
    
         // 1. Évaluation Gemini (modération)
     const geminiResult = await evaluateTweetForRecommendations({ 
       content: tweetContent, 
       authorUsername, 
       isReply 
     });
     
     logger.info(`✅ Gemini évaluation terminée pour tweet ${tweetId}: ${geminiResult.decision}`);
     logger.info(`📊 DÉTAILS GEMINI pour tweet ${tweetId}:`);
     logger.info(`   - Décision: ${geminiResult.decision}`);
     logger.info(`   - Éligible: ${geminiResult.eligible}`);
     logger.info(`   - Raison: ${geminiResult.reason}`);
     logger.info(`   - Score: ${geminiResult.score}`);
    
    // 2. Réponse auto sur mention @policiercongo : DÉSACTIVÉ.
    // Ce répondeur legacy (prompt Gemini générique, hors personnalité/mémoire) répondait
    // avant le pipeline PolicierCongoV2 (Claude Code) et bloquait ensuite ce dernier
    // ("déjà répondu"). Les mentions sont désormais traitées uniquement par PolicierCongoV2.
    let policeResponse = null;

         // Déterminer le statut de modération
         let moderationStatus;
         let moderationReason;
         
         if (geminiResult.decision === 'ban') {
           moderationStatus = 'rejected';
           moderationReason = `gemini_ban:${geminiResult.reason || 'content'}`;
         } else if (geminiResult.decision === 'not_eligible') {
           moderationStatus = 'not_eligible';
           moderationReason = `gemini_not_eligible:${geminiResult.reason || 'content'}`;
         } else {
           moderationStatus = 'approved';
           moderationReason = null;
         }
         
         const finalResult = {
           success: true,
           moderation_status: moderationStatus,
           moderation_reason: moderationReason,
           gemini_result: geminiResult,
           police_response: policeResponse,
           processed_at: new Date().toISOString()
         };

     logger.info(`🎯 RÉSULTAT FINAL pour tweet ${tweetId}:`);
     logger.info(`   - Statut modération: ${finalResult.moderation_status}`);
     logger.info(`   - Raison modération: ${finalResult.moderation_reason}`);
     logger.info(`   - Réponse policier: ${policeResponse ? 'OUI' : 'NON'}`);

     // 🎯 NOUVEAU SYSTÈME DE QUEUE: Intégration avec la queue
     try {
       const { Tweet } = require('../models');
       const TweetQueueService = require('./tweetQueueService');
       const tweetQueueService = new TweetQueueService();

       // Mettre à jour le statut de modération du tweet
       await Tweet.update({
         moderation_status: finalResult.moderation_status
       }, {
         where: { id: tweetId }
       });
       
       // Si le tweet est approuvé, l'ajouter à l'algorithme progressif via la queue
       if (finalResult.moderation_status === 'approved') {
         logger.info(`✅ Tweet ${tweetId} approuvé - ajout à l'algorithme progressif`);
         await tweetQueueService.approveTweetFromQueue(tweetId, {
           gemini_result: geminiResult,
           approved_at: new Date().toISOString(),
           moderation_status: 'approved'
         });
       } else if (finalResult.moderation_status === 'rejected') {
         logger.info(`❌ Tweet ${tweetId} rejeté - exclusion de l'algorithme`);
         await tweetQueueService.rejectTweetFromQueue(tweetId, finalResult.moderation_reason || 'Modération Gemini');
       }
       
       logger.info(`✅ Tweet ${tweetId} traité par le système de queue`);
     } catch (error) {
       logger.error(`❌ Erreur lors du traitement du tweet ${tweetId} par la queue:`, error);
     }

     return finalResult;
    
  } catch (error) {
    logger.error(`❌ Erreur lors du traitement du tweet ${tweetId}:`, error);
    return {
      success: false,
      error: error.message,
      moderation_status: 'approved', // Fallback sécurisé
      processed_at: new Date().toISOString()
    };
  }
}

module.exports = {
  evaluateTweetForRecommendations,
  generatePoliceResponse,
  processPendingTweet
};


