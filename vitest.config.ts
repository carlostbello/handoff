import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // Live-relay tests share one relay (and its single host key), so run files serially.
    fileParallelism: false,
  },
})
