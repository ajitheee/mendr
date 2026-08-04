import { defineConfig } from "vitest/config";

// Root test runner covers Mendr's OWN source only.
// `fixtures/` are sample target repos (with their own node_modules + test
// runners) that Mendr scans — they must NOT be collected as our tests.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["fixtures/**", "**/__fixtures__/**", "node_modules/**", "dist/**"],
  },
});
