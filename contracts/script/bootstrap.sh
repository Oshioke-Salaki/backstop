#!/usr/bin/env bash
# Deploy Backstop from one funded key: `./script/bootstrap.sh` (Base Sepolia) or `NET=base ./script/bootstrap.sh`.
#
#   1. reads keys from backstop/.secrets/<network>.env (create them with `cast wallet new`)
#   2. tops up depositor, settler and registrar with gas from the deployer
#   3. deploys BackstopEscrow wired to those keys (deployer stays owner on testnet)
#   4. writes backstop/.secrets/<network>.app.env, the full app config for your host
#
# Safe to re-run: it skips top-ups that are not needed and refuses to redeploy if a deployment exists.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
NET="${NET:-base-sepolia}"
case "$NET" in
  base-sepolia)
    CHAIN_ID=84532; DEFAULT_RPC=https://sepolia.base.org
    USDC="0x036CbD53842c5426634e7929541eC2318f3dCF7e"; USDC_NAME="USDC" # Circle USDC on Base Sepolia
    NEED_ETH=0.012; GAS_TOPUP="0.003ether"; MIN_GAS="0.001ether" ;;
  base)
    CHAIN_ID=8453; DEFAULT_RPC=https://mainnet.base.org
    USDC="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; USDC_NAME="USD Coin" # Circle USDC on Base
    # Real money: sized from measured gas (deploy ~2.3M gas, ~250k per payment at ~0.006 gwei).
    NEED_ETH=0.0002; GAS_TOPUP="0.00008ether"; MIN_GAS="0.00002ether" ;;
  *) echo "NET must be base-sepolia or base"; exit 1 ;;
esac
SECRETS="$ROOT/.secrets/$NET.env"
OUT="$ROOT/.secrets/$NET.app.env"
RPC="${RPC_URL:-$DEFAULT_RPC}"
APP_URL="${APP_URL:-https://backstop.example}"

[[ -f "$SECRETS" ]] || { echo "missing $SECRETS"; exit 1; }
# shellcheck disable=SC1090
set -a; source "$SECRETS"; set +a

if [[ -f "$OUT" ]] && grep -q '^ESCROW_ADDRESS=0x' "$OUT"; then
  echo "Already deployed: $(grep '^ESCROW_ADDRESS=' "$OUT"). Delete $OUT to redeploy."
  exit 0
fi

[[ "$(cast chain-id --rpc-url "$RPC")" == "$CHAIN_ID" ]] || { echo "RPC is not chain $CHAIN_ID"; exit 1; }

balance=$(cast balance "$DEPLOYER_ADDRESS" --rpc-url "$RPC")
need=$(cast to-wei $NEED_ETH)
echo "deployer $DEPLOYER_ADDRESS has $(cast from-wei "$balance") ETH"
if (( $(echo "$balance < $need" | bc) )); then
  echo "Fund the deployer with at least $NEED_ETH ETH on $NET first, then re-run."
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
  forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast --private-key "$DEPLOYER_PRIVATE_KEY" --sender "$DEPLOYER_ADDRESS" --slow --non-interactive -q

ESCROW=$(python3 -c "import json;d=json.load(open('broadcast/Deploy.s.sol/$CHAIN_ID/run-latest.json'));print(next(t['contractAddress'] for t in d['transactions'] if t['transactionType']=='CREATE'))")
ESCROW=$(cast to-check-sum-address "$ESCROW")
echo "escrow deployed at $ESCROW (chain $CHAIN_ID)"

[[ "$(cast call "$ESCROW" 'isOperator(address)(bool)' "$DEPOSITOR_ADDRESS" --rpc-url "$RPC")" == "true" ]] || { echo "depositor not wired"; exit 1; }
[[ "$(cast call "$ESCROW" 'isOperator(address)(bool)' "$SETTLER_ADDRESS" --rpc-url "$RPC")" == "true" ]] || { echo "settler not wired"; exit 1; }

umask 077
cat > "$OUT" <<EOF
PUBLIC_BASE_URL=$APP_URL
NETWORK=$NET
RPC_URL=$RPC
ESCROW_ADDRESS=$ESCROW
USDC_ADDRESS=$USDC
USDC_NAME="$USDC_NAME"
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
