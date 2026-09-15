/**
 * `docker compose`, with the host identity filled in on Linux.
 *
 * Docker Desktop (Windows, macOS) maps files a container writes back to your user. Native
 * Docker on Linux does not: anything a root container writes to a bind mount stays owned by
 * root on your disk. So on Linux we pass your uid/gid to compose, and the containers pick it
 * up (see docker-compose.yml). Everywhere else the defaults (root) are correct.
 *
 * Usage is identical to `docker compose`:  node scripts/compose.mjs up -d devnet
 */
import { spawnSync } from "node:child_process";

const env = { ...process.env };
if (process.platform === "linux" && typeof process.getuid === "function") {
  env.DOCKER_UID ??= String(process.getuid());
  env.DOCKER_GID ??= String(process.getgid());
}

const result = spawnSync("docker", ["compose", ...process.argv.slice(2)], { stdio: "inherit", env });

if (result.error) {
  const hint =
    result.error.code === "ENOENT"
      ? "docker was not found on PATH. Install Docker Desktop (Windows/macOS) or Docker Engine with the compose plugin (Linux), and make sure it is running."
      : result.error.message;
  console.error(hint);
  process.exit(1);
}
process.exit(result.status ?? 1);
