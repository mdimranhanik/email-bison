import { defineConfig } from "@trigger.dev/sdk/v3";

export default defineConfig({
  project: "proj_ozyazdnjvzbqfiijhkos",
  dirs: ["./src/trigger"],
  maxDuration: 300,
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 5000,
      maxTimeoutInMs: 60000,
      factor: 2,
    },
  },
});
