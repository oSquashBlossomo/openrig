import { expect, it } from "vitest";
import {
  LIVE_TERMINAL_MIN_READABLE_FONT_SIZE,
  LIVE_TERMINAL_MIN_TOUCH_FONT_SIZE,
  LIVE_TERMINAL_TOUCH_MEDIA_QUERY,
  fitTerminalFontSize,
  readableTerminalFontFloor,
} from "../src/components/terminal/terminal-fit.js";

// 155x37 at the 12px base with 0.6em cells.
const natural = { w: 1116, h: 444 };
const fit = (mode: "natural" | "width" | "contain", availableWidth: number, availableHeight: number, floor = 8) =>
  fitTerminalFontSize({ mode, natural, availableWidth, availableHeight, floor, maxUpscale: 2 });

it("fits both axes in contain mode with capped upscale and never upscales in width mode", () => {
  expect(fit("contain", 3000, 629)).toEqual({ fontSize: 17, overflows: false });
  expect(fit("contain", 5000, 5000)).toEqual({ fontSize: 24, overflows: false });
  expect(fit("width", 5000, 0)).toEqual({ fontSize: 12, overflows: false });
  expect(fit("contain", 3000, 296)).toEqual({ fontSize: 8, overflows: false });
});

it("holds the readable floor and reports panning instead of illegible text", () => {
  // A 390px phone would otherwise show 155 columns at ~3.7px.
  expect(fit("contain", 346, 700, LIVE_TERMINAL_MIN_TOUCH_FONT_SIZE)).toEqual({ fontSize: 11, overflows: true });
  expect(fit("width", 300, 0)).toEqual({ fontSize: 8, overflows: true });
});

it("does not fit natural mode or an unmeasured box", () => {
  expect(fit("natural", 300, 300)).toBeNull();
  expect(fit("width", 0, 300)).toBeNull();
  expect(fitTerminalFontSize({ mode: "contain", natural: { w: 0, h: 0 }, availableWidth: 300, availableHeight: 300, floor: 8, maxUpscale: 2 })).toBeNull();
});

it("uses the larger floor for touch or phone-width layouts", () => {
  const media = (matches: boolean) => ({ matchMedia: (query: string) => ({ matches: matches && query === LIVE_TERMINAL_TOUCH_MEDIA_QUERY }) as MediaQueryList });
  expect(readableTerminalFontFloor(media(true))).toBe(LIVE_TERMINAL_MIN_TOUCH_FONT_SIZE);
  expect(readableTerminalFontFloor(media(false))).toBe(LIVE_TERMINAL_MIN_READABLE_FONT_SIZE);
  expect(readableTerminalFontFloor(undefined)).toBe(LIVE_TERMINAL_MIN_READABLE_FONT_SIZE);
});
