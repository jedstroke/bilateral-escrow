<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/weselling-wordmark-on-dark.png">
  <img src="assets/weselling-wordmark-on-light.png" alt="WeSelling" width="220">
</picture>

# Deploying to Sepolia and mainnet

> This contract has not been audited. It is tested, not proven. Treat a mainnet deployment as a pilot with limits you can afford to lose, and read [the security notes](escrow.md#security-notes) before you decide.

One script does the whole thing — [tests/scripts/deploy.ts](../tests/scripts/deploy.ts). It declares the class, deploys an instance, allow-lists your tokens, and writes a record to `deployments/<network>.json`. On any network other than devnet it prints the plan and **stops**, until you pass `CONFIRM=yes`.

## What you need first

**An RPC endpoint.** Any provider with a `starknet_` JSON-RPC endpoint at spec 0.10.x works — Alchemy, Infura, dRPC, Chainstack, Blast, or your own Pathfinder/Juno node. The URL usually ends in a version segment, e.g. `.../rpc/v0_10`. The script asks the node which spec it speaks, so you don't have to configure that.

**A funded account.** Starknet 0.14 onward only accepts V3 transactions, and **V3 fees are paid in STRK, not ETH**. An account holding only ETH cannot deploy anything. Get STRK into the deployer before you start.

**Your token addresses.** The escrow accepts any ERC20 the admin allows. Get the canonical address from the issuer, not from a search result or a random explorer listing — Circle publishes Starknet USDC addresses at [developers.circle.com](https://developers.circle.com/stablecoins/usdc-contract-addresses), and note that native USDC and bridged USDC.e are different contracts. The script calls `symbol()` and `decimals()` on every address you pass and refuses to continue if one isn't a real ERC20, which catches a typo but not a wrong-but-real token. Read the printed symbols before you confirm.

ETH and STRK sit at the same addresses on mainnet and Sepolia:

| | Address |
|---|---|
| ETH | `0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7` |
| STRK | `0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d` |

## Four decisions

These are baked into the deployment. Fees and windows can be changed later, but only for *new* deals — every existing deal keeps the terms it was created under.

| Setting | Env var | Default | What it means |
|---|---|---|---|
| Protection fee | `PROTECTION_BPS` | 500 | 5% on top of the price, paid by the customer |
| Treasury cut | `PROTOCOL_CUT_BPS` | 2000 | 20% of that fee to the treasury, 80% to the merchant |
| Accept window | `ACCEPT_DAYS` | 2 | merchant must accept within this |
| Ship window | `SHIP_DAYS` | 3 | then ship within this |
| Decision window | `DECISION_DAYS` | 7 | customer accepts or rejects within this |
| Return window | `RETURN_DAYS` | 7 | rejected goods must be sent back within this |
| Confirm window | `CONFIRM_DAYS` | 3 | merchant confirms the return within this |

The treasury address is separate from the admin and is set with `TREASURY`. Point it at an address you control but don't deploy from.

## Sepolia

Build first so the artifacts are current, then do a dry run.

bash / zsh:

```sh
npm run build

export RPC_URL="https://your-provider/starknet/sepolia/rpc/v0_10"
export ACCOUNT_ADDRESS="0x..."
export PRIVATE_KEY="0x..."
export TREASURY="0x..."
export TOKENS="0x...,0x..."

npm run deploy:local
```

PowerShell:

```powershell
npm run build

$env:RPC_URL         = "https://your-provider/starknet/sepolia/rpc/v0_10"
$env:ACCOUNT_ADDRESS = "0x..."
$env:PRIVATE_KEY     = "0x..."
$env:TREASURY        = "0x..."
$env:TOKENS          = "0x...,0x..."

npm run deploy:local
```

You get the plan and nothing else:

```
  network     sepolia  (0x534e5f5345504f4c4941)
  admin       0x64b488...
  treasury    0x4f3483...
  class hash  0x755aef20d493b8e24f4c60e5705aba88a621f459abd6cd76c9465d7898a6682

  protection fee   5% of the price
  treasury cut     20% of that fee
  windows          accept 2d, ship 3d, decide 7d, return 7d, confirm 3d

  tokens
    0x049d36...  (ETH, 18 decimals)

  Nothing sent. Re-run with CONFIRM=yes to deploy.
```

Check every line, especially the token symbols and the treasury. Then:

```sh
CONFIRM=yes npm run deploy:local              # bash / zsh
```

```powershell
$env:CONFIRM = "yes"; npm run deploy:local    # PowerShell
```

Use `deploy:local` (your own Node) rather than `deploy` for real networks — the Docker variant would need the same secrets passed into the container, and there is no reason to put a mainnet key there.

## Mainnet

Identical, with `RPC_URL` pointing at mainnet. The script labels it `mainnet` and writes `deployments/mainnet.json`. Two differences worth planning for:

**Declaring costs real money; deploying is cheap.** The class is ~800 KB of Sierra and the declare transaction is by far the largest cost. It only happens once per class, ever — `declareIfNot` underneath means a second deployment of the same bytecode skips it. If you are going to deploy several escrow instances, the first one carries the cost.

**Do it from a key you are prepared to rotate away from immediately.** See below.

## Straight after deploying

The deploying key is the admin. It can pause the contract and resolve disputes, so leaving it on a laptop is the weakest link in the whole system. Hand it over:

```
transfer_ownership(<multisig address>)     # from the deployer
accept_ownership()                          # from the multisig
```

Ownership is two-step on purpose: until the new owner calls `accept_ownership`, the old key is still in charge, so a typo in the address cannot lock you out.

Then sanity-check the live contract:

```sh
npm run shell
sncast call --url $RPC_URL --contract-address 0xYourEscrow --function owner
sncast call --url $RPC_URL --contract-address 0xYourEscrow --function get_treasury
sncast call --url $RPC_URL --contract-address 0xYourEscrow --function is_token_allowed --arguments '0xYourToken'
```

Commit `deployments/mainnet.json`. It is the only record of which class hash and which settings are live. (`deployments/devnet.json` is gitignored; the real ones are not.)

## There is no upgrade path

This contract is deliberately not upgradeable — no proxy, no `replace_class`. An admin cannot change the code under an open deal, which is the point, but it also means a bug is permanent for deals already in flight.

Changing anything about the logic means deploying a new instance. The old one keeps running: existing deals settle under the old rules, everyone withdraws what they are owed, and you point new deals at the new address. To drain the old one, `pause()` stops new deals and new acceptances while leaving every open deal and every `withdraw` working.

That is a real constraint. If you would rather be able to patch, add OpenZeppelin's `UpgradeableComponent` before you deploy — it is about five lines — and accept that the admin can then change the rules mid-deal.

## Running it day to day

| You want to | Call | Who |
|---|---|---|
| accept a new token | `set_token_allowed(token, true)` | admin |
| stop taking new deals | `pause()` | admin |
| resume | `unpause()` | admin |
| change fees or windows for future deals | `set_fees` / `set_windows` | admin |
| move the fee destination | `set_treasury(addr)` | admin |
| settle a frozen deal | `resolve_dispute(id, customer_price_bps, customer_bond_bps)` | admin |
| close out an abandoned deal | `claim_timeout(id)` | anyone |

`claim_timeout` being open to anyone is what keeps the system running without you. Worth pointing a small bot at it: watch for deals whose `deadline` has passed and call it, so neither party is stuck waiting on the other. Every settlement emits one `DealSettled` event with the outcome and the exact amounts — that is the event to index.

Pausing does **not** freeze money. Withdrawals, disputes and timeouts keep working while paused, by design; a pause that trapped funds would be worse than the bug it was reacting to.
