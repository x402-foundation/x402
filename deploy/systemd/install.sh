#!/usr/bin/env bash
# Install Hoodgate systemd units on a fresh Debian/Ubuntu host.
# Idempotent — safe to re-run after config changes.
#
# Prereqs on the host:
#   - Node 20+ at /usr/bin/node
#   - Build artifacts in place:
#       /opt/hoodgate/rh-facilitator/dist/index.cjs
#       /opt/hoodgate/demo-api/dist/server.cjs
#
# Usage (as root):
#   bash install.sh

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "install.sh must run as root (uses systemctl + /etc)" >&2
  exit 1
fi

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# ── User + config dir ────────────────────────────────────────────────
if ! id hoodgate &>/dev/null; then
  echo "Creating system user 'hoodgate'"
  useradd --system --no-create-home --shell /usr/sbin/nologin hoodgate
fi

install -d -m 0755 -o root -g hoodgate /etc/hoodgate

# ── Seed env files (only if absent — never clobber operator edits) ───
seed_env() {
  local src="$1" dst="$2" mode="$3"
  if [[ ! -f "$dst" ]]; then
    echo "Seeding $dst from example (chmod $mode)"
    install -m "$mode" -o root -g hoodgate "$src" "$dst"
  else
    echo "Keeping existing $dst"
  fi
}
seed_env "$HERE/facilitator.env.example"        /etc/hoodgate/facilitator.env        0644
seed_env "$HERE/facilitator.secret.env.example" /etc/hoodgate/facilitator.secret.env 0600
seed_env "$HERE/demo-api.env.example"           /etc/hoodgate/demo-api.env           0644

# ── Install unit files ───────────────────────────────────────────────
install -m 0644 "$HERE/hoodgate-facilitator.service" /etc/systemd/system/hoodgate-facilitator.service
install -m 0644 "$HERE/hoodgate-demo-api.service"    /etc/systemd/system/hoodgate-demo-api.service

systemctl daemon-reload

echo
echo "Installed. Next steps:"
echo "  1. Edit /etc/hoodgate/facilitator.secret.env — set FACILITATOR_PRIVATE_KEY"
echo "  2. Edit /etc/hoodgate/facilitator.env — set CORS_ORIGINS, ALERT_WEBHOOK_URL, thresholds"
echo "  3. systemctl enable --now hoodgate-facilitator hoodgate-demo-api"
echo "  4. journalctl -u hoodgate-facilitator -f    # tail logs"
echo "  5. curl -s http://127.0.0.1:3001/health | jq"
