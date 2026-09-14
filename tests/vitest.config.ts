import { defineConfig } from "vitest/config";

// Every test talks to the same devnet, so run files one at a time.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 300_000,
    reporters: ["verbose"],
  },
});
