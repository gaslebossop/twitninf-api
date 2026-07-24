const fs = require('fs');
const path = require('path');
const { VectorStore, DIMS } = require('./src/services/similarity/vectorEngine');
require('dotenv').config();
const { Tweet, User } = require('./src/models');

async function generate3DExport() {
  console.log('\n=======================================');
  console.log('🚀 EXPORT 3D SIMILARITY TWITNINF 🚀');
  console.log('=======================================\n');

  // Configurer les chemins
  const dataDir = path.join(__dirname, 'data', 'similarity');
  const outputFile = path.join(__dirname, 'similarity_3d_export.html');

  // 1. Charger les magasins de vecteurs
  console.log('⏳ Chargement des vecteurs locaux...');
  const tweetStore = new VectorStore('tweets', dataDir);
  const userStore = new VectorStore('users', dataDir);

  const tweetCount = tweetStore.load();
  const userCount = userStore.load();
  console.log(`✅ Fichiers lus : ${tweetCount} tweets, ${userCount} utilisateurs.`);

  if (tweetCount === 0 && userCount === 0) {
    console.log('\n❌ Base de données vectorielle vide, impossible de créer le rendu.');
    process.exit(1);
  }

  // 2. Récupération des vrais textes/pseudos en base de données
  console.log('🌍 Connexion à PostgreSQL pour récupérer les textes et pseudos...');
  const dbTweets = await Tweet.findAll({ attributes: ['id', 'content'] }).catch(() => []);
  const dbUsers = await User.findAll({ attributes: ['id', 'username'] }).catch(() => []);

  const tweetMap = new Map();
  const userMap = new Map();

  for (const t of dbTweets) {
    // Nettoyage rapide pour ne pas casser le JSON/HTML
    let safeContent = t.content || '';
    safeContent = safeContent.replace(/"/g, '&quot;').replace(/\n/g, ' ').substring(0, 100);
    tweetMap.set(t.id, safeContent + '...');
  }
  
  for (const u of dbUsers) {
    userMap.set(u.id, u.username);
  }
  console.log(`✅ Textes récupérés : ${dbTweets.length} tweets et ${dbUsers.length} comptes.`);

  // 3. Extraction de tout dans un seul tableau
  const items = [];
  for (const [id, vec] of tweetStore.index.entries()) items.push({ id, type: 'tweet', vec });
  for (const [id, vec] of userStore.index.entries()) items.push({ id, type: 'user', vec });

  // 4. Projection 3D (Random Orthogonal Projection pour préserver la distorsion sur DIMS 256)
  console.log('🧠 Projection mathématique (256D -> 3D) en cours...');
  function getRandVec() {
    const v = new Float32Array(DIMS);
    for (let i = 0; i < DIMS; i++) v[i] = Math.random() - 0.5;
    return v;
  }
  function dot(a, b) { let sum=0; for(let i=0; i<DIMS; i++) sum+=a[i]*b[i]; return sum; }
  function sub(a, b, coef) { for(let i=0; i<DIMS; i++) a[i] -= b[i]*coef; }
  function normalize(a) { const n = Math.sqrt(dot(a,a)); for(let i=0; i<DIMS; i++) a[i]/=n; }

  const projX = getRandVec();
  const projY = getRandVec();
  const projZ = getRandVec();

  normalize(projX);
  sub(projY, projX, dot(projY, projX)); normalize(projY);
  sub(projZ, projX, dot(projZ, projX)); sub(projZ, projY, dot(projZ, projY)); normalize(projZ);

  // 5. Remplir les données JS pour Plotly
  const plotData = {
    tweets: { x: [], y: [], z: [], text: [], marker: { color: '#1B9A59', size: 3, opacity: 0.6 } },
    users: { x: [], y: [], z: [], text: [], marker: { color: '#E1306C', size: 6, opacity: 0.9, symbol: 'diamond' } }
  };

  for (const item of items) {
    const px = dot(item.vec, projX);
    const py = dot(item.vec, projY);
    const pz = dot(item.vec, projZ);
    
    if (item.type === 'tweet') {
      plotData.tweets.x.push(px);
      plotData.tweets.y.push(py);
      plotData.tweets.z.push(pz);
      const text = tweetMap.get(item.id) || `[Tweet Supprimé ou Inconnu]`;
      plotData.tweets.text.push(text);
    } else {
      plotData.users.x.push(px);
      plotData.users.y.push(py);
      plotData.users.z.push(pz);
      const username = userMap.get(item.id) || `ID_Inconnu`;
      plotData.users.text.push(`@${username}`);
    }
  }

  // 6. Sauvegarde HTML
  console.log(`🖼️ Compilation du fichier HTML et injection des données...`);
  const htmlContent = `
<!DOCTYPE html>
<html>
<head>
    <title>TwitNinf - 3D Similarity Visualizer</title>
    <script src="https://cdn.plot.ly/plotly-2.32.0.min.js"></script>
    <style>
      body { margin: 0; padding: 0; background-color: #111; color: white; font-family: sans-serif; overflow: hidden; }
      #plot { width: 100vw; height: 100vh; }
      .header { position: absolute; top: 10px; left: 20px; z-index: 10; pointer-events: none; }
      .instructions { position: absolute; bottom: 20px; left: 20px; z-index: 10; font-size: 14px; background: rgba(0,0,0,0.6); padding: 15px; border-radius: 8px; pointer-events: none; border: 1px solid #333;}
      h2 { margin-bottom: 5px; }
      p { margin-top: 0; color: #ccc; }
      .btn { display: inline-block; background: #E1306C; padding: 5px 10px; border-radius: 4px; color: white; margin-top: 5px; }
    </style>
</head>
<body>
    <div class="header">
        <h2>🧠 Espaces Sémantiques (256D &rarr; 3D)</h2>
        <p>🟢 Tweets | 💎 Comptes (${tweetCount + userCount} blocs sémantiques)</p>
    </div>
    
    <div id="plot"></div>
    
    <div class="instructions">
      📸 <b>Comment exporter une superbe image HD ?</b><br><br>
      1. Reste appuyé sur le clic pour faire tourner l'angle 3D.<br>
      2. Le zoom se fait à la molette.<br>
      3. Amène discrètement ta souris en <b>Haut à Droite</b> de l'écran.<br>
      4. Clique sur la 1ère icône <b>"Download plot as a png"</b> !
    </div>
    
    <script>
        const traceTweets = {
            x: ${JSON.stringify(plotData.tweets.x)},
            y: ${JSON.stringify(plotData.tweets.y)},
            z: ${JSON.stringify(plotData.tweets.z)},
            mode: 'markers',
            hoverinfo: 'text',
            type: 'scatter3d',
            name: 'Tweets',
            text: ${JSON.stringify(plotData.tweets.text)},
            marker: ${JSON.stringify(plotData.tweets.marker)}
        };

        const traceUsers = {
            x: ${JSON.stringify(plotData.users.x)},
            y: ${JSON.stringify(plotData.users.y)},
            z: ${JSON.stringify(plotData.users.z)},
            mode: 'markers',
            hoverinfo: 'text',
            type: 'scatter3d',
            name: 'Users',
            text: ${JSON.stringify(plotData.users.text)},
            marker: ${JSON.stringify(plotData.users.marker)}
        };

        const layout = {
            margin: { l: 0, r: 0, b: 0, t: 0 },
            paper_bgcolor: '#111',
            plot_bgcolor: '#111',
            font: { color: '#fff' },
            showlegend: false,
            scene: {
                xaxis: { title: '', showgrid: true, zeroline: false, showticklabels: false, showline: false, color: '#333' },
                yaxis: { title: '', showgrid: true, zeroline: false, showticklabels: false, showline: false, color: '#333' },
                zaxis: { title: '', showgrid: true, zeroline: false, showticklabels: false, showline: false, color: '#333' },
                bgcolor: '#111'
            }
        };

        Plotly.newPlot('plot', [traceTweets, traceUsers], layout, {responsive: true, displayModeBar: true, displaylogo: false});
    </script>
</body>
</html>
`;

  fs.writeFileSync(outputFile, htmlContent, 'utf8');
  console.log(`\n✅ SUCCÈS !`);
  console.log(`👉 Fichier généré : ${outputFile}`);
  console.log(`Ouvre-le dans ton navigateur pour voir en temps réel les amoncellements entres les pseudos et les textes de tweets !`);
  process.exit(0);
}

generate3DExport();
