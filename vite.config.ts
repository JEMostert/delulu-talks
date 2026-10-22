import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The Tauri renderer: `tauri dev` loads the dev server on port 1420 and
// `tauri build` bundles `dist/`.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      // The browser preview mock has top-level state; drop it when bridge.ts
      // no longer references it (production builds).
      treeshake: {
        moduleSideEffects: (id) =>
          !/[\\/]src[\\/]preview(Scenarios)?\.ts$/.test(id),
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    watch: {
      ignored: [
        "**/out/**",
        "**/release/**",
        "**/electron/**",
        "**/src-tauri/**",
        // Generated test fixtures remain served, without reloading other tests.
        "**/artifacts/**",
        "**/test-results/**",
      ],
    },
  },
});
