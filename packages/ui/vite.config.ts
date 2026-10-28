import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev only: proxy API, SSE and the terminal WebSocket to a daemon. Always point
// OPENRIG_URL at a test daemon; the default is the production daemon on this Mac.
const daemonUrl = process.env.OPENRIG_URL ?? "http://localhost:7433";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": { target: daemonUrl, changeOrigin: true, ws: true },
      "/healthz": { target: daemonUrl, changeOrigin: true },
    },
  },
});
