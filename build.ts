import type { BuildConfig, OnLoadArgs, OnLoadResult, Plugin } from "bun";

const outdir = "dist";
const entrypoints = ["src/manifest.ts", "src/worker.ts", "src/ui/index.tsx"];

function stripPluginImports(): Plugin {
  return {
    name: "strip-paperclip-runtime-imports",
    setup(build) {
      // Paperclip plugin APIs are injected by the host at runtime.
      // Bundling them from @paperclipai/sdk would fail in a standalone CLI context
      // and is unnecessary for the plugin host. Mark these imports as external.
      build.onResolve({ filter: /^@paperclipai\/(sdk|plugin|core)$/ }, (args) => ({
        path: args.path,
        external: true,
      }));
    },
  };
}

const watch = process.argv.includes("--watch");

async function build() {
  const result = await Bun.build({
    entrypoints,
    outdir,
    target: "bun",
    format: "esm",
    splitting: false,
    sourcemap: "external",
    minify: false,
    plugins: [stripPluginImports()],
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  console.log(`Built ${entrypoints.length} entrypoints into ${outdir}/`);
}

build();
if (watch) {
  const watcher = new FileSystemWatcher("src");
  console.log("Watching src/ for changes...");
  for await (const _event of watcher) {
    await build();
  }
}
