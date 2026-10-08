import { fileURLToPath } from "url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // The web app's alias for the shared code, so tests can load its modules.
    alias: { $shared: fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "istanbul",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.d.ts",
        "src/cli.ts",           // Entry point, tested via E2E
        "src/app.tsx",          // Main app, tested via integration
        "src/hooks/**",         // Hook scripts, tested via integration
        "src/setup/wizard.ts",  // Interactive prompts, tested manually
        "src/components/index.ts", // Just re-exports
        "src/setup/index.ts",   // Just re-exports
      ],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
        statements: 80,
      },
    },
  },
});
