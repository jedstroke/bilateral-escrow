# Bilateral Escrow on Starknet

A Cairo escrow contract where both the customer and the merchant put money down, with TypeScript tests. Everything runs through Docker, so you can work from PowerShell on Windows without opening WSL.

- [docs/escrow.md](docs/escrow.md) — what the contract does and why
- [docs/devnet.md](docs/devnet.md) — the local chain: accounts, keys, tokens, wallets, what you can see and where

## What you need

- Docker Desktop, running
- Node 22+ (optional; only if you want to run the tests outside Docker)

## Layout

```
contracts/       Cairo package (Scarb)
  src/escrow.cairo       the contract
  src/interface.cairo    its public interface
  src/types.cairo        Deal, DealState, Fees, Windows
tests/           TypeScript tests and scripts (starknet.js + vitest)
  src/escrow.test.ts     the tests
  src/setup.ts           deploy + helpers
  src/devnet.ts          talking to devnet (accounts, time travel)
  scripts/deploy.ts      deploy to devnet or any RPC
docs/            escrow design, devnet guide
scripts/         dependency-free devnet helpers (accounts, mint, balance)
docker/cairo/    Dockerfile for the Cairo toolchain
docker-compose.yml
package.json     every command below, as npm scripts
dev.ps1          PowerShell shim over those scripts
```

## Commands

From the project root:

```powershell
npm run build        # compile the contract (first run also builds the toolchain image, a few minutes)
npm test             # start devnet if needed, run the TypeScript tests in Docker
npm run test:local   # same tests, but with your Windows Node against the Docker devnet
npm run deploy       # deploy to devnet, allow ETH, write tests/deployment.json
npm run fmt          # format Cairo
npm run shell        # bash inside the toolchain container (scarb, snforge, sncast)
npm run logs         # follow devnet
npm run reset        # wipe devnet state
npm run down         # stop everything, remove volumes

npm run accounts     # predeployed accounts: addresses, private keys, balances
npm run status       # chain id, block count, URLs
npm run ui           # open the block explorer in your browser
npm run mint -- 0xAddr 100    # fund any address with 100 ETH and 100 STRK
npm run balance -- 0xAddr     # check any address
```

Arguments pass through: `npm test -- -t disputes` runs only the dispute tests. Windows strips quotes on the way to the container, so use a space-free regex rather than a quoted phrase: `-t customer.*quiet`, not `-t "customer goes quiet"`.

There is no `npm install` at the root - it has no dependencies, only scripts. The tests' own dependencies install themselves the first time you run them.

`dev.ps1` forwards to the same scripts if you prefer it (`.\dev.ps1 build`, `.\dev.ps1 test-local`), and `docker compose` still works directly:

```powershell
docker compose run --rm cairo scarb build
docker compose up -d devnet
docker compose run --rm tests npx vitest run
```

Devnet is exposed on `http://127.0.0.1:5050`, so `sncast`, a wallet, or your own scripts on Windows can reach it. Its block explorer is at [/ui](http://127.0.0.1:5050/ui). Account keys, token addresses and what a browser wallet can and can't do are all in [docs/devnet.md](docs/devnet.md).

## How the pieces fit

Three containers, none of them long-lived except devnet:

| Service | Image | Job |
|---|---|---|
| `devnet` | `shardlabs/starknet-devnet-rs:0.10.0` | Local Starknet. Seeded, so the same five accounts appear every time. Explorer at `/ui`. |
| `cairo` | built from `docker/cairo` | Scarb 2.19.4 + Starknet Foundry 0.63.0. Compiles `contracts/` into `contracts/target/`. |
| `tests` | `node:22-alpine` | Installs deps into a Docker volume, runs vitest against `devnet`. |

The tests read the compiled artifacts from `contracts/target/dev/`, declare and deploy the contract on devnet, and drive it through every path: happy sale, cancellations, every timeout, returns, disputes. They use devnet's predeployed ETH as the escrow token and devnet's clock controls to jump past deadlines. A run takes about 90 seconds.

Running the tests natively (`test:local`) works because Node talks to devnet over localhost; only the Cairo compiler needs Linux. The Linux `node_modules` live in a Docker volume so they never collide with a Windows `npm install`.

## Versions

| | Version | Why |
|---|---|---|
| Scarb / Cairo | 2.19.4 | Matches the Cairo version listed for the current Starknet release |
| Starknet Foundry | 0.63.0 | Latest stable |
| OpenZeppelin Cairo | 4.0.1 | Latest stable; supplies Ownable, Pausable, ReentrancyGuard, IERC20 |
| starknet-devnet | 0.10.0 | Latest stable; RPC 0.10.2 |
| starknet.js | 10.x | Matches RPC 0.10.2 |

To bump the toolchain, change the two `ARG`s at the top of `docker/cairo/Dockerfile` and `cairo-version` in `contracts/Scarb.toml`, then `docker compose build cairo`.

## Deploying elsewhere

`tests/scripts/deploy.ts` defaults to devnet. For Sepolia or mainnet:

```powershell
$env:RPC_URL = "https://your-rpc/rpc/v0_10"
$env:ACCOUNT_ADDRESS = "0x..."
$env:PRIVATE_KEY = "0x..."
$env:TREASURY = "0x..."
$env:TOKENS = "0x...usdc,0x...usdt"
npm run deploy:local
```

Fees and windows for the deployment are set at the top of that script.

## Writing Cairo tests too

Not required, but `snforge` is in the toolchain image. Add `snforge_std = "0.63.0"` under `[dev-dependencies]` in `contracts/Scarb.toml`, put tests in `contracts/tests/`, and run `npm run snforge`.
