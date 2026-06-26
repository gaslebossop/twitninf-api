-- Migration pour ajouter la colonne recommendation_group à la table tweets
-- Date: 13 septembre 2025

-- 1. Créer le type ENUM pour recommendation_group
CREATE TYPE recommendation_group_enum AS ENUM ('initial', 'expansion', 'viral', 'massive', 'excluded');

-- 2. Ajouter la colonne recommendation_group à la table tweets
ALTER TABLE tweets 
ADD COLUMN recommendation_group recommendation_group_enum NOT NULL DEFAULT 'initial';

-- 3. Mettre à jour tous les tweets existants pour qu'ils soient dans le groupe 'initial'
UPDATE tweets 
SET recommendation_group = 'initial' 
WHERE recommendation_group IS NULL;

-- 4. Ajouter un index pour optimiser les requêtes
CREATE INDEX tweets_recommendation_group_idx ON tweets (recommendation_group);

-- 5. Vérifier que la colonne a été ajoutée
SELECT column_name, data_type, is_nullable, column_default 
FROM information_schema.columns 
WHERE table_name = 'tweets' AND column_name = 'recommendation_group';

-- 6. Vérifier le nombre de tweets par groupe
SELECT recommendation_group, COUNT(*) as count 
FROM tweets 
GROUP BY recommendation_group 
ORDER BY recommendation_group;
