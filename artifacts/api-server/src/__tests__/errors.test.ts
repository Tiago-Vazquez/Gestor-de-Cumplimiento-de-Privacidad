import { describe, it, expect } from "vitest";
import { AppError, notFound, badRequest } from "../lib/errors";

describe("AppError", () => {
  it("assigns status, title, and detail correctly", () => {
    const err = new AppError(418, "I'm a teapot", "Short and stout");
    expect(err.status).toBe(418);
    expect(err.title).toBe("I'm a teapot");
    expect(err.detail).toBe("Short and stout");
    expect(err.name).toBe("AppError");
    expect(err.message).toBe("Short and stout");
  });

  it("uses title as message when detail is omitted", () => {
    const err = new AppError(500, "Internal Server Error");
    expect(err.message).toBe("Internal Server Error");
    expect(err.detail).toBeUndefined();
  });

  it("preserves the cause when provided", () => {
    const cause = new Error("root cause");
    const err = new AppError(500, "fail", "something broke", { cause });
    expect(err.cause).toBe(cause);
  });
});

describe("notFound()", () => {
  it("returns an AppError with status 404", () => {
    const err = notFound("User not found");
    expect(err.status).toBe(404);
    expect(err.title).toBe("Not Found");
    expect(err.detail).toBe("User not found");
  });

  it("works without a detail message", () => {
    const err = notFound();
    expect(err.status).toBe(404);
    expect(err.detail).toBeUndefined();
  });
});

describe("badRequest()", () => {
  it("returns an AppError with status 400", () => {
    const err = badRequest("Invalid email");
    expect(err.status).toBe(400);
    expect(err.title).toBe("Bad Request");
    expect(err.detail).toBe("Invalid email");
  });
});