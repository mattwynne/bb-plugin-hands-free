import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  name: string;
  bb: { name: string; description: string };
};

describe("plugin identity", () => {
  it("uses Hands-Free for both the public name and package identity", () => {
    expect(manifest.bb).toMatchObject({
      name: "Hands-Free",
      description: "Tap-to-talk and spoken-reply companion for BB threads",
    });
    expect(manifest.name).toBe("bb-plugin-hands-free");
  });
});
