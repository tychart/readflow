import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const backendHttpTarget = "http://127.0.0.1:8000";
const backendWsTarget = "ws://127.0.0.1:8000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api/ws": {
        target: backendWsTarget,
        changeOrigin: true,
        ws: true,
        rewriteWsOrigin: true,
      },
      "/api": {
        target: backendHttpTarget,
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: "jsdom",
  },
});
