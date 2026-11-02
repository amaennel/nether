#!/bin/bash
# user_data for the template builder Node (measure.ts --custom-image). Installs
# everything a Node needs, turns off boot-time work Nodes don't need, adds a
# marker unit that shows how early a baked Runtime unit could start, resets
# cloud-init so clones run their own user_data, then powers off.
# Progress goes to bake.log, served on :8080.
set -eux
B=/var/lib/nether-bake
mkdir -p "$B"
m() { echo "$(date +%s.%N) $(cut -d' ' -f1 /proc/uptime) $1" >> "$B/bake.log"; }
m bake_start
setsid nohup python3 -m http.server 8080 --directory "$B" >/dev/null 2>&1 < /dev/null &

export DEBIAN_FRONTEND=noninteractive
A="apt-get -o DPkg::Lock::Timeout=900 -q"
$A update > "$B/apt.log" 2>&1
$A install -y docker.io >> "$B/apt.log" 2>&1
systemctl enable docker.service containerd.service
m docker_installed

docker pull itzg/minecraft-server > "$B/pull.log" 2>&1
m image_pulled

# Nodes live for hours and are never upgraded in place: drop boot-time apt and
# snap work.
systemctl disable --now unattended-upgrades.service apt-daily.timer apt-daily-upgrade.timer || true
systemctl disable --now snapd.service snapd.socket snapd.seeded.service || true
systemctl mask apport.service || true
m services_trimmed

# Marker unit: when could a baked Runtime unit start, see the metadata service
# (where user_data and the bootstrap token live) and talk to Docker, without
# waiting for cloud-init's final stage?
cat > /usr/local/bin/nether-early-mark <<'EOF'
#!/bin/bash
D=/var/lib/nether-spike
mkdir -p "$D"
m() { echo "$(date +%s.%N) $(cut -d' ' -f1 /proc/uptime) $1" >> "$D/timings.log"; }
m early_unit_start
until curl -sf -o /dev/null http://169.254.169.254/metadata/v1.json; do sleep 0.2; done
m early_metadata_ok
until docker info > /dev/null 2>&1; do sleep 0.2; done
m early_docker_ready
EOF
chmod +x /usr/local/bin/nether-early-mark
cat > /etc/systemd/system/nether-early-mark.service <<'EOF'
[Unit]
Description=Nether spike: early-boot marker
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/nether-early-mark

[Install]
WantedBy=multi-user.target
EOF
systemctl enable nether-early-mark.service
m early_unit_installed

$A clean
m bake_done
sleep 10 # let the laptop read bake_done

cloud-init clean --logs --machine-id
rm -rf /var/lib/nether-spike "$B"
poweroff
