#!/bin/bash
# Deploy HiveRelay to VPS servers
# Usage: ./scripts/deploy-vps.sh [utah|utah-us|singapore|all]
#
# Prerequisites:
#   - SSH key auth configured (ssh-copy-id -i ~/.ssh/cloudzy_hiverelay.pub root@<ip>)
#   - HIVERELAY_API_KEY env var set
#
# The script:
#   1. Pushes code to GitHub
#   2. SSHs into each server via key auth
#   3. Pulls latest code
#   4. Installs dependencies
#   5. Restarts the relay in public mode

set -e

SSH_KEY="${SSH_KEY:-$HOME/.ssh/cloudzy_hiverelay}"
API_KEY="${HIVERELAY_API_KEY:?Set HIVERELAY_API_KEY environment variable}"

# Server IPs — set via env vars or use defaults
UTAH_IP="${UTAH_IP:-144.172.101.215}"
UTAH_US_IP="${UTAH_US_IP:-144.172.91.26}"
SINGAPORE_IP="${SINGAPORE_IP:-104.194.153.179}"

deploy_server() {
    local IP=$1
    local NAME=$2

    echo "═══════════════════════════════════════════════════"
    echo "  Deploying to $NAME ($IP)"
    echo "═══════════════════════════════════════════════════"

    ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new root@"$IP" << REMOTE_SCRIPT
        set -e
        cd /root

        # Clone or pull
        if [ -d hiverelay ]; then
            cd hiverelay
            git fetch origin main
            git reset --hard origin/main
        else
            git clone https://github.com/bigdestiny2/P2P-Hiveswarm.git hiverelay
            cd hiverelay
        fi

        # Install/update dependencies
        npm install --production

        # Restart the relay process (using pm2 if available, otherwise direct)
        if command -v pm2 &> /dev/null; then
            pm2 stop hiverelay 2>/dev/null || true
            HIVERELAY_API_KEY="${API_KEY}" pm2 start cli/index.js --name hiverelay -- start --mode public
            pm2 save
        else
            # Kill existing process
            pkill -f "node.*cli/index.js" 2>/dev/null || true
            pkill -f "node.*start-relay" 2>/dev/null || true
            sleep 2

            # Start in background with API key
            HIVERELAY_API_KEY="${API_KEY}" nohup node cli/index.js start --mode public > /var/log/hiverelay.log 2>&1 &
            echo "Started with PID \\\$!"
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
        deploy_server "$UTAH_IP" "Utah"
        ;;
    utah-us)
        deploy_server "$UTAH_US_IP" "Utah-US (relay-us domain)"
        ;;
    singapore)
        deploy_server "$SINGAPORE_IP" "Singapore"
        ;;
    all)
        deploy_server "$UTAH_IP" "Utah"
        deploy_server "$UTAH_US_IP" "Utah-US (relay-us domain)"
        deploy_server "$SINGAPORE_IP" "Singapore"
        ;;
    *)
        echo "Usage: $0 [utah|utah-us|singapore|all]"
        exit 1
        ;;
esac

echo "═══════════════════════════════════════════════════"
echo "  All deployments complete"
echo "═══════════════════════════════════════════════════"
