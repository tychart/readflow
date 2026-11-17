import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "virtual:pwa-register": new URL(
        "./src/test-utils/pwa-register.ts",
        import.meta.url,
      ).pathname,
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./setupTests.ts"],
    css: true,
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["e2e/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.{ts,tsx}"],
    },
  },
});
