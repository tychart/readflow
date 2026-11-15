import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

const backendHttpTarget = "http://127.0.0.1:8000";
const backendWsTarget = "ws://127.0.0.1:8000";

export default defineConfig(({ mode }) => {
  // Dev-only: Vite rejects a Host header it was not told about ("Blocked
  // request. This host (...) is not allowed"), which is what a reverse proxy in
  // front of the dev server sends. `HOST_URL` in the repo-root `.env` names it;
  // loopback, `*.localhost` and bare IPs never need this.
  const { HOST_URL = "" } = loadEnv(mode, "..", "");

  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 5173,
      strictPort: true,
      allowedHosts: HOST_URL ? [HOST_URL] : [],
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
  };
});
