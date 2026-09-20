import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: { alias: { "@shared": resolve(__dirname, "shared/src") } },
  test: {
    include: ["shared/src/**/*.test.ts", "extension/src/**/*.test.ts", "server/src/**/*.test.ts"],
    environment: "node",
  },
});
