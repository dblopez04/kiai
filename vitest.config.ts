import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/server/test/**/*.test.ts"],
    // Needs PostgreSQL: `npm run db:up` starts one in a container.
    globalSetup: ["packages/server/test/global-setup.ts"],
  },
});
