-- Script pour supprimer l'avant-dernière vidéo de @gas
-- Exécuter sur le VPS : psql -U <user> -d <db> -f delete_gas_video.sql

-- 1. Trouver les 2 dernières vidéos de @gas, ordonnées par date
-- (la 2ème = avant-dernière)
WITH gas_videos AS (
  SELECT t.id, t.content, t.created_at,
         ROW_NUMBER() OVER (ORDER BY t.created_at DESC) AS rn
  FROM tweets t
  JOIN users u ON u.id = t.user_id
  WHERE u.username = 'gas'
    AND t.tweet_type = 'video'
    AND t.deleted_at IS NULL
)
-- 2. Soft-delete (marquer supprimé sans effacer)
UPDATE tweets
SET deleted_at = NOW()
WHERE id = (SELECT id FROM gas_videos WHERE rn = 2);

-- Vérification : afficher ce qui a été supprimé
SELECT t.id, t.content, t.created_at, t.deleted_at
FROM tweets t
JOIN users u ON u.id = t.user_id
WHERE u.username = 'gas'
  AND t.tweet_type = 'video'
ORDER BY t.created_at DESC
LIMIT 5;
