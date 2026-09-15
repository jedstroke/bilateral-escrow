<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/weselling-wordmark-on-dark.png">
  <img src="assets/weselling-wordmark-on-light.png" alt="WeSelling" width="220">
</picture>

# Working with the local devnet

Devnet is a throwaway Starknet that runs in Docker. It is not a testnet you share with anyone — it lives and dies with the container on your machine.

It starts with `--seed=0`, so the same five accounts with the same private keys appear every single time. You can hardcode them, write them down, whatever. They are worthless.

See [deploy.md](deploy.md) for Sepolia and mainnet.

```sh
npm run up          # start it
npm run accounts    # who's on it, with keys and balances
npm run status      # chain id, block count
npm run down        # stop it and wipe everything
```

## Seeing what is happening

Three different things, don't confuse them:

**Your test output** goes to the terminal you ran `npm test` in. Normal vitest output — every test name, pass or fail, and the assertion diff when something breaks. You do not need to go into a Docker shell to see it.

```
✓ src/escrow.test.ts > happy path > customer accepts, merchant is paid...  3862ms
✓ src/escrow.test.ts > returns > merchant ignores the returned goods...    5459ms
Tests  24 passed (24)
```

**The chain's own log** is separate: `npm run logs` follows it. This is where you see the startup banner (accounts, token addresses) and every RPC call as it arrives. Useful when a test fails and you want to know whether the transaction even reached the node. Ctrl+C stops following; it does not stop devnet.

**The web explorer** is at http://127.0.0.1:5050/ui (`npm run ui` opens it). Blocks, transactions with their receipts and traces, account balances, and a control panel for minting and time travel. This is the closest thing to a block explorer for your local chain, and it is the easiest way to see what a failing transaction actually did.

## The accounts

`npm run accounts` prints them. The tests use the first five by position:

| # | Role in the tests |
|---|---|
| 0 | admin — owns the escrow, resolves disputes |
| 1 | customer |
| 2 | merchant |
| 3 | treasury — receives the protocol cut |
| 4 | stranger — used to prove that outsiders are rejected |

Nothing forces that mapping; it is just `conn.accounts[0]`, `[1]`, … in [tests/src/escrow.test.ts](../tests/src/escrow.test.ts). The tests fetch them at runtime through devnet's `devnet_getPredeployedAccounts` method, so no addresses are hardcoded anywhere.

Want more accounts, or richer ones? Change `--accounts` or `--initial-balance` in [docker-compose.yml](../docker-compose.yml), then `npm run reset && npm run up`.

## The tokens

Devnet predeploys exactly two ERC20s, at the same addresses they have on mainnet and Sepolia:

| | Address |
|---|---|
| ETH | `0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7` |
| STRK | `0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d` |

There is no USDC here. The escrow does not care — it works with any ERC20 the admin allows — so the tests use ETH as the stand-in stablecoin. When you want to test against a real stable, you have two options: deploy a mock ERC20 onto devnet and allow that instead, or fork Sepolia (`--fork-network` in the devnet command) so the real USDC contract is visible.

To give any address money, including a wallet address that devnet has never seen:

```sh
npm run mint -- 0xYourAddress 100     # 100 ETH and 100 STRK
npm run balance -- 0xYourAddress
```

## deployments/devnet.json

This file is **output, not input**. Nothing reads it. `npm run deploy` writes it so you know where the contract landed and so a frontend or script can pick the address up later. There is one file per network; the devnet one is gitignored because that chain is wiped on every reset.

The tests ignore it completely. Every run declares and deploys a fresh escrow in `beforeAll`, so the suite never depends on a previous deployment. You do not need to fill anything in before running tests.

## Your browser wallet

The blunt answer: **you cannot import a devnet predeployed account into ArgentX or Braavos.** Two reasons, and neither is fixable from this side.

1. Neither extension supports importing a raw private key. That is a deliberate security decision by both.
2. Even if they did, a Starknet address is derived from the account *class* plus the key. Devnet's accounts use an OpenZeppelin class; the wallets use their own. The same key would produce a different address, with nothing in it.

What does work, if you need a wallet for frontend testing:

1. In ArgentX: Settings → Developer settings → Manage networks, add a network pointing at `http://127.0.0.1:5050/rpc` with chain id `SN_SEPOLIA`.
2. Switch to it and create a new account. The wallet deploys its own account contract — this works because devnet is started with `--predeclare-argent`, so Argent's class is already declared here.
3. Fund it: `npm run mint -- 0xTheNewAddress 100`.
4. Some versions need the address funded *before* the account will deploy. If creation fails, copy the address it shows you, mint to it, then retry.

Expect this to be fiddly, and expect to redo it after every `npm run reset` — the account contract is wiped along with everything else.

For everything in this repo you do not need the extension at all. The tests and scripts sign with the predeployed keys directly.

## Poking the contract by hand

`sncast` is in the toolchain image, so you can call a deployed contract without writing any TypeScript:

```sh
npm run shell
# then, inside the container:
sncast call --url http://devnet:5050/rpc \
  --contract-address 0xYourEscrowAddress --function deal_count
```

```
Success: Call completed
Response:     0_u64
```

Note the URL inside the container is `http://devnet:5050/rpc` — containers reach each other by service name. From your own machine it is `http://127.0.0.1:5050/rpc`. Both point at the same node.

Writes need a signing account configured in sncast, which is more setup than it is worth here; for anything that changes state, add it to a script in `tests/scripts/` instead.

## State, and losing it

Devnet keeps everything in memory for as long as the container runs. It survives `npm test`, `npm run deploy`, your machine going to sleep. It does not survive `npm run reset` or `npm run down`.

Two things to know:

- **Time only moves forward.** The tests call `devnet_increaseTime` to jump past deadlines, and that increment sticks for the rest of the session. After a full test run the chain's clock is weeks ahead of your wall clock. This is harmless, but it is why a contract deployed before a test run can look oddly old afterwards.
- **Deal ids keep counting.** A fresh escrow is deployed per test run, so ids restart at 1 each time, but a contract you deployed with `npm run deploy` keeps its own counter until the chain is reset.

If you want state to survive restarts, devnet supports dumping to a file (`--dump-on`, `--dump-path`). Not wired up here; add the flags to the devnet command and mount a volume for the file.
