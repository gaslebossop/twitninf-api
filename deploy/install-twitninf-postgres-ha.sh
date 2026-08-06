#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Ce script doit etre lance avec sudo." >&2
  exit 1
fi

repo_dir=${1:-/home/debian/api}
node=${2:-}
case "$node" in
  A|a) node=A; bind_ip=10.8.0.1 ;;
  B|b) node=B; bind_ip=10.8.0.2 ;;
  *) echo "usage: $0 [repo] A|B" >&2; exit 2 ;;
esac

for source_file in \
  "$repo_dir/deploy/twitninf-postgres-role-health.py" \
  "$repo_dir/deploy/twitninf-postgres-role-health.service" \
  "$repo_dir/deploy/haproxy-twitninf-postgres.cfg" \
  "$repo_dir/deploy/twitninf-postgres-ha.conf" \
  "$repo_dir/deploy/twitninf-postgres-read-cache.conf"; do
  [[ -f "$source_file" ]] || { echo "Fichier manquant: $source_file" >&2; exit 1; }
done

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq haproxy postgresql-contrib >/dev/null

install -o root -g root -m 0755 "$repo_dir/deploy/twitninf-postgres-role-health.py" /usr/local/sbin/twitninf-postgres-role-health
install -o root -g root -m 0644 "$repo_dir/deploy/twitninf-postgres-role-health.service" /etc/systemd/system/twitninf-postgres-role-health.service
printf 'ROLE_HEALTH_BIND=%s\nROLE_HEALTH_PORT=8008\n' "$bind_ip" > /etc/default/twitninf-postgres-role-health
chown root:root /etc/default/twitninf-postgres-role-health
chmod 0644 /etc/default/twitninf-postgres-role-health

install -o root -g root -m 0644 "$repo_dir/deploy/haproxy-twitninf-postgres.cfg" /etc/haproxy/haproxy.cfg
haproxy -c -f /etc/haproxy/haproxy.cfg >/dev/null

install -d -o postgres -g postgres -m 0750 /etc/postgresql/17/main/conf.d
install -o postgres -g postgres -m 0644 "$repo_dir/deploy/twitninf-postgres-ha.conf" /etc/postgresql/17/main/conf.d/80-twitninf-ha.conf
if [[ $node == B ]]; then
  install -o postgres -g postgres -m 0644 "$repo_dir/deploy/twitninf-postgres-read-cache.conf" /etc/postgresql/17/main/conf.d/90-twitninf-read-cache.conf
fi

db_user=$(sed -nE 's/^DB_USER=(.*)$/\1/p' "$repo_dir/.env" | tail -n 1)
[[ "$db_user" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || { echo "DB_USER invalide" >&2; exit 1; }
hba=/etc/postgresql/17/main/pg_hba.conf
hba_line="host all $db_user 10.8.0.0/24 scram-sha-256"
grep -qxF "$hba_line" "$hba" || printf '%s\n' "$hba_line" >> "$hba"
replication_peer=10.8.0.2
[[ $node == B ]] && replication_peer=10.8.0.1
replication_line="host replication replicator ${replication_peer}/32 scram-sha-256"
grep -qxF "$replication_line" "$hba" || printf '%s\n' "$replication_line" >> "$hba"
rewind_line="host all replicator ${replication_peer}/32 scram-sha-256"
grep -qxF "$rewind_line" "$hba" || printf '%s\n' "$rewind_line" >> "$hba"

systemctl daemon-reload
systemctl enable twitninf-postgres-role-health.service haproxy.service >/dev/null
systemctl restart postgresql
if [[ $node == A ]]; then
  runuser -u postgres -- /usr/bin/psql -v ON_ERROR_STOP=1 <<'SQL'
CREATE EXTENSION IF NOT EXISTS pg_prewarm;
GRANT pg_read_all_settings TO replicator;
GRANT EXECUTE ON FUNCTION pg_catalog.pg_ls_dir(text, boolean, boolean) TO replicator;
GRANT EXECUTE ON FUNCTION pg_catalog.pg_stat_file(text, boolean) TO replicator;
GRANT EXECUTE ON FUNCTION pg_catalog.pg_read_binary_file(text) TO replicator;
GRANT EXECUTE ON FUNCTION pg_catalog.pg_read_binary_file(text, bigint, bigint, boolean) TO replicator;
SQL
fi
systemctl restart twitninf-postgres-role-health.service
systemctl restart haproxy.service

curl -fsS --max-time 3 "http://${bind_ip}:8008/status" >/dev/null
ss -lnt | grep -q '127.0.0.1:6432'
pg_isready -h 127.0.0.1 -p 6432 -t 3 >/dev/null
if [[ $node == B ]]; then
  # Remplit le cache partage avec les tables les plus lues. Une table absente
  # est simplement ignoree, ce qui garde l'installation idempotente.
  for _ in {1..20}; do
    if runuser -u postgres -- /usr/bin/psql -Atqc \
      "select c.relname, pg_prewarm(c.oid) from pg_class c where c.relkind='r' and c.relname in ('users','tweets','tweet_likes','user_follows','notifications')"; then
      break
    fi
    sleep 0.5
  done
fi
echo "PostgreSQL HA endpoint installe sur $node"
