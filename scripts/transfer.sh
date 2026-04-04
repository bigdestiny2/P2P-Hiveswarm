#!/bin/bash
# Transfer HiveRelay to another machine
#
# Option 1: Git remote (recommended)
#   gh repo create hiverelay --private --source=. --remote=origin --push
#   # Then on dev machine:
#   git clone git@github.com:YOUR_USER/hiverelay.git
#   cd hiverelay && bash scripts/setup-dev.sh
#
# Option 2: Tarball transfer
#   This script creates a tarball you can scp/airdrop to your dev machine.

set -e

OUTFILE="hiverelay-$(date +%Y%m%d).tar.gz"

echo "Creating transfer archive..."
cd "$(dirname "$0")/.."

# Create tarball excluding node_modules and storage
tar czf "$HOME/$OUTFILE" \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='storage' \
  --exclude='hiverelay-storage' \
  -C "$HOME" \
  hiverelay/

echo ""
echo "Archive created: ~/$OUTFILE"
echo ""
echo "Transfer options:"
echo ""
echo "  # SCP to remote machine"
echo "  scp ~/$OUTFILE user@devmachine:~/"
echo ""
echo "  # On the dev machine:"
echo "  tar xzf ~/$OUTFILE"
echo "  cd hiverelay"
echo "  bash scripts/setup-dev.sh"
echo ""
echo "  # Or use AirDrop/USB/cloud drive to move the file"
echo ""
