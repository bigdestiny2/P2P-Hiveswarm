#!/bin/bash
# HiveRelay Development Setup Script
# Run this on your main dev machine after cloning/transferring the repo.

set -e

echo "=== HiveRelay Development Setup ==="
echo ""

# Check Node.js version
NODE_VERSION=$(node --version 2>/dev/null || echo "none")
if [[ "$NODE_VERSION" == "none" ]]; then
  echo "ERROR: Node.js not found. Install Node.js >= 20.0.0"
  echo "  brew install node  (macOS)"
  echo "  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install nodejs  (Linux)"
  exit 1
fi

MAJOR_VERSION=$(echo "$NODE_VERSION" | cut -d. -f1 | tr -d 'v')
if [[ "$MAJOR_VERSION" -lt 20 ]]; then
  echo "ERROR: Node.js $NODE_VERSION detected. Requires >= 20.0.0"
  exit 1
fi
echo "Node.js $NODE_VERSION OK"

# Install dependencies
echo ""
echo "Installing dependencies..."
npm install

# Run linter
echo ""
echo "Running linter..."
npm run lint || echo "Lint issues found — run 'npm run lint:fix' to auto-fix"

# Run tests
echo ""
echo "Running tests..."
npm test || echo "Some tests failed — check output above"

# Summary
echo ""
echo "=== Setup Complete ==="
echo ""
echo "Quick start:"
echo "  npx hiverelay start                  # Run a relay node"
echo "  npx hiverelay start --region NA      # Run in North America region"
echo "  npx hiverelay seed <pear-key>        # Seed a Pear app"
echo ""
echo "Development:"
echo "  npm test                             # Run tests"
echo "  npm run lint                         # Check code style"
echo "  npm run lint:fix                     # Auto-fix code style"
echo ""
echo "Documentation:"
echo "  docs/PROTOCOL-SPEC.md               # Protocol specification"
echo "  docs/ECONOMICS.md                   # Economics paper"
echo ""
