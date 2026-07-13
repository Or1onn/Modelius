import { describe, it, expect } from "vitest";
import { classifyRefreshError } from "@/entities/session/model/oauthShared";

// A refresh failure must only drop the stored login when the token is definitively dead; a
// transient failure must keep it (that's the "keys disappear" bug).
describe("classifyRefreshError", () => {
  it("treats invalid_grant as auth_failed", () => {
    expect(classifyRefreshError('token endpoint 400: {"error":"invalid_grant"}')).toBe("auth_failed");
  });

  it("treats a 400/401/403 status as auth_failed", () => {
    expect(classifyRefreshError("token endpoint 400: bad request")).toBe("auth_failed");
    expect(classifyRefreshError("openai token 401: unauthorized")).toBe("auth_failed");
    expect(classifyRefreshError("openai token 403: forbidden")).toBe("auth_failed");
  });

  it("treats 429 and 5xx as transient", () => {
    expect(classifyRefreshError("token endpoint 429: slow down")).toBe("transient");
    expect(classifyRefreshError("token endpoint 500: server error")).toBe("transient");
    expect(classifyRefreshError("token endpoint 503: unavailable")).toBe("transient");
  });

  it("treats a network/transport error (no HTTP status) as transient", () => {
    expect(classifyRefreshError("error sending request for url (https://auth.example): connection refused")).toBe("transient");
    expect(classifyRefreshError("operation timed out")).toBe("transient");
  });
});
