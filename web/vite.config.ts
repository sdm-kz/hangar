import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// Dev server proxies API + SignalR to the .NET backend so the SPA and API share an origin.
const backend = process.env.BACKEND_URL ?? "http://127.0.0.1:5099";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: backend, changeOrigin: true },
      "/hub": { target: backend, changeOrigin: true, ws: true },
    },
  },
  // Production build lands in the .NET server's wwwroot.
  build: {
    outDir: path.resolve(__dirname, "../server/wwwroot"),
    emptyOutDir: true,
  },
});
