import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { buildThemeBootstrap } from "./src/themeBootstrap";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { mobileModelProxy } from "./devModelProxy";

// Tauri expects a fixed dev port.
export default defineConfig(({ mode }) => ({
  base: "./",
  plugins: [
    react({
      babel: {
        plugins: ["babel-plugin-react-compiler"],
      },
    }),
    viteStaticCopy({
      targets: ["cmaps", "standard_fonts", "wasm"].map((name) => ({
        src: `node_modules/pdfjs-dist/${name}/*`,
        dest: `pdfjs/${name}`,
        rename: { stripBase: true },
      })),
    }),
    {
      name: "miniq-theme-bootstrap",
      transformIndexHtml: {
        order: "pre",
        handler: (html) =>
          html.replace(
            "<!-- miniq-theme-bootstrap -->",
            `<script>${buildThemeBootstrap()}</script>`,
          ),
      },
    },
  ],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    proxy: mobileModelProxy(loadEnv(mode, process.cwd(), "")),
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    target: "es2022",
    outDir: "dist",
  },
}));
