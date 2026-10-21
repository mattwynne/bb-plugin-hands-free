import { describe, expect, it } from "vitest";
import { secMsGec, muid } from "./speech-edge-auth";

// Independent fixtures from rany2/edge-tts drm.generate_sec_ms_gec_v2,
// commit bd44c1d1aaebdc1db7f47456ee12431b42ec7cac (Python implementation).
describe("Edge v2 authentication", () => {
  it.each([
    [
      0,
      "52BC7A17B50DFEC9-28C4394775C8751CD2F6859C030C06DB1489ACAB3B3A7651831FC26895177ED6",
    ],
    [
      1699999800000,
      "2CD23A2CA0B2595A-F3C846C370E05F9CC83ACC5F995C5F5D87A4D0F14CE8936A0F902E64099E38A2",
    ],
    [
      1700000100000,
      "0919602B5750900A-EC9DD394F23CB5635CF62A0E8E24136DCD32B26D10C543B10082E482D7516397",
    ],
    [
      1792548000000,
      "9046EA88F9F2D8C9-10229A5C6C282D0782AA4CC8ED4206978CA634502F53DAC11E22BC88A750E811",
    ],
    [
      2000000000000,
      "2D62557F1142BC5D-FD9C30C68FF194A5EE6B45FEFC5E2BA1D1239F88A90569AB55CFFFAA7799F40E",
    ],
  ] as const)("matches upstream at %i ms", (time, expected) => {
    expect(secMsGec(time)).toBe(expected);
  });
  it("rounds down to five-minute boundaries without floating-point tick loss", () => {
    const boundary = 1700000100000;
    expect(secMsGec(boundary - 1)).toBe(secMsGec(boundary - 300000));
    expect(secMsGec(boundary + 299999)).toBe(secMsGec(boundary));
    expect(secMsGec(boundary - 1)).not.toBe(secMsGec(boundary));
  });
  it("generates fresh bounded MUID cookies", () => {
    expect(muid()).toMatch(/^[0-9A-F]{32}$/);
    expect(muid()).not.toBe(muid());
  });
});
