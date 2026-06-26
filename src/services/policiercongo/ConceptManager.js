const logger = require('../../utils/logger');

class ConceptManager {
  constructor(memoryManager) {
    this.memoryManager = memoryManager;
    this.CONCEPT_COOLDOWN_HOURS = 6;
  }

  _getConceptMemory() {
    const memory = this.memoryManager.getMemory();
    return memory.concepts || { items: [], lastRefreshAt: null };
  }

  async _saveConceptMemory(concepts) {
    await this.memoryManager.update({ concepts });
  }

  _normalizeConcept(raw, source = 'big_context') {
    const title = String(raw || '').trim().substring(0, 140);
    if (!title) return null;
    const category = this._categorizeConcept(title);
    return {
      id: `concept_${title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`,
      title,
      category,
      source,
      score: 1,
      uses: 0,
      status: 'active',
      lastUsedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }

  _categorizeConcept(title) {
    const t = String(title || '').toLowerCase();
    if (/drama|clash|ratio|embrouille|chaud/.test(t)) return 'drama';
    if (/question|avis|sondage|vous pensez|opinion/.test(t)) return 'engagement';
    if (/actu|news|tendance|trend|plateforme/.test(t)) return 'actualite';
    if (/humeur|life|perso|quotidien/.test(t)) return 'personal';
    return 'general';
  }

  async refreshFromBigContexts(limitBigContexts = 5) {
    try {
      const bigContexts = this.memoryManager.getRecentBigContexts(limitBigContexts) || [];
      const conceptMemory = this._getConceptMemory();
      const byId = new Map((conceptMemory.items || []).map((c) => [c.id, c]));

      for (const big of bigContexts) {
        const candidates = [
          ...(Array.isArray(big.next_ideas) ? big.next_ideas : []),
          ...(Array.isArray(big.topics) ? big.topics : [])
        ];

        for (const candidate of candidates) {
          const normalized = this._normalizeConcept(candidate, 'big_context');
          if (!normalized) continue;
          const existing = byId.get(normalized.id);
          if (existing) {
            existing.score = (existing.score || 1) + 1;
            existing.updatedAt = new Date().toISOString();
          } else {
            byId.set(normalized.id, normalized);
          }
        }
      }

      const merged = Array.from(byId.values())
        .map((c) => {
          const usesPenalty = Math.min((c.uses || 0) * 0.15, 1.5);
          return {
            ...c,
            dynamicScore: Number(((c.score || 0) - usesPenalty).toFixed(2))
          };
        })
        .sort((a, b) => (b.dynamicScore || 0) - (a.dynamicScore || 0))
        .slice(0, 200);

      await this._saveConceptMemory({
        items: merged,
        lastRefreshAt: new Date().toISOString()
      });

      logger.info(`🧩 ConceptManager: ${merged.length} concepts disponibles`);
      return merged;
    } catch (error) {
      logger.error('❌ ConceptManager refresh error:', error?.message || error);
      return [];
    }
  }

  getNextConcepts(limit = 5) {
    const conceptMemory = this._getConceptMemory();
    return (conceptMemory.items || [])
      .filter((c) => c.status !== 'archived')
      .filter((c) => {
        if (!c.lastUsedAt) return true;
        const lastUseTs = new Date(c.lastUsedAt).getTime();
        if (Number.isNaN(lastUseTs)) return true;
        const hours = (Date.now() - lastUseTs) / (1000 * 60 * 60);
        return hours >= this.CONCEPT_COOLDOWN_HOURS;
      })
      .sort((a, b) => {
        const scoreDiff = (b.dynamicScore || b.score || 0) - (a.dynamicScore || a.score || 0);
        if (scoreDiff !== 0) return scoreDiff;
        return (a.uses || 0) - (b.uses || 0);
      })
      .slice(0, limit);
  }

  getStrategySnapshot(collectedData = {}) {
    const concepts = this.getNextConcepts(20);
    const unrepliedCount = (collectedData.unrepliedComments || []).length;
    const followers = collectedData.communitySentiment?.followers || 0;
    const shouldPostMainTweet = !!collectedData.timingAnalysis?.shouldPostMainTweet;

    const interactionPriority = unrepliedCount > 0 ? 'high' : 'normal';
    const conceptIntensity = unrepliedCount > 0 ? 'low' : (shouldPostMainTweet ? 'medium' : 'high');
    const recommendedMix = unrepliedCount > 0
      ? 'Priorite reponses commu (>=70%), concepts en support.'
      : 'Mix equilibre: concepts + interactions organiques.';

    const topByCategory = {};
    for (const c of concepts.slice(0, 10)) {
      if (!topByCategory[c.category]) topByCategory[c.category] = [];
      topByCategory[c.category].push(c.title);
    }

    return {
      concepts_available: concepts.length,
      interaction_priority: interactionPriority,
      concept_intensity: conceptIntensity,
      unreplied_comments: unrepliedCount,
      followers,
      should_post_main_tweet: shouldPostMainTweet,
      recommended_mix: recommendedMix,
      top_concepts_by_category: topByCategory
    };
  }

  async markConceptUsed(conceptTitle) {
    if (!conceptTitle) return;
    const conceptMemory = this._getConceptMemory();
    const conceptId = `concept_${String(conceptTitle).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`;
    const updated = (conceptMemory.items || []).map((c) => {
      if (c.id !== conceptId) return c;
      return {
        ...c,
        uses: (c.uses || 0) + 1,
        lastUsedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
    });
    await this._saveConceptMemory({
      ...conceptMemory,
      items: updated
    });
  }

  async markConceptUsedFromContent(content) {
    const text = String(content || '').toLowerCase().trim();
    if (!text) return null;

    const conceptMemory = this._getConceptMemory();
    const items = conceptMemory.items || [];
    if (items.length === 0) return null;

    const tokenize = (s) =>
      String(s || '')
        .toLowerCase()
        .replace(/[^a-z0-9\u00C0-\u024F\s]/gi, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2);

    const textTokens = new Set(tokenize(text));
    let best = null;
    let bestScore = 0;

    for (const c of items) {
      if (!c?.title) continue;
      const conceptTokens = tokenize(c.title);
      if (conceptTokens.length === 0) continue;
      const overlap = conceptTokens.filter((t) => textTokens.has(t)).length;
      const score = overlap / conceptTokens.length;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }

    if (!best || bestScore < 0.45) return null;
    await this.markConceptUsed(best.title);
    logger.info(`🧩 Concept marqué comme utilisé: "${best.title}" (match=${bestScore.toFixed(2)})`);
    return best.title;
  }
}

module.exports = ConceptManager;
