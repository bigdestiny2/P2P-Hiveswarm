#!/bin/bash
# Deploy HiveRelay to VPS servers
# Usage: ./scripts/deploy-vps.sh [utah|singapore|all]
#
# Prerequisites:
#   - SSH access to the servers
#   - sshpass installed (or SSH key auth configured)
#
# The script:
#   1. Pushes code to GitHub
#   2. SSHs into each server
#   3. Pulls latest code
#   4. Installs dependencies
#   5. Restarts the relay in public mode

set -e

UTAH_IP="REDACTED_SERVER_IP"
UTAH_PASS="REDACTED_PASSWORD"
SINGAPORE_IP="REDACTED_SERVER_IP"
SINGAPORE_PASS="REDACTED_PASSWORD"

REPO_DIR="/root/hiverelay"
REPO_URL="https://github.com/bigdestiny2/P2P-Hiveswarm.git"

deploy_server() {
    local IP=$1
    local PASS=$2
    local NAME=$3

    echo "═══════════════════════════════════════════════════"
    echo "  Deploying to $NAME ($IP)"
    echo "═══════════════════════════════════════════════════"

    sshpass -p "$PASS" ssh -o StrictHostKeyChecking=no root@$IP << 'REMOTE_SCRIPT'
        set -e
        cd /root

        # Clone or pull
        if [ -d hiverelay ]; then
            cd hiverelay
            git pull origin main
        else
            git clone https://github.com/bigdestiny2/P2P-Hiveswarm.git hiverelay
            cd hiverelay
        fi

        # Install/update dependencies
        npm install --production

        # Restart the relay process (using pm2 if available, otherwise direct)
        if command -v pm2 &> /dev/null; then
            pm2 stop hiverelay 2>/dev/null || true
            pm2 start cli/index.js --name hiverelay -- start --mode public
            pm2 save
        else
            # Kill existing process
            pkill -f "node.*cli/index.js" 2>/dev/null || true
            pkill -f "node.*start-relay" 2>/dev/null || true
            sleep 2

            # Start in background
            nohup node cli/index.js start --mode public > /var/log/hiverelay.log 2>&1 &
            echo "Started with PID $!"
        fi

        echo "Deployment complete on $(hostname)"
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
        deploy_server $UTAH_IP "$UTAH_PASS" "Utah"
        ;;
    singapore)
        deploy_server $SINGAPORE_IP "$SINGAPORE_PASS" "Singapore"
        ;;
    all)
        deploy_server $UTAH_IP "$UTAH_PASS" "Utah"
        deploy_server $SINGAPORE_IP "$SINGAPORE_PASS" "Singapore"
        ;;
    *)
        echo "Usage: $0 [utah|singapore|all]"
        exit 1
        ;;
esac

echo "═══════════════════════════════════════════════════"
echo "  All deployments complete"
echo "═══════════════════════════════════════════════════"
