#!/bin/bash
set -e
################################################################################
#                                                                              #
#   AWSops Dashboard - Step 13: Steampipe systemd unit                        #
#                                                                              #
#   Registers Steampipe as a systemd service so it survives manual stops,     #
#   crashes, and reboots (Restart=always). Without this, Steampipe is only    #
#   started manually — if anything stops it, the dashboard silently loses     #
#   all data (ECONNREFUSED on :9193). See known incident 2026-07-08.          #
#                                                                              #
#   Creates (idempotent, safe to re-run):                                     #
#     - /etc/default/steampipe                       (db password, root 600)  #
#     - /etc/systemd/system/steampipe.service        (Type=forking unit)      #
#     - /etc/systemd/system/awsops.service.d/10-steampipe.conf (ordering)     #
#     - /etc/sudoers.d/awsops-steampipe              (watchdog restart grant) #
#                                                                              #
#   After this, manage Steampipe ONLY via systemctl:                          #
#     sudo systemctl {start|stop|restart|status} steampipe                    #
#   (a bare `steampipe service stop` will be undone by Restart=always)        #
#                                                                              #
################################################################################

GREEN='\033[0;32m'; RED='\033[0;31m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; NC='\033[0m'
WORK_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG_JSON="$WORK_DIR/data/config.json"
SERVICE_USER="${SERVICE_USER:-ec2-user}"
STEAMPIPE_BIN="$(command -v steampipe || echo /usr/local/bin/steampipe)"

echo ""
echo -e "${CYAN}=================================================================${NC}"
echo -e "${CYAN}   Step 13: Register Steampipe as a systemd service${NC}"
echo -e "${CYAN}=================================================================${NC}"
echo ""

if [ "$(id -u)" -ne 0 ]; then
    echo -e "${RED}This script must run as root (sudo bash scripts/13-setup-steampipe-systemd.sh)${NC}"
    exit 1
fi

# -- [1/5] Database password ----------------------------------------------------
# Source of truth is data/config.json (the app reads steampipePassword from it).
echo -e "${CYAN}[1/5] Resolving database password...${NC}"
SP_PW=$(python3 -c "import json; print(json.load(open('$CONFIG_JSON')).get('steampipePassword',''))" 2>/dev/null || echo "")
if [ -z "$SP_PW" ]; then
    SP_PW=$(sudo -iu "$SERVICE_USER" "$STEAMPIPE_BIN" service status --show-password 2>/dev/null | grep -i password | awk '{print $2}' || echo "")
fi
if [ -z "$SP_PW" ]; then
    echo -e "  ${RED}No steampipePassword in $CONFIG_JSON and no running service to read it from.${NC}"
    echo -e "  ${RED}Add \"steampipePassword\" to data/config.json first.${NC}"
    exit 1
fi
install -m 600 -o root -g root /dev/null /etc/default/steampipe
echo "STEAMPIPE_DATABASE_PASSWORD=$SP_PW" > /etc/default/steampipe
echo -e "  ${GREEN}Written to /etc/default/steampipe (root, 600)${NC}"

# -- [2/5] steampipe.service -----------------------------------------------------
echo -e "${CYAN}[2/5] Installing steampipe.service...${NC}"
cat > /etc/systemd/system/steampipe.service <<EOF
[Unit]
Description=Steampipe embedded PostgreSQL service (port 9193)
Documentation=https://steampipe.io/docs
After=network-online.target
Wants=network-online.target

[Service]
Type=forking
User=$SERVICE_USER
Group=$SERVICE_USER
Environment=HOME=/home/$SERVICE_USER
Environment=STEAMPIPE_UPDATE_CHECK=false
EnvironmentFile=/etc/default/steampipe
WorkingDirectory=/home/$SERVICE_USER
ExecStart=$STEAMPIPE_BIN service start --database-listen network --database-port 9193 --database-password \${STEAMPIPE_DATABASE_PASSWORD}
ExecStop=$STEAMPIPE_BIN service stop --force
Restart=always
RestartSec=10
TimeoutStartSec=180
TimeoutStopSec=60

[Install]
WantedBy=multi-user.target
EOF
echo -e "  ${GREEN}Installed /etc/systemd/system/steampipe.service${NC}"

# -- [3/5] awsops.service ordering ----------------------------------------------
echo -e "${CYAN}[3/5] Ordering awsops.service after steampipe...${NC}"
if [ -f /etc/systemd/system/awsops.service ]; then
    mkdir -p /etc/systemd/system/awsops.service.d
    cat > /etc/systemd/system/awsops.service.d/10-steampipe.conf <<EOF
[Unit]
Wants=steampipe.service
After=steampipe.service

[Service]
# Start the health monitor right after boot, without waiting for a dashboard visit
ExecStartPost=/bin/sh -c 'for i in 1 2 3 4 5 6; do sleep 5; curl -sf -o /dev/null http://localhost:3000/api/health && exit 0; done; exit 0'
EOF
    echo -e "  ${GREEN}Drop-in installed (awsops starts after steampipe on boot)${NC}"
else
    echo -e "  ${YELLOW}awsops.service not found — skipping ordering drop-in${NC}"
fi

# -- [4/5] Sudoers grant for the in-app watchdog ---------------------------------
# steampipe.ts watchdog restarts Steampipe when FDW hangs pile up; under systemd
# it must go through systemctl so processes stay in the unit's cgroup.
echo -e "${CYAN}[4/5] Installing sudoers grant for watchdog...${NC}"
cat > /etc/sudoers.d/awsops-steampipe <<EOF
$SERVICE_USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart steampipe.service
EOF
chmod 440 /etc/sudoers.d/awsops-steampipe
visudo -c -f /etc/sudoers.d/awsops-steampipe >/dev/null
echo -e "  ${GREEN}ec2-user may now: sudo systemctl restart steampipe.service${NC}"

# -- [5/5] Adopt / start ----------------------------------------------------------
echo -e "${CYAN}[5/5] Enabling and starting the unit...${NC}"
systemctl daemon-reload
# Stop any CLI-started instance so systemd owns the processes (its cgroup).
if sudo -iu "$SERVICE_USER" "$STEAMPIPE_BIN" service status 2>/dev/null | grep -qi running; then
    echo -e "  ${YELLOW}Stopping CLI-started Steampipe to adopt it into systemd...${NC}"
    sudo -iu "$SERVICE_USER" "$STEAMPIPE_BIN" service stop --force || true
    sleep 2
fi
systemctl enable --now steampipe.service
sleep 3

if ss -ltn | grep -q 9193; then
    echo -e "  ${GREEN}OK${NC}  steampipe.service active, port 9193 listening"
else
    echo -e "  ${RED}FAIL${NC}  port 9193 not listening — check: journalctl -u steampipe -n 50"
    exit 1
fi

echo ""
echo -e "${CYAN}=================================================================${NC}"
echo -e "  Done. Manage Steampipe via systemctl from now on:"
echo -e "    sudo systemctl status steampipe"
echo -e "    sudo systemctl restart steampipe"
echo -e "  NOTE: 'steampipe service stop' from the CLI will be auto-undone"
echo -e "        by Restart=always. Use 'sudo systemctl stop steampipe'."
echo -e "${CYAN}=================================================================${NC}"
echo ""
