#!/usr/bin/env bash
#
# Déploiement de l'API Node sur un ou plusieurs VPS.
#
# Remplace la commande `tar | ssh` d'api/CLAUDE.md, qui posait trois problèmes
# devenus bloquants avec plusieurs machines :
#
#   1. Elle déversait TOUT l'arbre local dans /home/debian/api, y compris les
#      répertoires de médias — donc elle écrasait les uploads de production par
#      leur état local (généralement vide).
#   2. Elle ne connaissait qu'un seul hôte.
#   3. Elle faisait `pm2 restart` sans le moindre contrôle : un déploiement qui
#      casse le démarrage laissait l'API morte sans que rien ne le signale.
#
# Usage :
#   ./deploy-vps.sh                 # déploie sur tous les hôtes de HOSTS
#   ./deploy-vps.sh --check         # contrôles de santé seuls, ne touche à rien
#   ./deploy-vps.sh --host debian@X # déploie sur un seul hôte
#
# Configuration par variables d'environnement :
#   HOSTS  — liste d'hôtes séparés par des espaces
#   PM2_APPS_<n> — non utilisé : chaque hôte redémarre tous ses process pm2
#                  dont le nom commence par `twitninf-api`
#
set -euo pipefail

# VPS A (edge, base + worker) puis VPS B (web + réplique PostgreSQL).
HOSTS="${HOSTS:-debian@51.210.11.74 debian@51.255.48.125}"
VPS_KEY="${VPS_KEY:-C:\\Users\\nouno\\OneDrive\\Bureau\\Documents\\privatessh}"
REMOTE_DIR="${REMOTE_DIR:-/home/debian/api}"

log()  { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m⚠ %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

ssh_host() { ssh -i "$VPS_KEY" -o StrictHostKeyChecking=accept-new "$1" "${@:2}"; }

if [ "${1:-}" = "--host" ]; then
  HOSTS="${2:?--host attend une cible ssh}"
  shift 2
fi

# ── Contrôle de santé ────────────────────────────────────────────────────────
#
# On interroge /api/health en local sur l'hôte, pas à travers le répartiteur :
# derrière le répartiteur, une réponse saine peut venir de l'autre machine et
# masquer un nœud mort. Le champ `instance` confirme qui a répondu.
check_host() {
  local host="$1"
  local port="${2:-3001}"
  log "Santé de $host:$port"

  # Le démarrage prend une bonne trentaine de secondes : chargement du modèle
  # d'embeddings, index sémantique, moteurs de recommandation. Un contrôle
  # unique juste après le rechargement échouerait systématiquement, et ferait
  # passer un déploiement parfaitement sain pour un échec. On attend donc que
  # le port réponde, jusqu'à 90 s.
  local health=""
  for _ in $(seq 1 18); do
    health="$(ssh_host "$host" "curl -s --max-time 8 http://127.0.0.1:$port/api/health" 2>/dev/null || true)"
    case "$health" in *'"success":true'*) break ;; esac
    sleep 5
  done
  case "$health" in
    *'"success":true'*) ;;
    *) die "$host:$port : /api/health injoignable après 90 s" ;;
  esac

  echo "$health" | head -c 600; echo

  case "$health" in
    *'"database":"connected"'*) ;;
    *) die "$host : base injoignable depuis l'API" ;;
  esac
  case "$health" in
    *'"redis":"connected"'*) ;;
    *) warn "$host : Redis signalé déconnecté" ;;
  esac
  # Une réplique déclarée mais injoignable n'empêche pas de servir (repli sur le
  # primaire), mais c'est exactement le genre de panne qui passe inaperçue.
  case "$health" in
    *'"reachable":false'*) warn "$host : réplique de lecture injoignable — repli sur le primaire" ;;
  esac
}

check_all() { for h in $HOSTS; do check_host "$h"; done; }

