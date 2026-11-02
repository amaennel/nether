#!/bin/bash
# user_data for the boot-timing spike. measure.ts replaces __VARIANT__ with
# "apt" (Ubuntu's docker.io) or "getdocker" (get.docker.com) before sending.
# Every milestone is appended to timings.log as "<epoch> <uptime> <name>", and
# the whole directory is served on :8080 so the laptop can watch it.
set -u
D=/var/lib/nether-spike
mkdir -p "$D"
L="$D/timings.log"
m() { echo "$(date +%s.%N) $(cut -d' ' -f1 /proc/uptime) $1" >> "$L"; }

m userdata_start
setsid nohup python3 -m http.server 8080 --directory "$D" >/dev/null 2>&1 < /dev/null &
m http_started

ps -eo pid,etimes,cmd | grep -E 'apt|dpkg|unattended' | grep -v grep > "$D/apt-procs-at-start.txt"

export DEBIAN_FRONTEND=noninteractive
A="apt-get -o DPkg::Lock::Timeout=900 -q"
if [ "__VARIANT__" = "apt" ]; then
  m apt_update_start
  $A update > "$D/apt-update.log" 2>&1
  m apt_update_done
  $A install -y docker.io > "$D/docker-install.log" 2>&1
elif [ "__VARIANT__" = "getdocker" ]; then
  curl -fsSL https://get.docker.com | sh > "$D/docker-install.log" 2>&1
fi
# "baked": Docker and the image are already in the custom template.
until docker info > /dev/null 2>&1; do sleep 0.2; done
m docker_installed
docker version --format '{{.Server.Version}}' > "$D/docker-version.txt" 2>&1

if [ "__VARIANT__" != "baked" ]; then
  m pull_start
  docker pull itzg/minecraft-server > "$D/pull.log" 2>&1
  m image_pulled
fi
docker image inspect itzg/minecraft-server --format '{{.Size}}' > "$D/image-size.txt" 2>&1

# Heap = plan RAM - 1.5 GiB (Size tiers and region model): 4 GiB plan -> 2560M.
docker run -d --name mc -p 25565:25565 -e EULA=TRUE -e TYPE=VANILLA -e MEMORY=2560M \
  -v /srv/mc:/data itzg/minecraft-server > "$D/run.log" 2>&1
m container_started

# Fresh-world start, then a warm restart (image present, world exists): the
# case of a Parked Node reused by the same Game Server.
setsid bash -c "
  m() { echo \"\$(date +%s.%N) \$(cut -d' ' -f1 /proc/uptime) \$1\" >> '$L'; }
  until docker logs mc 2>&1 | grep -q 'Done ('; do sleep 0.5; done
  m mc_done
  sleep 30
  m warm_stop_start
  docker stop mc > /dev/null
  m warm_stopped
  docker start mc > /dev/null
  until [ \"\$(docker logs mc 2>&1 | grep -c 'Done (')\" -ge 2 ]; do sleep 0.5; done
  m warm_done
  df -h / > '$D/df.txt'
  du -sh /srv/mc > '$D/mc-dir-size.txt'
  docker logs mc > '$D/mc.log' 2>&1
  m mc_artifacts_done
" > /dev/null 2>&1 < /dev/null &

setsid bash -c "
  m() { echo \"\$(date +%s.%N) \$(cut -d' ' -f1 /proc/uptime) \$1\" >> '$L'; }
  cloud-init status --wait > /dev/null 2>&1
  m cloud_init_done
  cloud-init analyze show > '$D/cloud-init-analyze.txt' 2>&1
  cloud-init analyze blame > '$D/cloud-init-blame.txt' 2>&1
  systemd-analyze > '$D/systemd-analyze.txt' 2>&1
  systemd-analyze blame 2>&1 | head -40 > '$D/systemd-blame.txt'
  cp /var/log/cloud-init-output.log '$D/cloud-init-output.log' 2>/dev/null
  chmod -R a+r '$D'
  m ci_artifacts_done
" > /dev/null 2>&1 < /dev/null &

m userdata_end
