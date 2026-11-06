#!/usr/bin/env bash
# Remove the RigWatch services. The fan curve hands every card back to its
# firmware on stop. This directory, config.json and data/ are left in place.
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Please run with sudo: sudo $0" >&2; exit 1; }

UNITS=(rigwatch.service rigwatch-fan.service rigwatch-poweroff.path rigwatch-poweroff.service rigwatch-wol.service)
for unit in "${UNITS[@]}"; do
  systemctl disable --now "$unit" 2>/dev/null || true
  rm -f "/etc/systemd/system/$unit"
done
systemctl daemon-reload
echo "RigWatch services removed. Delete this directory to remove RigWatch completely."
