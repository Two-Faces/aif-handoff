import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Keep native Git fixture timing independent of unrelated fixture processes.
    // Cross-process races are exercised explicitly inside their owning tests.
    fileParallelism: process.platform !== "win32",
    exclude: ["dist/**", "**/node_modules/**", "**/.git/**", "**/*SFConflict*"],
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "json-summary"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: [
        "src/index.ts",
        "src/browser.ts",
        "src/types.ts",
        "src/constants.ts",
        "src/db.ts",
        "src/**/*SFConflict*",
      ],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 70,
        statements: 70,
      },
    },
  },
});
