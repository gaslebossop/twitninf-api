/**
 * Sert UNIQUEMENT les documents contractuels, sans base de donnees ni Redis.
 *
 * Sert a relire les CGU et la politique de confidentialite dans un navigateur
 * pendant leur redaction, sans demarrer l'API entiere. N'a aucun role en
 * production : le vrai montage se fait dans server.js.
 */
const express = require('express');

const app = express();
app.use('/legal', require('../src/routes/legalRoutes'));
app.get('/', (req, res) => res.redirect('/legal/cgu'));

const port = Number(process.env.LEGAL_PREVIEW_PORT || 4599);
app.listen(port, () => {
  console.log(`Apercu des documents legaux sur http://localhost:${port}/legal/cgu`);
});
