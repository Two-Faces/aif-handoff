import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Native Git fixture files compete for Windows process startup resources.
    // Serialize files, retaining all explicit concurrent-process scenarios.
    fileParallelism: process.platform !== "win32",
    exclude: ["dist/**", "**/node_modules/**", "**/.git/**", "**/*SFConflict*"],
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "json-summary"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "src/**/*SFConflict*"],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 70,
        statements: 70,
      },
    },
  },
});
