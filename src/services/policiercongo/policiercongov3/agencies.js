'use strict';

/**
 * Agences affiliées à TwitNinf (partenariats de promotion, cf. get_platform_rules
 * scope=partners). Liste statique tenue à jour manuellement, pas de table DB.
 */
const AGENCIES = Object.freeze([
  {
    name: 'G Corp',
    description: 'Agence affiliée à TwitNinf avec accès aux statistiques de la plateforme dans le cadre d’un partenariat de promotion : elle peut mettre en avant des comptes et booster leurs statistiques.',
    affiliated_usernames: ['gas']
  }
]);

function listAgencies() {
  return {
    agencies: AGENCIES.map(a => ({
      name: a.name,
      description: a.description,
      affiliated_usernames: a.affiliated_usernames
    }))
  };
}

function normalize(value) {
  return String(value || '').replace(/^@/, '').trim().toLowerCase();
}

function findAgencyForUsername(username) {
  const normalized = normalize(username);
  const agency = AGENCIES.find(a => a.affiliated_usernames.some(u => normalize(u) === normalized));
  return { username: normalized, agency: agency ? agency.name : null, description: agency ? agency.description : null };
}

function findUsernamesForAgency(agencyName) {
  const normalized = normalize(agencyName);
  const agency = AGENCIES.find(a => normalize(a.name) === normalized);
  return { agency: agency ? agency.name : agencyName, affiliated_usernames: agency ? agency.affiliated_usernames : [] };
}

function getAgencyAffiliation({ username, agency } = {}) {
  if (username) return findAgencyForUsername(username);
  if (agency) return findUsernamesForAgency(agency);
  return {
    mappings: AGENCIES.flatMap(a => a.affiliated_usernames.map(u => ({ username: u, agency: a.name })))
  };
}

module.exports = { AGENCIES, listAgencies, getAgencyAffiliation };
