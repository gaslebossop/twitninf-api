#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Ce script doit etre lance avec sudo." >&2
  exit 1
fi

repo_dir=${1:-/home/debian/api}
node=${2:-}
case "$node" in
  A|a) web_process=twitninf-api ;;
  B|b) web_process=twitninf-api-web ;;
  *) echo "usage: $0 [repo] A|B" >&2; exit 2 ;;
esac

for source_file in \
  "$repo_dir/deploy/twitninf-infra-control" \
  "$repo_dir/deploy/twitninf-remote-control"; do
  [[ -f "$source_file" ]] || { echo "Fichier manquant: $source_file" >&2; exit 1; }
done

install -o root -g root -m 0755 "$repo_dir/deploy/twitninf-infra-control" /usr/local/sbin/twitninf-infra-control
install -o root -g root -m 0755 "$repo_dir/deploy/twitninf-remote-control" /usr/local/sbin/twitninf-remote-control

cat > /etc/default/twitninf-infra-control <<EOF
WEB_PROCESS=$web_process
PM2_USER=debian
PM2_HOME=/home/debian/.pm2
PM2_BIN=/usr/bin/pm2
PG_CLUSTER=17/main
EOF
chown root:root /etc/default/twitninf-infra-control
chmod 0644 /etc/default/twitninf-infra-control

sudoers=/etc/sudoers.d/twitninf-infra-control
temporary=$(mktemp /etc/sudoers.d/twitninf-infra-control.XXXXXX)
trap 'rm -f "$temporary"' EXIT
printf '%s\n' 'debian ALL=(root) NOPASSWD: /usr/local/sbin/twitninf-infra-control *' > "$temporary"
chmod 0440 "$temporary"
visudo -cf "$temporary" >/dev/null
mv -f "$temporary" "$sudoers"
trap - EXIT

/usr/local/sbin/twitninf-infra-control status
