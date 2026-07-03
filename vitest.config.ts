import { defineConfig } from "vitest/config";

// The tests cover the pure functions (mappers, range/grouping helpers), so the
// default Node environment is sufficient — no Workers pool needed.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
