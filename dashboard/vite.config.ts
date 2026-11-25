import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development the panel runs on :5173 and forwards /api to the local
// DelphiLens server (examples/evidence-starter/dashboard-server.ts).
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${process.env.DASHBOARD_PORT ?? 8787}`,
        // The API only serves requests addressed to localhost.
        changeOrigin: true,
      },
    },
  },
});
