import { defineConfig } from "astro/config";

export default defineConfig({
  output: "static",
  base: "/runnel/",
  trailingSlash: "always",
  devToolbar: { enabled: false },
});
