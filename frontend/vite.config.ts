import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "../dist",
    emptyOutDir: true
  },
  server: {
    proxy: {
      "/config.json": "http://localhost:3000",
      "/ws": {
        target: "ws://localhost:3000",
        ws: true
      }
    }
  }
});
