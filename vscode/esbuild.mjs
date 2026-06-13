// Bundle the extension (+ the reused shared protocol & CLI client) into one CJS
// file for VS Code. A tiny resolver maps NodeNext ".js" import specifiers to the
// real ".ts" sources, so we bundle straight from src — no separate build step.
import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";

const tsResolve = {
  name: "ts-js-resolve",
  setup(build) {
    build.onResolve({ filter: /\.js$/ }, (args) => {
      if (!args.importer) return undefined; // entry point
      const abs = path.resolve(args.resolveDir, args.path);
      const ts = abs.replace(/\.js$/, ".ts");
      if (fs.existsSync(ts)) return { path: ts };
      return undefined; // node_modules etc. — let esbuild handle it
    });
  },
};

const watch = process.argv.includes("--watch");
const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  platform: "node",
  format: "cjs",
  target: "node18",
  // vscode is provided by the host; ws's optional native deps are tried-and-caught.
  external: ["vscode", "bufferutil", "utf-8-validate"],
  sourcemap: true,
  plugins: [tsResolve],
  logLevel: "info",
};

const ctx = await esbuild.context(options);
if (watch) {
  await ctx.watch();
  console.log("watching…");
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
