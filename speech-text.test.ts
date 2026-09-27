import { describe, expect, it } from "vitest";
import { plainSpeechText } from "./speech-text";

describe("plainSpeechText", () => {
  it("removes Markdown syntax while retaining the words meant to be read", () => {
    expect(plainSpeechText("# **Done**\n\n- First *step*\n- [Second step](https://example.com) with `code` and ~~old~~ text"))
      .toBe("Done\nFirst step\nSecond step with code and old text");
  });

  it("handles fenced code, blockquotes, images, tables, escapes and entities", () => {
    expect(plainSpeechText("> Ready &amp; waiting\n\n![Chart](chart.png)\n\n| Name | Value |\n| --- | --- |\n| A | 2 |\n\n```js\nconst x = 1;\n```\n\n\\*literal\\*"))
      .toBe("Ready & waiting\nChart\nName, Value\nA, 2\nconst x = 1;\n*literal*");
  });

  it("leaves ordinary prose and meaningful punctuation alone", () => {
    expect(plainSpeechText("Hello, world! 2 * 3 = 6. Keep C# and snake_case."))
      .toBe("Hello, world! 2 * 3 = 6. Keep C# and snake_case.");
  });
});
