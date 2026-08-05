#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Ce script doit être lancé avec sudo." >&2
  exit 1
fi

repo_dir=${1:-/home/debian/api}
active_site=/etc/nginx/sites-available/twitninf-api
backup_site="${active_site}.pre-autoscale-$(date -u +%Y%m%dT%H%M%SZ)"
log_config=/etc/nginx/conf.d/twitninf-autoscale-log.conf
backup_log_config="${log_config}.pre-autoscale"
nginx_main=/etc/nginx/nginx.conf
backup_nginx_main="${nginx_main}.pre-autoscale-$(date -u +%Y%m%dT%H%M%SZ)"

for source_file in \
  "$repo_dir/deploy/twitninf-autoscaler.py" \
  "$repo_dir/deploy/twitninf-autoscaler.service" \
  "$repo_dir/deploy/twitninf-autoscaler.timer" \
  "$repo_dir/deploy/twitninf-autoscaler.defaults" \
  "$repo_dir/deploy/nginx-twitninf-autoscale-log.conf" \
  "$repo_dir/deploy/nginx-twitninf-api.conf"; do
  [[ -f "$source_file" ]] || { echo "Fichier manquant: $source_file" >&2; exit 1; }
done

cp -a "$active_site" "$backup_site"
cp -a "$nginx_main" "$backup_nginx_main"
had_log_config=0
if [[ -e "$log_config" ]]; then
  cp -a "$log_config" "$backup_log_config"
  had_log_config=1
fi
install -m 0755 "$repo_dir/deploy/twitninf-autoscaler.py" /usr/local/sbin/twitninf-autoscaler
install -m 0644 "$repo_dir/deploy/twitninf-autoscaler.service" /etc/systemd/system/twitninf-autoscaler.service
install -m 0644 "$repo_dir/deploy/twitninf-autoscaler.timer" /etc/systemd/system/twitninf-autoscaler.timer
install -m 0644 "$repo_dir/deploy/nginx-twitninf-autoscale-log.conf" "$log_config"
install -m 0644 "$repo_dir/deploy/nginx-twitninf-api.conf" "$active_site"

# Le simulateur autorise jusqu'a 10 000 connexions persistantes. Chaque requete
# proxifiee consomme une connexion client et une connexion upstream; 768 etait
# donc insuffisant et produisait des 5xx avant meme que C1 puisse demarrer.
if ! grep -Eq '^[[:space:]]*worker_connections[[:space:]]+[0-9]+[[:space:]]*;' "$nginx_main"; then
  echo "Directive worker_connections introuvable dans $nginx_main" >&2
  exit 1
fi
sed -Ei '0,/^[[:space:]]*worker_connections[[:space:]]+[0-9]+[[:space:]]*;/{s//\tworker_connections 8192;/}' "$nginx_main"

if [[ ! -e /etc/default/twitninf-autoscaler ]]; then
  install -m 0644 "$repo_dir/deploy/twitninf-autoscaler.defaults" /etc/default/twitninf-autoscaler
fi

set_autoscaler_default() {
  local key=$1 value=$2 defaults=/etc/default/twitninf-autoscaler
  if grep -qE "^${key}=" "$defaults"; then
    sed -Ei "s|^${key}=.*|${key}=${value}|" "$defaults"
  else
    printf '%s=%s\n' "$key" "$value" >> "$defaults"
  fi
}
set_autoscaler_default AUTOSCALE_HIGH_STREAK 1
set_autoscaler_default AUTOSCALE_OUT_COOLDOWN_SECONDS 5
set_autoscaler_default AUTOSCALE_LOW_STREAK 120
set_autoscaler_default AUTOSCALE_WARMUP_SECONDS 3

if [[ ! -e /etc/nginx/twitninf-autoscale-upstreams.conf ]]; then
  printf '%s\n' '# Géré automatiquement par twitninf-autoscaler. Ne pas éditer.' \
    > /etc/nginx/twitninf-autoscale-upstreams.conf
  chmod 0644 /etc/nginx/twitninf-autoscale-upstreams.conf
fi

if ! nginx -t; then
  cp -a "$backup_site" "$active_site"
  cp -a "$backup_nginx_main" "$nginx_main"
  if [[ $had_log_config -eq 1 ]]; then
    mv -f "$backup_log_config" "$log_config"
  else
    rm -f "$log_config"
  fi
  nginx -t
  echo "Configuration refusée, site restauré depuis $backup_site" >&2
  exit 1
fi

if ! systemctl reload nginx; then
  cp -a "$backup_site" "$active_site"
  cp -a "$backup_nginx_main" "$nginx_main"
  if [[ $had_log_config -eq 1 ]]; then
    mv -f "$backup_log_config" "$log_config"
  else
    rm -f "$log_config"
  fi
  nginx -t
  systemctl reload nginx
  echo "Reload refusé, site restauré depuis $backup_site" >&2
  exit 1
fi
rm -f "$backup_log_config"
systemctl daemon-reload
systemctl enable --now twitninf-autoscaler.timer

echo "Autoscaler installé. Sauvegarde Nginx: $backup_site"
systemctl --no-pager status twitninf-autoscaler.timer
