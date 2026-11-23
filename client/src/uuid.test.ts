import { afterEach, describe, expect, it, vi } from "vitest";
import { createSecureUuid } from "./uuid";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createSecureUuid", () => {
  it("uses crypto.randomUUID when available", () => {
    const randomUUID = vi.fn(() => "a9a52d83-0b25-4c28-8543-f32093779e8e");
    vi.stubGlobal("crypto", { randomUUID });

    expect(createSecureUuid()).toBe("a9a52d83-0b25-4c28-8543-f32093779e8e");
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it("generates an RFC 4122 version 4 UUID with getRandomValues as fallback", () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => bytes.fill(0));
    vi.stubGlobal("crypto", { getRandomValues });

    expect(createSecureUuid()).toBe("00000000-0000-4000-8000-000000000000");
    expect(getRandomValues).toHaveBeenCalledOnce();
  });

  it("fails clearly when a secure random source is unavailable", () => {
    vi.stubGlobal("crypto", undefined);

    expect(() => createSecureUuid())
      .toThrow("Open the dashboard over HTTPS or localhost");
  });
});
