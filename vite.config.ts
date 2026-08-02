import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {},
  pack: {
    entry: ["src/index.ts"],
    format: ["esm"],
    platform: "node",
    // Nothing imports this package, it's only ever run as a binary
    dts: false,
    sourcemap: true,
  },
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
});
