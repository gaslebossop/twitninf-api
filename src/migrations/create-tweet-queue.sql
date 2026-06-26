-- 🚀 Création de la table de queue pour les tweets à traiter
-- Cette table va contenir SEULEMENT les nouveaux tweets créés à partir de maintenant

CREATE TABLE IF NOT EXISTS tweet_queue (
  id VARCHAR(36) PRIMARY KEY,
  tweet_id VARCHAR(36) NOT NULL UNIQUE,
  user_id VARCHAR(36) NOT NULL,
  
  -- Statut dans la queue
  queue_status ENUM('pending', 'processing', 'approved', 'rejected') DEFAULT 'pending',
  
  -- Timestamps
  queued_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  processed_at TIMESTAMP NULL,
  approved_at TIMESTAMP NULL,
  
  -- Métadonnées du traitement
  processing_metadata JSON,
  
  -- Raison si rejeté
  rejection_reason VARCHAR(500),
  
  -- Index pour les performances
  INDEX idx_queue_status (queue_status),
  INDEX idx_queued_at (queued_at),
  INDEX idx_user_id (user_id),
  
  -- Contraintes
  FOREIGN KEY (tweet_id) REFERENCES tweets(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Ajouter un champ à la table tweets pour marquer s'ils sont dans l'algorithme progressif
ALTER TABLE tweets 
ADD COLUMN IF NOT EXISTS progressive_testing_status ENUM('none', 'queued', 'testing', 'graduated', 'excluded') DEFAULT 'none',
ADD COLUMN IF NOT EXISTS progressive_added_at TIMESTAMP NULL,
ADD COLUMN IF NOT EXISTS progressive_metadata JSON;

-- Index pour l'algorithme progressif
CREATE INDEX IF NOT EXISTS idx_progressive_testing ON tweets(progressive_testing_status, created_at);
CREATE INDEX IF NOT EXISTS idx_progressive_added ON tweets(progressive_added_at);
