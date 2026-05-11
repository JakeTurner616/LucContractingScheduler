import { defineConfig } from "astro/config";

const site = process.env.PUBLIC_SITE_URL || "http://localhost:4325";

export default defineConfig({
  output: "static",
  site
});