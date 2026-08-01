import solidPlugin from "@opentui/solid/bun-plugin";

const result = await Bun.build({
  entrypoints: ["./src/tui.tsx"],
  outdir: "./dist",
  naming: "tui.js",
  target: "node",
  format: "esm",
  external: ["@opencode-ai/*", "@opentui/*", "solid-js"],
  plugins: [solidPlugin],
});

if (!result.success) {
  for (const message of result.logs) console.error(message);
  process.exit(1);
}
