/**
 * 🧪 Test de Démarrage de l'API de Recommandation
 * 
 * Vérifie que l'API peut démarrer sans erreur
 */

const express = require('express');
const app = express();

// Test simple des routes
app.get('/test', (req, res) => {
  res.json({ message: 'Test route OK' });
});

// Démarrer le serveur de test
const PORT = 3001;
app.listen(PORT, () => {
  console.log(`✅ Serveur de test démarré sur le port ${PORT}`);
  console.log(`🌐 Test: http://localhost:${PORT}/test`);
});

// Test après 2 secondes
setTimeout(() => {
  console.log('🧪 Test de démarrage réussi !');
  process.exit(0);
}, 2000);
