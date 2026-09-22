import { describe, expect, it } from "vitest";
import { formatTime } from "../src/time";

describe("display time zones", () => {
  it("shows the UTC instant without adding the host's ten-hour offset", () => {
    expect(formatTime({ timestamp: 1790463171000, timeZone: "UTC", locale: "en-GB" })).toMatch(
      /^26 Sept, 22:52 GMT(?:\+0)?$/,
    );
  });
  it("labels Brisbane's next-day local time with its UTC offset", () => {
    expect(
      formatTime({ timestamp: 1790463171000, timeZone: "Australia/Brisbane", locale: "en-GB" }),
    ).toBe("27 Sept, 08:52 GMT+10");
  });
});
