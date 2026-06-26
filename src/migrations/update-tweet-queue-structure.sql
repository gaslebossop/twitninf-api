-- Migration pour améliorer la structure tweet_queue
-- Ajouter colonnes pour stocker les données de progression

-- Ajouter colonnes pour tracking des vues par groupe
ALTER TABLE tweet_queue 
ADD COLUMN IF NOT EXISTS group_views_initial INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS group_views_expansion INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS group_views_viral INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS group_views_massive INTEGER DEFAULT 0;

-- Ajouter colonnes pour tracking des interactions
ALTER TABLE tweet_queue 
ADD COLUMN IF NOT EXISTS total_likes INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS total_retweets INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS total_replies INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS total_views INTEGER DEFAULT 0;

-- Ajouter colonnes pour progression
ALTER TABLE tweet_queue 
ADD COLUMN IF NOT EXISTS current_group VARCHAR(20) DEFAULT 'initial',
ADD COLUMN IF NOT EXISTS last_group_change_at TIMESTAMP NULL,
ADD COLUMN IF NOT EXISTS progression_history JSONB DEFAULT '[]'::jsonb;

-- Ajouter colonnes pour ratios et stats
ALTER TABLE tweet_queue 
ADD COLUMN IF NOT EXISTS current_ratio DECIMAL(5,4) DEFAULT 0,
ADD COLUMN IF NOT EXISTS last_evaluation_at TIMESTAMP NULL,
ADD COLUMN IF NOT EXISTS evaluation_count INTEGER DEFAULT 0;

-- Index pour les performances
CREATE INDEX IF NOT EXISTS idx_tweet_queue_current_group ON tweet_queue(current_group);
CREATE INDEX IF NOT EXISTS idx_tweet_queue_ratio ON tweet_queue(current_ratio);
CREATE INDEX IF NOT EXISTS idx_tweet_queue_last_evaluation ON tweet_queue(last_evaluation_at);

-- Index composé pour les queries de progression
CREATE INDEX IF NOT EXISTS idx_tweet_queue_progression ON tweet_queue(queue_status, current_group, last_evaluation_at);
