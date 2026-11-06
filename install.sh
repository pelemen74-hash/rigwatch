#!/usr/bin/env bash
# Install RigWatch as systemd services, running from this directory.
#
#   sudo ./install.sh                     dashboard only
#   sudo ./install.sh --fan-control       + GPU fan curve (amdgpu)
#   sudo ./install.sh --power-off         + "shut down" button in the dashboard
#   sudo ./install.sh --wol enp3s0        + keep Wake-on-LAN enabled on that NIC
#   sudo ./install.sh --port 8080         listen on another port
#
# Run it again with other options at any time; ./uninstall.sh removes everything.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNITS=/etc/systemd/system
FAN=0 POWER=0 WOL="" PORT=""

usage() { sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --fan-control) FAN=1 ;;
    --power-off) POWER=1 ;;
    --wol) WOL="${2:?--wol needs an interface name, see: ip link}"; shift ;;
    --port) PORT="${2:?--port needs a number}"; shift ;;
    -h|--help) usage ;;
    *) echo "Unknown option: $1" >&2; usage 1 ;;
  esac
  shift
done

[ "$(id -u)" -eq 0 ] || { echo "Please run with sudo: sudo $0 $*" >&2; exit 1; }
[ -d /run/systemd/system ] || { echo "RigWatch needs a Linux system with systemd." >&2; exit 1; }
PYTHON="$(command -v python3 || true)"
[ -n "$PYTHON" ] || { echo "python3 is required." >&2; exit 1; }
"$PYTHON" -c 'import sys; sys.exit(sys.version_info < (3, 8))' || { echo "Python 3.8 or newer is required." >&2; exit 1; }
for tool in lspci lsblk; do
  command -v "$tool" >/dev/null || echo "Note: '$tool' not found; install it for full details (pciutils / util-linux)."
done

# The dashboard runs as the owner of this directory, not as root
OWNER="${SUDO_USER:-$(stat -c %U "$DIR")}"
[ "$OWNER" != root ] || echo "Note: the dashboard will run as root; consider cloning into a normal user's home."
GROUP="$(id -gn "$OWNER")"

install -d -o "$OWNER" -g "$GROUP" "$DIR/data"
if [ ! -f "$DIR/config.json" ]; then
  install -m 600 -o "$OWNER" -g "$GROUP" "$DIR/config.example.json" "$DIR/config.json"
  echo "Created config.json from config.example.json"
fi

# Reflect the chosen options in config.json
"$PYTHON" - "$DIR/config.json" "$PORT" "$POWER" <<'EOF'
import json, sys
path, port, power = sys.argv[1], sys.argv[2], sys.argv[3] == "1"
config = json.load(open(path))
if port:
    config["port"] = int(port)
config.setdefault("power_off", {})["enabled"] = power
json.dump(config, open(path, "w"), indent=2)
EOF
PORT="$("$PYTHON" -c 'import json,sys; print(json.load(open(sys.argv[1])).get("port", 3000))' "$DIR/config.json")"

# Docker containers are listed when the user may talk to Docker
if command -v docker >/dev/null && ! id -nG "$OWNER" | grep -qw docker; then
  echo "Note: add $OWNER to the 'docker' group to see containers in the dashboard."
fi

cat > "$UNITS/rigwatch.service" <<EOF
[Unit]
Description=RigWatch hardware dashboard
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=$OWNER
Group=$GROUP
WorkingDirectory=$DIR
ExecStart=$PYTHON $DIR/server.py
Restart=always
RestartSec=3
Environment=PYTHONUNBUFFERED=1
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$DIR/data

[Install]
WantedBy=multi-user.target
EOF
ENABLE=(rigwatch.service)

if [ "$FAN" = 1 ]; then
  cat > "$UNITS/rigwatch-fan.service" <<EOF
[Unit]
Description=RigWatch GPU fan curve (all amdgpu cards)
After=multi-user.target

[Service]
Type=simple
ExecStart=$PYTHON $DIR/fancontrol.py
# Safety net if the process dies hard: hand all fans back to the GPU firmware
ExecStopPost=/bin/sh -c 'for f in /sys/class/hwmon/hwmon*/pwm1_enable; do grep -qx amdgpu "\$(dirname "\$f")/name" && echo 2 > "\$f"; done; true'
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  ENABLE+=(rigwatch-fan.service)
fi

if [ "$POWER" = 1 ]; then
  # The dashboard only drops a request file; this root unit does the shutdown
  cat > "$UNITS/rigwatch-poweroff.path" <<EOF
[Unit]
Description=Watch for RigWatch power-off requests

[Path]
PathExists=$DIR/data/poweroff.request
Unit=rigwatch-poweroff.service

[Install]
WantedBy=multi-user.target
EOF
  cat > "$UNITS/rigwatch-poweroff.service" <<EOF
[Unit]
Description=Power off the RigWatch host

[Service]
Type=oneshot
ExecStart=/usr/bin/rm -f $DIR/data/poweroff.request
ExecStart=/usr/bin/systemctl poweroff
EOF
  ENABLE+=(rigwatch-poweroff.path)
else
  systemctl disable --now rigwatch-poweroff.path 2>/dev/null || true
  rm -f "$UNITS/rigwatch-poweroff.path" "$UNITS/rigwatch-poweroff.service"
fi

if [ -n "$WOL" ]; then
  ETHTOOL="$(command -v ethtool || true)"
  [ -n "$ETHTOOL" ] || { echo "ethtool is required for --wol." >&2; exit 1; }
  cat > "$UNITS/rigwatch-wol.service" <<EOF
[Unit]
Description=Keep Wake-on-LAN (magic packet) enabled on $WOL
After=network.target

[Service]
Type=oneshot
ExecStart=$ETHTOOL -s $WOL wol g
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF
  ENABLE+=(rigwatch-wol.service)
fi

systemctl daemon-reload
systemctl enable "${ENABLE[@]}" >/dev/null
systemctl restart "${ENABLE[@]}"

echo
echo "RigWatch is running: http://$(hostname -I 2>/dev/null | awk '{print $1}'):$PORT"
echo "Services: ${ENABLE[*]}"
[ "$POWER" = 1 ] && echo "Shutdown button enabled. Set power_off.token in config.json to require a password."
if [ -n "$WOL" ]; then
  echo "Wake it from another machine with: python3 wake.py $(cat "/sys/class/net/$WOL/address" 2>/dev/null || echo '<mac>')"
fi
exit 0
