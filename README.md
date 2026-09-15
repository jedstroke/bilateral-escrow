<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/weselling-wordmark-on-dark.png">
  <img src="docs/assets/weselling-wordmark-on-light.png" alt="WeSelling" width="220">
</picture>

# Bilateral Escrow on Starknet

A [WeSelling](https://weselling.store) initiative.

A Cairo escrow contract where both the customer and the merchant put money down, with TypeScript tests. Everything runs through Docker, so it works the same from PowerShell on Windows (no WSL needed), a Mac terminal, or a Linux shell.

- [docs/escrow.md](docs/escrow.md) — what the contract does and why
- [docs/devnet.md](docs/devnet.md) — the local chain: accounts, keys, tokens, wallets, what you can see and where
- [docs/deploy.md](docs/deploy.md) — going to Sepolia or mainnet

## What you need

- Docker: Docker Desktop on Windows or macOS; Docker Engine with the compose plugin on Linux
- Node 22+, for the `npm run` commands (the tests themselves can run in Docker or with your Node)

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
deployments/     one record per network, written by deploy
docs/            escrow design, devnet guide, deployment guide
scripts/         dependency-free helpers: devnet accounts/mint/balance, docker compose wrapper
docker/cairo/    Cairo toolchain image (Scarb, Starknet Foundry)
docker/tests/    test runner image (Node 22)
docker-compose.yml
package.json     every command below, as npm scripts
dev.ps1, dev.sh  shims over those scripts for PowerShell and for bash/zsh
```

## Commands

Same on every OS. From the project root:

```sh
npm run build        # compile the contract (first run also builds the toolchain image, a few minutes)
npm test             # start devnet if needed, run the TypeScript tests in Docker
npm run test:local   # same tests, but with your own Node against the Docker devnet
npm run deploy       # deploy to devnet, allow ETH, write deployments/devnet.json
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

Arguments pass through: `npm test -- -t disputes` runs only the dispute tests. On Windows, quotes are stripped on the way to the container, so use a space-free regex rather than a quoted phrase: `-t customer.*quiet`, not `-t "customer goes quiet"`.

There is no `npm install` at the root - it has no dependencies, only scripts. The tests' own dependencies install themselves the first time you run them.

`dev.ps1` (PowerShell) and `dev.sh` (bash, zsh) forward to the same scripts, if you prefer `.\dev.ps1 test-local` or `./dev.sh test-local` to `npm run test:local`. And `docker compose` still works directly:

```sh
docker compose run --rm cairo scarb build
docker compose up -d devnet
docker compose run --rm tests npx vitest run
```

**On Linux**, use the npm scripts (or `dev.sh`) rather than raw `docker compose`. They go through `scripts/compose.mjs`, which passes your uid/gid into the containers so that `contracts/target/`, `package-lock.json` and `deployments/*.json` are owned by you and not by root. Docker Desktop on Windows and macOS does that mapping on its own, so nothing changes there. If you previously ran raw `docker compose` on Linux and have root-owned files, a one-time `sudo chown -R $USER:$USER .` clears it up.

Devnet is exposed on `http://127.0.0.1:5050`, so `sncast`, a wallet, or your own scripts on your machine can reach it. Its block explorer is at [/ui](http://127.0.0.1:5050/ui). Account keys, token addresses and what a browser wallet can and can't do are all in [docs/devnet.md](docs/devnet.md).

## How the pieces fit

Three containers, none of them long-lived except devnet:

| Service | Image | Job |
|---|---|---|
| `devnet` | `shardlabs/starknet-devnet-rs:0.10.0` | Local Starknet. Seeded, so the same five accounts appear every time. Explorer at `/ui`. |
| `cairo` | built from `docker/cairo` | Scarb 2.19.4 + Starknet Foundry 0.63.0. Compiles `contracts/` into `contracts/target/`. |
| `tests` | built from `docker/tests` | Node 22. Installs deps into a Docker volume, runs vitest against `devnet`. |

The tests read the compiled artifacts from `contracts/target/dev/`, declare and deploy the contract on devnet, and drive it through every path: happy sale, cancellations, every timeout, returns, disputes. They use devnet's predeployed ETH as the escrow token and devnet's clock controls to jump past deadlines. A run takes about 90 seconds.

Running the tests natively (`test:local`) works because Node talks to devnet over localhost; only the Cairo compiler needs a Linux environment, and Docker provides that on every OS. The container's `node_modules` live in a Docker volume so they never collide with an `npm install` you run on the host, which matters on Windows and macOS where the native binaries differ.

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

`npm run deploy` targets devnet. For Sepolia or mainnet, set the environment and use `deploy:local`:

```sh
# bash / zsh
export RPC_URL="https://your-provider/starknet/sepolia/rpc/v0_10"
export ACCOUNT_ADDRESS="0x..." PRIVATE_KEY="0x..." TREASURY="0x..."
export TOKENS="0x...usdc,0x...usdt"
npm run deploy:local
```

```powershell
# PowerShell
$env:RPC_URL = "https://your-provider/starknet/sepolia/rpc/v0_10"
$env:ACCOUNT_ADDRESS = "0x..."; $env:PRIVATE_KEY = "0x..."; $env:TREASURY = "0x..."
$env:TOKENS = "0x...usdc,0x...usdt"
npm run deploy:local
```

It prints the plan — network, admin, treasury, class hash, fees, windows, and each token's symbol and decimals — then stops. Nothing is sent until you re-run with `CONFIRM=yes`. The result lands in `deployments/<network>.json`.

Fees and windows have defaults you can override per deployment, the contract is **not** upgradeable, and the deploying key starts out as admin. All of that, plus what to do immediately afterwards, is in [docs/deploy.md](docs/deploy.md).

## Writing Cairo tests too

Not required, but `snforge` is in the toolchain image. Add `snforge_std = "0.63.0"` under `[dev-dependencies]` in `contracts/Scarb.toml`, put tests in `contracts/tests/`, and run `npm run snforge`.
