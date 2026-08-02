import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  // dist/ is committed rather than gitignored, so it no longer falls out of
  // scope on its own — build output shouldn't be formatted or linted
  fmt: { ignorePatterns: ["dist/**"] },
  pack: {
    entry: ["src/index.ts"],
    format: ["esm"],
    platform: "node",
    // Nothing imports this package, it's only ever run as a binary
    dts: false,
    sourcemap: true,
    // package.json already sets "type": "module", so a plain .js file is
    // ESM. tsdown defaults to .mjs, which only earns its keep in a package
    // that mixes both module systems
    outExtensions: () => ({ js: ".js" }),
  },
  lint: {
    ignorePatterns: ["dist/**"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
});
