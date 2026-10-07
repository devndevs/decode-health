import { describe, expect, it } from "vitest";
import { parseCmsHptTxt, selectEntries } from "./discover";

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
    expect(selectEntries(parseCmsHptTxt(TXT), ["la jolla"]).map((e) => e.mrfUrl)).toEqual(["https://example.org/files/lajolla.json"]);
  });

  it("returns every matching file as a part, in listed order, without duplicates", () => {
    const doubled = parseCmsHptTxt(TXT + "\nlocation-name: Example Medical Center – Hillcrest\nmrf-url: https://example.org/files/hillcrest.csv\n");
    expect(selectEntries(doubled, ["example medical"]).map((e) => e.mrfUrl)).toEqual([
      "https://example.org/files/hillcrest.csv",
      "https://example.org/files/lajolla.json",
    ]);
  });

  it("refuses missing matches", () => {
    expect(() => selectEntries(parseCmsHptTxt(TXT), ["nowhere"])).toThrow(/No cms-hpt.txt entry/);
    expect(() => selectEntries(parseCmsHptTxt(TXT), [])).toThrow();
  });
});
