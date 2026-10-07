import path from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Tauri serves the built files; `tauri dev` points its windows at this dev server instead.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // "@web" reaches into the Homeport web UI for what both must agree on (session colours).
  resolve: { alias: { "@": path.resolve(__dirname, "src"), "@web": path.resolve(__dirname, "../web/src") } },
  clearScreen: false,
  server: { port: 1430, strictPort: true },
  build: { target: "es2022", chunkSizeWarningLimit: 1200 },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
