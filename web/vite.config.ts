import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const backendHttpTarget = "http://127.0.0.1:8000";
const backendWsTarget = "ws://127.0.0.1:8000";

export default defineConfig(({ mode }) => {
  // Dev-only: Vite rejects a Host header it was not told about ("Blocked
  // request. This host (...) is not allowed"), which is what a reverse proxy in
  // front of the dev server sends. `HOST_URL` in the repo-root `.env` names it;
  // loopback, `*.localhost` and bare IPs never need this.
  const { HOST_URL = "" } = loadEnv(mode, "..", "");

  return {
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        // Updates must never tear down an active MediaSource automatically.
        // The app imports `virtual:pwa-register` and presents its own explicit
        // reload action when a waiting worker reports a new build.
        injectRegister: false,
        registerType: "prompt",
        manifest: {
          name: "ReadFlow",
          short_name: "ReadFlow",
          description: "Long-form text-to-speech listening.",
          theme_color: "#0b1120",
          background_color: "#0b1120",
          display: "standalone",
          start_url: "/",
          scope: "/",
          icons: [
            {
              src: "/pwa-192.png",
              sizes: "192x192",
              type: "image/png",
            },
            {
              src: "/pwa-512.png",
              sizes: "512x512",
              type: "image/png",
            },
          ],
        },
        // The PWA is intentionally an application-shell cache. User-owned API
        // data and generated media remain network-only, so a stale worker can
        // never replay an old authenticated response or grow device storage by
        // retaining books.
        workbox: {
          cleanupOutdatedCaches: true,
          navigateFallbackDenylist: [/^\/api\//],
          runtimeCaching: [],
        },
        // The private HTTPS reverse proxy makes the Vite origin secure when a
        // phone tests the local stack. Keeping the worker on in dev exercises
        // the same update path without adding TLS concerns to this repository.
        devOptions: {
          enabled: true,
          suppressWarnings: true,
        },
      }),
    ],
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
