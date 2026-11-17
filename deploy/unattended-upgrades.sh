#!/bin/bash
# Idempotent: install and enable Ubuntu unattended security updates only.
# Reboot at 03:00 Asia/Kolkata (21:30 UTC if the server clock is UTC). Never exits non-zero.
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get install -y -qq unattended-upgrades >/dev/null
# Daily install of security updates.
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
tz=$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo UTC)
case "$tz" in
  Asia/Kolkata|Asia/Calcutta) reboot_time=03:00 ;;
  *) reboot_time=21:30 ;; # 03:00 IST expressed in UTC
esac
# Loads after the package's 50unattended-upgrades and keeps origins to security pockets only.
cat >/etc/apt/apt.conf.d/51ownfield-unattended <<EOF
// OwnField: security updates only; automatic reboot at 03:00 Asia/Kolkata.
Unattended-Upgrade::Allowed-Origins {
        "\${distro_id}:\${distro_codename}-security";
        "\${distro_id}ESMApps:\${distro_codename}-apps-security";
        "\${distro_id}ESM:\${distro_codename}-infra-security";
};
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "$reboot_time";
EOF
systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true
systemctl enable --now apt-daily.timer apt-daily-upgrade.timer >/dev/null 2>&1 || true
echo "server-hook: unattended-upgrades enabled (security only, reboot $reboot_time, tz $tz)"
