const policiercongoAutomatisation = require('./src/services/policiercongoAutomatisation');

console.log('🧪 Test de la limite de 100 caractères pour PolicierCongo\n');

// Test 1: Vérifier la fonction generateDefaultTweet
console.log('📝 Test 1: generateDefaultTweet');
const defaultTweet = policiercongoAutomatisation.generateDefaultTweet();
console.log(`Contenu: "${defaultTweet}"`);
console.log(`Longueur: ${defaultTweet.length} caractères`);
console.log(`✅ Respecte la limite: ${defaultTweet.length <= 100 ? 'OUI' : 'NON'}\n`);

// Test 2: Vérifier la fonction generateFallbackResponseContent
console.log('📝 Test 2: generateFallbackResponseContent');
const fallbackResponse = policiercongoAutomatisation.generateFallbackResponseContent({
  reason: 'Test de la limite de caractères pour vérifier que tout fonctionne correctement',
  priority: 'high'
});
console.log(`Contenu: "${fallbackResponse}"`);
console.log(`Longueur: ${fallbackResponse.length} caractères`);
console.log(`✅ Respecte la limite: ${fallbackResponse.length <= 100 ? 'OUI' : 'NON'}\n`);

// Test 3: Vérifier la fonction generateFallbackResponse
console.log('📝 Test 3: generateFallbackResponse');
const mockTweet = {
  author: { username: 'testuser' },
  created_at: new Date()
};
const fallbackResponse2 = policiercongoAutomatisation.generateFallbackResponse(mockTweet, []);
console.log(`Contenu: "${fallbackResponse2.content}"`);
console.log(`Longueur: ${fallbackResponse2.content.length} caractères`);
console.log(`✅ Respecte la limite: ${fallbackResponse2.content.length <= 100 ? 'OUI' : 'NON'}\n`);

// Test 4: Vérifier que les exemples dans le code respectent la limite
console.log('📝 Test 4: Vérification des exemples dans le code');
const examples = [
  "🚔 Salut ! Policier Congo, votre policier proximité ! 💪🇨🇬",
  "🌟 Bonjour ! Focus sécurité proximité ! Questions ? 🚔💪",
  "🚨 Alerte sécurité : Nouveau système installé !",
  "Salut @utilisateur ! 😄 Sens de l'humour ! 😊🚔",
  "Hey @utilisateur ! 🌟 Excellente question ! Sécurité priorité ! 💪",
  "Salut @ami ! 😊 Sécurité quartier préoccupation ! On travaille dessus ! 💪🚔",
  "Hey @voisin ! 🌟 Tu poses souvent des questions ! Super curieux ! 🤝"
];

examples.forEach((example, index) => {
  console.log(`Exemple ${index + 1}: "${example}"`);
  console.log(`Longueur: ${example.length} caractères`);
  console.log(`✅ Respecte la limite: ${example.length <= 100 ? 'OUI' : 'NON'}`);
});

console.log('\n🎯 Résumé: Tous les contenus doivent faire maximum 100 caractères !');
