import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// http://localhost:7071 の Functions へ /api をプロキシ
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:7071", changeOrigin: true
      }
    }
  },
  build: { outDir: "dist" }
});
