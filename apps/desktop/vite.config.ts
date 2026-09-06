import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { buildThemeBootstrap } from "./src/themeBootstrap";

// Tauri expects a fixed dev port.
export default defineConfig({
  base: "./",
  plugins: [react(), {
    name: "miniq-theme-bootstrap",
    transformIndexHtml: {
      order: "pre",
      handler: (html) => html.replace("<!-- miniq-theme-bootstrap -->", `<script>${buildThemeBootstrap()}</script>`),
    },
  }],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    target: "es2022",
    outDir: "dist",
  },
});
