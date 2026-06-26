import { MegaLLMClient } from './index.js';
import fs from 'fs';
import path from 'path';

// Résolution robuste du fichier de session (Windows/VPS)
const sessionCandidates = [
  './megallm-session.json',
  '../server/megallm-session.json',
  '../../src/megallm-client/megallm-session.json'
];
const sessionFilePath = sessionCandidates
  .map((p) => path.resolve(p))
  .find((p) => fs.existsSync(p));

async function runTest() {
  console.log('⏳ Initialisation du client MegaLLM...');
  try {
    if (!sessionFilePath) {
      throw new Error(`Fichier de session introuvable. Candidats: ${sessionCandidates.join(' | ')}`);
    }
    const client = new MegaLLMClient(sessionFilePath);

    console.log(`🤖 Modèle défini: ${client.defaultModel}`);
    console.log(`💬 Envoi d'un prompt simple: "Bonjour, donne moi juste le mot 'test'."`);

    const response = await client.generate("ecris en 20 mots le systeme solaire.");

    console.log('\n--- ✅ RÉPONSE DE L\'API ---');
    console.log(response);
    console.log('----------------------------\n');
  } catch (error) {
    console.error('\n--- ❌ ERREUR API ---');
    console.error(error.message);
  }
}

runTest();
