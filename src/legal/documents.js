/**
 * Documents contractuels de TwitNinf.
 *
 * Ils vivent ici, et non dans un CMS ou dans les applications, pour trois
 * raisons : le socle de consentement doit pouvoir pointer vers la version
 * exacte qu'une personne a acceptee ; les deux clients (mobile, Windows) les
 * lisent a la meme URL ; et une correction s'applique partout sans publier de
 * nouvelle version d'application.
 *
 * `version` doit rester aligne sur CONSENT_VERSION (config/consent.js) : c'est
 * ce qui garantit qu'un accord enregistre correspond a un texte identifiable.
 * Changer le FOND d'un document impose donc d'incrementer les deux, ce qui
 * reinterroge les comptes — c'est voulu.
 */

const DOCUMENT_VERSION = '2026-08-09';
const PUBLISHER = 'TwitNinf';
const CONTACT_EMAIL = 'contact@twitninf.fr';
const PRIVACY_EMAIL = 'donnees@twitninf.fr';
const MINIMUM_AGE = 15;

const terms = {
  slug: 'cgu',
  title: "Conditions générales d'utilisation",
  version: DOCUMENT_VERSION,
  sections: [
    {
      heading: 'Objet',
      body: `<p>Ces conditions régissent l'usage de ${PUBLISHER}, un réseau social permettant de
      publier des messages courts, des images et des vidéos, d'échanger en messages privés, de
      diffuser en direct et d'utiliser une monnaie interne. Créer un compte vaut acceptation de ce
      document et de la <a href="/legal/confidentialite">politique de confidentialité</a>.</p>`,
    },
    {
      heading: 'Qui peut ouvrir un compte',
      body: `<p>Il faut avoir ${MINIMUM_AGE} ans révolus. En dessous de cet âge, l'accord d'un
      titulaire de l'autorité parentale est nécessaire et le compte ne peut pas être ouvert seul.
      Un compte par personne physique, sauf comptes automatisés déclarés comme tels.</p>
      <p>Un compte dont l'âge déclaré s'avère faux peut être fermé sans préavis.</p>`,
    },
    {
      heading: 'Ce que tu publies',
      body: `<p>Tu restes propriétaire de tes contenus. Tu accordes à ${PUBLISHER} le droit
      non exclusif de les héberger, afficher, redimensionner et transmettre dans le seul but de
      faire fonctionner le service — y compris de les montrer à d'autres comptes selon tes
      réglages de visibilité. Ce droit s'éteint quand tu supprimes le contenu, sous réserve des
      copies techniques temporaires et des conservations légales décrites dans la politique de
      confidentialité.</p>
      <p>Tu garantis détenir les droits sur ce que tu publies, y compris sur la musique et les
      extraits vidéo.</p>`,
    },
    {
      heading: 'Ce qui est interdit',
      body: `<ul>
      <li>Contenus sexuels impliquant des mineurs, sous quelque forme que ce soit. Ils sont
      signalés aux autorités compétentes.</li>
      <li>Incitation à la haine, à la violence ou au terrorisme ; harcèlement ; menaces.</li>
      <li>Diffusion de données personnelles d'autrui sans son accord.</li>
      <li>Contenus sexuels non consentis, y compris les montages.</li>
      <li>Usurpation d'identité, tromperie organisée, manipulation coordonnée de l'audience.</li>
      <li>Contournement des mesures de sécurité, extraction massive automatisée, fraude sur la
      monnaie interne ou les paiements.</li>
      </ul>`,
    },
    {
      heading: 'Modération',
      body: `<p>Les contenus <strong>publiés</strong> sont analysés automatiquement avant
      diffusion large, puis examinés par une personne en cas de signalement. Une publication peut
      être masquée, dépubliée ou rendue non éligible aux recommandations. Un compte peut être
      restreint, suspendu ou fermé.</p>
      <p>Tes <strong>messages privés</strong> ne sont pas analysés automatiquement à la recherche
      de contenus illicites. Ils peuvent être lus par une personne habilitée uniquement lorsqu'un
      participant à la conversation les signale, ou sur réquisition d'une autorité.</p>
      <p>Toute décision de modération peut être contestée par le formulaire de réclamation prévu
      dans l'application. Une réponse motivée est due.</p>`,
    },
    {
      heading: 'Monnaie interne, abonnements et paiements',
      body: `<p>La monnaie interne n'est pas une monnaie ayant cours légal, n'est pas un moyen de
      paiement en dehors du service, et n'est pas remboursable en euros sauf obligation légale.
      Les abonnements payants sont reconduits selon la périodicité affichée à l'achat et
      résiliables à tout moment pour la période suivante.</p>
      <p>Les paiements et les transferts sont soumis à un contrôle anti-fraude automatique. Une
      opération peut être refusée, et un portefeuille temporairement restreint, quand des indices
      concordants de fraude sont réunis. Une restriction automatique expire d'elle-même ; un gel
      décidé par une personne habilitée se lève manuellement.</p>`,
    },
    {
      heading: 'Suspension et fermeture',
      body: `<p>Tu peux fermer ton compte à tout moment depuis les réglages.
      ${PUBLISHER} peut suspendre ou fermer un compte en cas de manquement à ces conditions, de
      risque pour les autres comptes, ou d'obligation légale. Sauf urgence ou interdiction légale,
      le motif est communiqué.</p>`,
    },
    {
      heading: 'Responsabilité',
      body: `<p>Le service est fourni en l'état. ${PUBLISHER} ne garantit ni la disponibilité
      ininterrompue, ni l'absence d'erreur, et n'est pas responsable des contenus publiés par les
      comptes. Rien dans ce document ne limite une responsabilité qui ne peut pas l'être en droit,
      notamment en cas de faute lourde ou de dommage corporel.</p>`,
    },
    {
      heading: 'Modification de ces conditions',
      body: `<p>Une modification de fond est notifiée dans l'application et te sera soumise avant
      de continuer à utiliser le service. La version en vigueur porte un numéro daté, rappelé en
      tête de ce document et enregistré avec ton acceptation.</p>`,
    },
    {
      heading: 'Droit applicable',
      body: `<p>Droit français. En cas de litige, les tribunaux français sont compétents, sans
      préjudice des règles protectrices du consommateur qui te permettent de saisir la juridiction
      de ton lieu de résidence dans l'Union européenne. Contact : ${CONTACT_EMAIL}.</p>`,
    },
  ],
};

