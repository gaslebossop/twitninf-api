/**
 * 🕵️‍♂️ BotBrain : FeatureExtractor (v2.7 - Reinforced Debug)
 */
const logger = require('../../utils/logger');

class FeatureExtractor {
    static calculateTransitionEntropy(actions) {
        if (actions.length < 2) return 0.5;
        const transitions = [];
        for (let i = 0; i < actions.length - 1; i++) {
            transitions.push(`${actions[i].action_type}->${actions[i+1].action_type}`);
        }
        const uniqueTransitions = new Set(transitions).size;
        return uniqueTransitions / transitions.length;
    }

    static extract(actions) {
        if (!actions || actions.length < 5) {
            logger.warn(`⚠️ [FeatureExtractor-Debug] Trop peu d'actions reçues : ${actions ? actions.length : 0}`);
            return null;
        }

        const sortedActions = [...actions].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        
        const delays = [];
        for (let i = 1; i < sortedActions.length; i++) {
            const d = new Date(sortedActions[i].timestamp) - new Date(sortedActions[i-1].timestamp);
            if (d > 0) delays.push(d);
        }

        if (delays.length === 0) return null;

        const avgDelay = delays.reduce((a, b) => a + b, 0) / delays.length;
        const stdDelay = Math.sqrt(delays.map(x => Math.pow(x - avgDelay, 2)).reduce((a, b) => a + b, 0) / delays.length);
        const actionTypes = sortedActions.map(a => a.action_type);
        const likes = actionTypes.filter(t => t.includes('like')).length;
        const humanSignals = actionTypes.filter(t => t.includes('scroll') || t.includes('time_spent')).length;
        const entropy = this.calculateTransitionEntropy(sortedActions);
        const totalTime = new Date(sortedActions[sortedActions.length-1].timestamp) - new Date(sortedActions[0].timestamp);
        const intensity = (sortedActions.length / (totalTime + 1)) * 1000;

        const features = {
            avg_delay: Math.min(avgDelay / 10000, 1.0),
            regularity: Math.min(stdDelay / (avgDelay + 1), 1.0),
            engagement_ratio: likes / sortedActions.length,
            human_signal_ratio: humanSignals / sortedActions.length,
            entropy: entropy,
            intensity: Math.min(intensity, 1.0)
        };

        // --- LOG DE DEBUG ---
        logger.info(`🧪 [FeatureExtractor-Debug] Calculs terminés : Moyenne=${avgDelay.toFixed(0)}ms, Entropie=${entropy.toFixed(2)}`);

        return features;
    }
}

module.exports = FeatureExtractor;
