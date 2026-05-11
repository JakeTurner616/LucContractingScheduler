import { defineConfig } from "astro/config";

const workerOrigin = process.env.PUBLIC_API_ORIGIN || "http://127.0.0.1:8787";
const site = process.env.PUBLIC_SITE_URL || "http://localhost:4325";

export default defineConfig({
  output: "static",
  site,
  vite: {
    server: {
      proxy: {
        "/ics": {
          target: workerOrigin,
          changeOrigin: true,
          secure: true
        }
      }
    }
  }
});
