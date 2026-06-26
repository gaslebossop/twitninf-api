const os = require('os');
const logger = console;

async function testE5Base() {
  console.log('🚀 Test de performance : Modèle Multilingual-E5-Base (768-dim)');
  console.log(`💻 RAM Totale : ${(os.totalmem() / 1024 / 1024 / 1024).toFixed(2)} GB`);
  console.log(`📉 RAM Libre avant : ${(os.freemem() / 1024 / 1024 / 1024).toFixed(2)} GB`);

  try {
    console.log('\n📦 Chargement de @xenova/transformers...');
    const { pipeline } = await import('@xenova/transformers');
    
    const startLoad = Date.now();
    console.log('⏳ Téléchargement/Chargement du modèle (Xenova/multilingual-e5-base)...');
    console.log('   (Cela peut prendre une minute la première fois)');
    
    // Chargement du modèle Base
    const extractor = await pipeline('feature-extraction', 'Xenova/multilingual-e5-base');
    
    const endLoad = Date.now();
    console.log(`✅ Modèle chargé en ${((endLoad - startLoad) / 1000).toFixed(2)}s`);
    console.log(`📉 RAM Libre après chargement : ${(os.freemem() / 1024 / 1024 / 1024).toFixed(2)} GB`);

    const testText = 'query: tu connais @gas ?';
    console.log(`\n🧠 Test d'embedding pour : "${testText}"`);
    
    const startEmbed = Date.now();
    const output = await extractor(testText, { pooling: 'mean', normalize: true });
    const endEmbed = Date.now();
    
    const vector = Array.from(output.data);
    console.log(`✅ Embedding généré en ${endEmbed - startEmbed}ms`);
    console.log(`📊 Taille du vecteur : ${vector.length} dimensions (Objectif : 768)`);
    console.log(`🔍 Aperçu (5 premiers) : [${vector.slice(0, 5).join(', ')}]`);

    if (vector.length === 768) {
      console.log('\n🔥 RÉSULTAT : Le modèle est parfaitement opérationnel sur ta machine !');
    } else {
      console.log(`\n⚠️ ATTENTION : Taille de vecteur inattendue (${vector.length})`);
    }

  } catch (err) {
    console.error('\n❌ ERREUR CRITIQUE :', err.message);
    if (err.message.includes('out of memory')) {
      console.log('🛑 Diagnostic : Ta RAM est trop juste pour ce modèle.');
    }
  }
}

testE5Base();
