import { describe, expect, it } from "vitest";
import { assertSafeUrl, isPrivateAddress } from "./fetch";

describe("URL safety", () => {
  it.each(["10.0.0.5", "127.0.0.1", "169.254.169.254", "172.20.1.1", "192.168.1.1", "100.64.0.1", "::1", "fd00::1", "::ffff:10.0.0.1"])(
    "treats %s as private",
    (ip) => expect(isPrivateAddress(ip)).toBe(true),
  );

  it.each(["8.8.8.8", "132.239.1.1", "2606:4700::1111"])("treats %s as public", (ip) => expect(isPrivateAddress(ip)).toBe(false));

  it("rejects http, credentials, localhost, and private IP literals", async () => {
    await expect(assertSafeUrl("http://example.org/a.csv")).rejects.toThrow(/non-https/);
    await expect(assertSafeUrl("https://user:pw@example.org/a.csv")).rejects.toThrow(/credentials/);
    await expect(assertSafeUrl("https://localhost/a.csv")).rejects.toThrow(/internal/);
    await expect(assertSafeUrl("https://169.254.169.254/latest/meta-data")).rejects.toThrow(/private/);
  });
});