# Un seul process worker doit exister dans tout le parc, sinon PolicierCongo,
# TwitNinfAI et les purges tournent en double.
# On interroge /api/health plutôt que l'environnement pm2 : le rôle peut venir
# du .env comme de la ligne de commande pm2, et seul le process sait vraiment
# lequel il a retenu. Un contrôle qui lit la configuration au lieu du
# comportement donne des faux négatifs.
WORKER_PORTS="${WORKER_PORTS:-3001 3003 3004}"

check_single_worker() {
  log "Vérification du rôle worker unique"
  local workers=0
  for h in $HOSTS; do
    for p in $WORKER_PORTS; do
      local body role
      body="$(ssh_host "$h" "curl -s --max-time 6 http://127.0.0.1:$p/api/health" 2>/dev/null || true)"
      case "$body" in *'"success":true'*) ;; *) continue ;; esac
      role="$(printf '%s' "$body" | grep -o '"role":"[a-z]*"' | cut -d'"' -f4)"
      echo "  $h:$p → ${role:-inconnu}"
      case "$role" in
        worker|all) workers=$((workers + 1)) ;;
      esac
    done
  done
  [ "$workers" -le 1 ] || die "$workers process worker détectés — PolicierCongo, TwitNinfAI et les purges tourneraient en double"
  [ "$workers" -eq 1 ] || warn "aucun worker détecté — les tâches de fond ne tournent nulle part"
}

if [ "${1:-}" = "--check" ]; then
  check_all
  check_single_worker
  exit 0
fi

cd "$(dirname "$0")"

# ── Envoi des sources ────────────────────────────────────────────────────────
#
# Les exclusions ne sont pas cosmétiques :
#   storage/, src/public/avatars/ — médias de production, ils ne doivent JAMAIS
#     être remplacés par l'arbre local.
#   data/ — index vectoriels générés par le worker sur sa propre machine.
#   .env — chaque hôte a le sien (rôle, hôte base, réplique locale).
#   scheduler.json — état hérité de PolicierCongo, désormais dans Redis ;
#     l'écraser au déploiement remettrait un horaire périmé.
#   src/public/tweets, src/public/stories — médias envoyés par les
#     utilisateurs, créés à l'exécution. Ils n'existent localement que si
#     quelqu'un a lancé l'API sur sa machine ; les envoyer déverserait des
#     fichiers de test dans la production.
EXCLUDES=(
  --exclude=node_modules --exclude=.git
  --exclude=storage --exclude=src/public/avatars --exclude=data
  --exclude=src/public/tweets --exclude=src/public/stories
  --exclude=.env --exclude=logs
  --exclude=src/services/policiercongo/scheduler.json
)

for host in $HOSTS; do
  log "Déploiement sur $host"

  tar -czf - "${EXCLUDES[@]}" . \
    | ssh_host "$host" "mkdir -p '$REMOTE_DIR' && tar -xzf - -C '$REMOTE_DIR'"

  log "$host : installation des dépendances"
  ssh_host "$host" "cd '$REMOTE_DIR' && npm install --omit=dev 2>&1 | tail -5"

  # `pm2 reload` recharge sans coupure, contrairement à `restart` qui tue le
  # process avant de le relancer. Avec deux nœuds, le trafic bascule sur
  # l'autre pendant le rechargement.
  #
  # On ne recharge QUE les process de l'API (`twitninf-api*`) : `pm2 reload all`
  # emporterait aussi tout autre process pm2 présent sur la machine.
  log "$host : rechargement des process twitninf-api*"
  ssh_host "$host" "cd '$REMOTE_DIR' && \
    names=\$(pm2 jlist 2>/dev/null | grep -o '\"name\":\"twitninf-api[^\"]*\"' | cut -d'\"' -f4 | sort -u); \
    [ -n \"\$names\" ] || { echo 'aucun process twitninf-api sous pm2'; exit 1; }; \
    for n in \$names; do echo \"reload \$n\"; pm2 reload \"\$n\" --update-env; done"

  # `check_host` attend déjà que le service réponde, inutile de temporiser ici.
  check_host "$host" "${HEALTH_PORT:-3001}"
done

check_single_worker

log "Déploiement terminé"
