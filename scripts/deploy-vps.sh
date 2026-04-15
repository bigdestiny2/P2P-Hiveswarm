#!/bin/bash
# Deploy HiveRelay to VPS servers
# Usage: ./scripts/deploy-vps.sh [utah|utah-us|singapore|all]
#
# Creates a systemd service with auto-restart, memory limits, and proper region tagging.
# Kills any old processes from /opt/hiverelay or nohup before enabling the systemd service.

set -e

SSH_KEY="${SSH_KEY:-$HOME/.ssh/cloudzy_hiverelay}"
API_KEY="${HIVERELAY_API_KEY:?Set HIVERELAY_API_KEY environment variable}"

# Server IPs
UTAH_IP="${UTAH_IP:-144.172.101.215}"
UTAH_US_IP="${UTAH_US_IP:-144.172.91.26}"
SINGAPORE_IP="${SINGAPORE_IP:-104.194.153.179}"

deploy_server() {
    local IP=$1
    local NAME=$2
    local REGION=$3
    local MAX_MEM=$4  # systemd MemoryMax (e.g., 384M, 1G)
    local HEAP=$5     # Node --max-old-space-size in MB

    echo "═══════════════════════════════════════════════════"
    echo "  Deploying to $NAME ($IP) [region=$REGION, mem=$MAX_MEM, heap=${HEAP}M]"
    echo "═══════════════════════════════════════════════════"

    ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new root@"$IP" << REMOTE_SCRIPT
        set -e
        cd /root

        # ─── 1. Pull latest code ───
        if [ -d hiverelay ]; then
            cd hiverelay
            git fetch origin main
            git reset --hard origin/main
        else
            git clone https://github.com/bigdestiny2/P2P-Hiveswarm.git hiverelay
            cd hiverelay
        fi

        npm install --production 2>&1 | tail -3

        # ─── 2. Kill ALL old relay processes (nohup, /opt instances, old systemd) ───
        systemctl stop hiverelay hiverelay-2 hiverelay-3 2>/dev/null || true
        systemctl disable hiverelay-2 hiverelay-3 2>/dev/null || true
        pkill -9 -f "node.*cli/index.js" 2>/dev/null || true
        pkill -9 -f "node.*/opt/hiverelay" 2>/dev/null || true
        sleep 2

        # ─── 2b. Create swap if < 1GB RAM and no swap exists ───
        TOTAL_RAM_MB=\$(free -m | awk '/Mem:/{print \$2}')
        SWAP_EXISTS=\$(swapon --show --noheadings | wc -l)
        if [ "\$TOTAL_RAM_MB" -lt 1024 ] && [ "\$SWAP_EXISTS" -eq 0 ]; then
            echo "  Low RAM (\${TOTAL_RAM_MB}MB) — creating 512MB swap..."
            fallocate -l 512M /swapfile
            chmod 600 /swapfile
            mkswap /swapfile
            swapon /swapfile
            echo '/swapfile none swap sw 0 0' >> /etc/fstab
            echo "  ✓ Swap enabled"
        fi

        # ─── 3. Clear stale lock files ───
        find /root/.hiverelay -name "*.lock" -delete 2>/dev/null || true

        # ─── 4. Create systemd service ───
        cat > /etc/systemd/system/hiverelay.service << 'SYSTEMD_UNIT'
[Unit]
Description=HiveRelay P2P Relay Node
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/root/hiverelay
ExecStart=/usr/bin/node --max-old-space-size=HEAP_PLACEHOLDER cli/index.js start --mode public --region REGION_PLACEHOLDER
Restart=always
RestartSec=15
KillSignal=SIGTERM
TimeoutStopSec=10
Environment=HIVERELAY_API_KEY=API_KEY_PLACEHOLDER
Environment=NODE_ENV=production
MemoryMax=MEM_PLACEHOLDER
MemoryHigh=MEMHIGH_PLACEHOLDER
StandardOutput=append:/var/log/hiverelay.log
StandardError=append:/var/log/hiverelay.log

# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/root/hiverelay /root/.hiverelay /var/log/hiverelay.log /tmp

[Install]
WantedBy=multi-user.target
SYSTEMD_UNIT

        # Replace placeholders
        sed -i "s/HEAP_PLACEHOLDER/${HEAP}/" /etc/systemd/system/hiverelay.service
        sed -i "s/REGION_PLACEHOLDER/${REGION}/" /etc/systemd/system/hiverelay.service
        sed -i "s/API_KEY_PLACEHOLDER/${API_KEY}/" /etc/systemd/system/hiverelay.service
        sed -i "s/MEM_PLACEHOLDER/${MAX_MEM}/" /etc/systemd/system/hiverelay.service
        sed -i "s/MEMHIGH_PLACEHOLDER/${MAX_MEM%M}/" /etc/systemd/system/hiverelay.service

        # Calculate MemoryHigh as 80% of MemoryMax
        MEM_NUM=\$(echo "${MAX_MEM}" | grep -oP '[0-9]+')
        MEM_HIGH=\$(( MEM_NUM * 80 / 100 ))
        sed -i "s|MemoryHigh=.*|MemoryHigh=\${MEM_HIGH}M|" /etc/systemd/system/hiverelay.service

        # ─── 5. Enable and start ───
        systemctl daemon-reload
        systemctl enable hiverelay
        systemctl restart hiverelay
        sleep 3

        # ─── 6. Verify ───
        if systemctl is-active hiverelay > /dev/null 2>&1; then
            echo "  ✓ hiverelay.service is ACTIVE"
        else
            echo "  ✗ hiverelay.service FAILED — checking logs:"
            journalctl -u hiverelay --no-pager -n 10
        fi

        echo "Deployment complete on \\\$(hostname)"
REMOTE_SCRIPT

    echo "  Done: $NAME"
    echo
}

TARGET=${1:-all}

# Push to GitHub first
echo "Pushing to GitHub..."
git push origin main 2>/dev/null || echo "Push failed — deploy from local commit"
echo

case $TARGET in
    utah)
        deploy_server "$UTAH_IP" "Utah" "NA" "384M" 256
        ;;
    utah-us)
        deploy_server "$UTAH_US_IP" "Utah-US" "NA" "1G" 512
        ;;
    singapore)
        deploy_server "$SINGAPORE_IP" "Singapore" "AS" "512M" 384
        ;;
    all)
        deploy_server "$UTAH_IP" "Utah" "NA" "384M" 256
        deploy_server "$UTAH_US_IP" "Utah-US" "NA" "1G" 512
        deploy_server "$SINGAPORE_IP" "Singapore" "AS" "512M" 384
        ;;
    *)
        echo "Usage: $0 [utah|utah-us|singapore|all]"
        exit 1
        ;;
esac

echo "═══════════════════════════════════════════════════"
echo "  All deployments complete"
echo "═══════════════════════════════════════════════════"
