import { defineConfig } from "vitest/config";

// The App is its own npm package, and it needs its own test config.
//
// Without this file, vitest started in `app/` walks up and loads the repo-root
// `vitest.config.ts`. That config is resolved from the repository root, so it
// needs a root-level `node_modules` to import `vitest` from. CI's `app` job
// installs only `app/`, so the root has none and every run died before a single
// test ran ("Cannot find package 'vitest'"). It passed locally only because a
// developer machine happens to have the root installed too.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
  },
});
