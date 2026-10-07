import { describe, expect, it } from "vitest";
import { parseCmsHptTxt, selectEntry } from "./discover";

const TXT = `location-name: Example Medical Center – Hillcrest
source-page-url: https://example.org/pricing
mrf-url: https://example.org/files/hillcrest.csv
contact-name: Pat Example
contact-email: pat@example.org

location-name: Example Medical Center – La Jolla
source-page-url: https://example.org/pricing
mrf-url: https://example.org/files/lajolla.json
contact-name: Pat Example
contact-email: pat@example.org
location-name: Example East Campus
mrf-url: https://cdn.example.net/east.zip
`;

describe("cms-hpt.txt", () => {
  it("parses blocks, with or without blank lines between them", () => {
    const entries = parseCmsHptTxt(TXT);
    expect(entries.map((e) => e.mrfUrl)).toEqual([
      "https://example.org/files/hillcrest.csv",
      "https://example.org/files/lajolla.json",
      "https://cdn.example.net/east.zip",
    ]);
    expect(entries[2]!.sourcePageUrl).toBeNull();
  });

  it("selects by case-insensitive location substring", () => {
    expect(selectEntry(parseCmsHptTxt(TXT), ["la jolla"]).mrfUrl).toBe("https://example.org/files/lajolla.json");
  });

  it("refuses ambiguous or missing matches", () => {
    expect(() => selectEntry(parseCmsHptTxt(TXT), ["example medical"])).toThrow(/2 different files/);
    expect(() => selectEntry(parseCmsHptTxt(TXT), ["nowhere"])).toThrow(/No cms-hpt.txt entry/);
    expect(() => selectEntry(parseCmsHptTxt(TXT), [])).toThrow();
  });
});
