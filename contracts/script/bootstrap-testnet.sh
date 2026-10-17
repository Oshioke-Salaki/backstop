#!/usr/bin/env bash
# Deploy Backstop to Base Sepolia from one funded key.
#
#   1. reads keys from backstop/.secrets/base-sepolia.env (create them with `cast wallet new`)
#   2. tops up depositor, settler and registrar with gas from the deployer
#   3. deploys BackstopEscrow wired to those keys (deployer stays owner on testnet)
#   4. writes backstop/.secrets/base-sepolia.app.env, the full app config for your host
#
# Safe to re-run: it skips top-ups that are not needed and refuses to redeploy if a deployment exists.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
SECRETS="$ROOT/.secrets/base-sepolia.env"
OUT="$ROOT/.secrets/base-sepolia.app.env"
RPC="${RPC_URL:-https://sepolia.base.org}"
USDC="0x036CbD53842c5426634e7929541eC2318f3dCF7e" # Circle USDC on Base Sepolia
GAS_TOPUP="0.003ether"
MIN_GAS="0.001ether"
APP_URL="${APP_URL:-https://backstop.example}"

[[ -f "$SECRETS" ]] || { echo "missing $SECRETS"; exit 1; }
# shellcheck disable=SC1090
set -a; source "$SECRETS"; set +a

if [[ -f "$OUT" ]] && grep -q '^ESCROW_ADDRESS=0x' "$OUT"; then
  echo "Already deployed: $(grep '^ESCROW_ADDRESS=' "$OUT"). Delete $OUT to redeploy."
  exit 0
fi

[[ "$(cast chain-id --rpc-url "$RPC")" == "84532" ]] || { echo "RPC is not Base Sepolia"; exit 1; }

balance=$(cast balance "$DEPLOYER_ADDRESS" --rpc-url "$RPC")
need=$(cast to-wei 0.012)
echo "deployer $DEPLOYER_ADDRESS has $(cast from-wei "$balance") ETH"
if (( $(echo "$balance < $need" | bc) )); then
  echo "Fund the deployer with at least 0.012 Base Sepolia ETH first, then re-run."
  exit 2
fi

for role in DEPOSITOR SETTLER REGISTRAR; do
  addr_var="${role}_ADDRESS"; addr="${!addr_var}"
  bal=$(cast balance "$addr" --rpc-url "$RPC")
  if (( $(echo "$bal < $(cast to-wei ${MIN_GAS%ether})" | bc) )); then
    echo "topping up $role $addr"
    cast send "$addr" --value "$GAS_TOPUP" --private-key "$DEPLOYER_PRIVATE_KEY" --rpc-url "$RPC" >/dev/null
  fi
done

cd "$HERE/.."
echo "deploying BackstopEscrow…"
USDC="$USDC" OWNER="$DEPLOYER_ADDRESS" FEE_RECIPIENT="$DEPLOYER_ADDRESS" \
DEPOSITOR="$DEPOSITOR_ADDRESS" SETTLER="$SETTLER_ADDRESS" REGISTRAR="$REGISTRAR_ADDRESS" \
  forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast --private-key "$DEPLOYER_PRIVATE_KEY" --sender "$DEPLOYER_ADDRESS" --slow -q

ESCROW=$(python3 -c "import json;d=json.load(open('broadcast/Deploy.s.sol/84532/run-latest.json'));print(next(t['contractAddress'] for t in d['transactions'] if t['transactionType']=='CREATE'))")
ESCROW=$(cast to-check-sum-address "$ESCROW")
echo "escrow deployed at $ESCROW  https://sepolia.basescan.org/address/$ESCROW"

[[ "$(cast call "$ESCROW" 'isOperator(address)(bool)' "$DEPOSITOR_ADDRESS" --rpc-url "$RPC")" == "true" ]] || { echo "depositor not wired"; exit 1; }
[[ "$(cast call "$ESCROW" 'isOperator(address)(bool)' "$SETTLER_ADDRESS" --rpc-url "$RPC")" == "true" ]] || { echo "settler not wired"; exit 1; }

umask 077
cat > "$OUT" <<EOF
PUBLIC_BASE_URL=$APP_URL
NETWORK=base-sepolia
RPC_URL=$RPC
ESCROW_ADDRESS=$ESCROW
USDC_ADDRESS=$USDC
USDC_NAME=USDC
USDC_VERSION=2
DEPOSITOR_PRIVATE_KEY=$DEPOSITOR_PRIVATE_KEY
SETTLER_PRIVATE_KEY=$SETTLER_PRIVATE_KEY
RECEIPT_PRIVATE_KEY=$RECEIPT_PRIVATE_KEY
REGISTRAR_PRIVATE_KEY=$REGISTRAR_PRIVATE_KEY
SESSION_SECRET=$SESSION_SECRET
CAPABILITY_SECRET=$CAPABILITY_SECRET
DATA_KEY=$DATA_KEY
CRON_SECRET=$CRON_SECRET
ADMIN_ADDRESSES=$ARBITER_ADDRESS
ALLOW_PRIVATE_UPSTREAMS=false
WORKER_INLINE=false
EOF
echo "wrote $OUT (add DATABASE_URL, then load into your host)"
