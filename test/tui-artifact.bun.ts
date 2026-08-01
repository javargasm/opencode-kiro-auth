import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);

describe("published TUI artifact", () => {
  it("publishes declarations and loads the JavaScript target declared by the package export", async () => {
    const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
    const target = pkg.exports?.["./tui"]?.default;

    expect(target).toBe("./dist/tui.js");
    const [indexTypes, tuiTypes] = await Promise.all([
      readFile(new URL("dist/index.d.ts", root), "utf8"),
      readFile(new URL("dist/tui.d.ts", root), "utf8"),
    ]);
    expect(indexTypes.length).toBeGreaterThan(0);
    expect(tuiTypes.length).toBeGreaterThan(0);
    const artifact = new URL(target.slice(2), root);
    const loaded = await import(`${artifact.href}?artifact-test=${Date.now()}`);

    expect(loaded.default).toMatchObject({ id: "opencode-kiro" });
    expect(typeof loaded.default.tui).toBe("function");
  });
});
