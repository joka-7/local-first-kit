import { defineConfig } from "vitest/config";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export default defineConfig({
  resolve: { alias: { "libsodium-wrappers": require.resolve("libsodium-wrappers") } },
  test: { server: { deps: { inline: [/libsodium/] } } },
});
