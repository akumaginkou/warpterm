import { defineConfig } from "vite";

// Tauri expects a fixed dev port and no auto-clearing of the console.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    target: "es2021",
    outDir: "dist",
  },
});