const privacy = {
  slug: 'confidentialite',
  title: 'Politique de confidentialité',
  version: DOCUMENT_VERSION,
  sections: [
    {
      heading: 'Responsable du traitement',
      body: `<p>${PUBLISHER} est responsable des traitements décrits ici. Pour toute question ou
      pour exercer tes droits : <a href="mailto:${PRIVACY_EMAIL}">${PRIVACY_EMAIL}</a>.</p>`,
    },
    {
      heading: 'Ce qui est traité, pourquoi, et sur quelle base',
      body: `<table>
      <thead><tr><th>Données</th><th>Finalité</th><th>Base légale</th><th>Conservation</th></tr></thead>
      <tbody>
      <tr><td>Identifiant, nom affiché, adresse e-mail, mot de passe (haché), avatar, bannière, biographie</td>
      <td>Tenir ton compte et te permettre de te connecter</td><td>Exécution du contrat</td>
      <td>Durée du compte, puis 30 jours</td></tr>

      <tr><td>Âge déclaré, jour et mois de naissance</td>
      <td>Vérifier l'âge minimum, produire des tranches d'audience agrégées, afficher ton anniversaire</td>
      <td>Obligation légale (âge) et exécution du contrat</td><td>Durée du compte</td></tr>

      <tr><td>Publications, messages privés, médias</td>
      <td>Fournir le service</td><td>Exécution du contrat</td>
      <td>Jusqu'à suppression par toi, puis 30 jours en sauvegarde</td></tr>

      <tr><td>Sessions : empreinte du jeton, identifiant d'appareil, plateforme, version, agent utilisateur, adresse IP</td>
      <td>Te maintenir connecté, te lister tes appareils, révoquer à distance</td>
      <td>Exécution du contrat et intérêt légitime (sécurité)</td><td>180 jours après la dernière utilisation</td></tr>

      <tr><td>Signaux d'usage : lectures, likes, temps passé, contenus ignorés</td>
      <td>Ordonner ton fil</td><td><strong>Consentement</strong> — refusable, le fil devient chronologique</td>
      <td>13 mois</td></tr>

      <tr><td>Position approximative à la connexion (arrondie à environ 100 m), pays, région, ville, fuseau</td>
      <td>Statistiques géographiques agrégées, sécurisation des sessions</td>
      <td><strong>Consentement</strong> — refusable</td><td>13 mois</td></tr>

      <tr><td>Vues comptées dans les statistiques des comptes que tu consultes</td>
      <td>Informer les créateurs sur leur audience</td>
      <td><strong>Consentement</strong> — refusable</td><td>13 mois, en agrégat</td></tr>

      <tr><td>Jeton de notification push</td>
      <td>Notifications liées à ton compte ; notifications de découverte</td>
      <td>Exécution du contrat ; <strong>consentement</strong> pour la découverte</td>
      <td>Jusqu'à désinstallation ou retrait</td></tr>

      <tr><td>Signaux anti-fraude : empreintes techniques (appareil, réseau, moyen de paiement) sous forme non réversible, historique des décisions de risque</td>
      <td>Détecter les intrusions, la fraude aux paiements et les réseaux de comptes</td>
      <td>Intérêt légitime, et obligation légale pour les paiements</td><td>13 mois ; 5 ans pour les pièces comptables</td></tr>

      <tr><td>Signalements et décisions de modération</td>
      <td>Appliquer la loi et les règles du service, permettre la contestation</td>
      <td>Obligation légale et intérêt légitime</td><td>1 an après la décision, 5 ans en cas de suite judiciaire</td></tr>

      <tr><td>Portefeuille, transactions, abonnements</td>
      <td>Exécuter les paiements et tenir la comptabilité</td>
      <td>Exécution du contrat et obligation légale</td><td>10 ans (obligation comptable)</td></tr>

      <tr><td>Preuve de consentement : finalité, réponse, version du socle, date, source, empreinte non réversible de l'adresse IP</td>
      <td>Démontrer ton accord ou ton refus</td><td>Obligation légale (art. 7.1 RGPD)</td>
      <td>5 ans après le retrait ou la fermeture du compte</td></tr>
      </tbody></table>`,
    },
    {
      heading: 'Décisions automatisées',
      body: `<p>Deux traitements produisent des effets sans intervention humaine immédiate :</p>
      <ul>
      <li><strong>Modération des publications.</strong> Une publication peut être rendue non
      éligible aux recommandations automatiquement. Tu peux demander un réexamen par une
      personne.</li>
      <li><strong>Anti-fraude sur les paiements.</strong> Une opération peut être refusée et un
      portefeuille temporairement restreint. Une restriction automatique expire d'elle-même, et tu
      peux demander un réexamen par une personne.</li>
      </ul>
      <p>Dans les deux cas tu as le droit d'obtenir une explication, de contester la décision et
      d'obtenir une intervention humaine (art. 22 RGPD).</p>`,
    },
    {
      heading: 'Analyse des messages privés',
      body: `<p>Depuis le 3 août 2026, une dérogation européenne temporaire à la directive
      ePrivacy (applicable jusqu'au 3 avril 2028) <em>autorise</em> les services de communication
      à rechercher volontairement des contenus pédocriminels dans les messages non chiffrés. Cette
      dérogation est une permission, pas une obligation, et elle exclut expressément les
      communications chiffrées de bout en bout.</p>
      <p><strong>${PUBLISHER} ne s'en sert pas.</strong> Aucune analyse automatique systématique
      n'est appliquée au contenu de tes messages privés. Ils ne sont lus par une personne
      habilitée que si un participant à la conversation les signale, ou sur réquisition d'une
      autorité judiciaire.</p>
      <p>Si cette position change — notamment si le règlement européen permanent en cours de
      négociation impose une détection —, la modification sera notifiée dans l'application avant
      d'entrer en vigueur, et cette page sera mise à jour avec une nouvelle version datée.</p>`,
    },
    {
      heading: 'Qui reçoit tes données',
      body: `<p>Elles ne sont ni vendues, ni louées, ni transmises à des courtiers en données.
      Elles sont accessibles à nos prestataires techniques, strictement pour faire fonctionner le
      service : hébergement, envoi des notifications, analyse automatique des publications par un
      modèle de langage, traduction automatique, traitement des paiements. Chacun est lié par
      contrat et ne peut pas les utiliser pour son compte.</p>
      <p>Les créateurs ne voient jamais que des statistiques agrégées portant sur au moins
      5 personnes : ni ton identité, ni tes coordonnées, ni ta position.</p>`,
    },
    {
      heading: 'Transferts hors Union européenne',
      body: `<p>Certains prestataires traitent des données hors de l'Union européenne. Ces
      transferts reposent sur les clauses contractuelles types de la Commission européenne, ou sur
      une décision d'adéquation lorsqu'elle existe pour le pays concerné.</p>`,
    },
    {
      heading: 'Tes droits',
      body: `<p>Tu peux à tout moment demander l'accès à tes données, leur rectification, leur
      effacement, la limitation de leur traitement, leur portabilité dans un format lisible, et
      t'opposer aux traitements fondés sur l'intérêt légitime.</p>
      <p>Les accords facultatifs se retirent depuis <strong>Réglages → Confidentialité → Tes
      données et tes accords</strong>, aussi simplement qu'ils ont été donnés. Un retrait ne remet
      pas en cause la licéité de ce qui a été traité avant.</p>
      <p>Écris à <a href="mailto:${PRIVACY_EMAIL}">${PRIVACY_EMAIL}</a>. Une réponse est due sous
      un mois. Tu peux aussi saisir la CNIL (<a href="https://www.cnil.fr">cnil.fr</a>).</p>`,
    },
    {
      heading: 'Sécurité',
      body: `<p>Les mots de passe sont hachés et jamais stockés en clair. Les jetons de session
      sont conservés sous forme d'empreinte. Les identifiants techniques utilisés par l'anti-fraude
      sont transformés par une fonction à clé secrète, non réversible. Les accès aux bases sont
      restreints au réseau interne des serveurs.</p>`,
    },
    {
      heading: 'Modification de cette politique',
      body: `<p>Toute modification de fond est notifiée dans l'application et te sera soumise
      avant de continuer à utiliser le service. La version en vigueur est identifiée par un numéro
      daté, enregistré avec ton acceptation.</p>`,
    },
  ],
};

module.exports = {
  DOCUMENT_VERSION,
  MINIMUM_AGE,
  documents: { terms, privacy },
};
