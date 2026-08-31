import { describe, it, expect } from "vitest";
import {
  sendProblemJson,
  statusTitle,
  type ProblemDetails,
} from "../lib/problem-json";
import { createMockResponse } from "./test-utils";

describe("statusTitle()", () => {
  it("returns correct titles for known statuses", () => {
    expect(statusTitle(400)).toBe("Bad Request");
    expect(statusTitle(404)).toBe("Not Found");
    expect(statusTitle(413)).toBe("Payload Too Large");
    expect(statusTitle(429)).toBe("Too Many Requests");
    expect(statusTitle(500)).toBe("Internal Server Error");
  });

  it("returns 'Error' for unknown statuses", () => {
    expect(statusTitle(418)).toBe("Error");
    expect(statusTitle(999)).toBe("Error");
  });
});

describe("sendProblemJson()", () => {
  it("sends the correct status and content type", () => {
    const res = createMockResponse();
    const problem: ProblemDetails = {
      type: "about:blank",
      title: "Bad Request",
      status: 400,
      detail: "Invalid input",
    };
    sendProblemJson(res, problem);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual(problem);
  });

  it("serializes the full problem object", () => {
    const res = createMockResponse();
    const problem: ProblemDetails = {
      type: "about:blank",
      title: "Validation Failed",
      status: 400,
      instance: "/api/findings",
      errors: [{ path: "status", message: "Required" }],
    };
    sendProblemJson(res, problem);
    expect(res.body).toEqual(problem);
  });
});