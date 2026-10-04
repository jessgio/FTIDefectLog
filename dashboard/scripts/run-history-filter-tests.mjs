import { build } from "esbuild";
import { pathToFileURL } from "node:url";

const outfile = "/tmp/history-filters-test.mjs";

await build({
  entryPoints: ["src/historyFilters.test.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile,
  logLevel: "error",
});

await import(pathToFileURL(outfile).href);
