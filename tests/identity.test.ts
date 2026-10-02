import { describe, expect, test } from "vitest";
import { checkIdentity } from "@/server/engine/identity";

const base = {
  account: { email: "me@ket.com", name: "Tirajet" },
  gitAuthors: ["me@ket.com"],
};

describe("checkIdentity — git author must be the workload token's owner", () => {
  test("aligned identity has no warnings", () => {
    const result = checkIdentity(base);
    expect(result.warnings).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.account).toEqual(base.account);
  });

  test("warns when no git author is selected (would pull in teammates' commits)", () => {
    const result = checkIdentity({ ...base, gitAuthors: [] });
    expect(result.ok).toBe(false);
    expect(result.warnings.join(" ")).toMatch(/git/i);
  });

  test("warns when the token owner is not one of the selected git authors", () => {
    const result = checkIdentity({ ...base, gitAuthors: ["someone.else@ket.com"] });
    expect(result.ok).toBe(false);
    expect(result.warnings.join(" ")).toContain("me@ket.com");
  });

  test("accepts a selected git author matched by name instead of email", () => {
    const result = checkIdentity({ ...base, gitAuthors: ["tirajet"] });
    expect(result.warnings).toEqual([]);
  });

  test("no token yet is reported, not treated as a match", () => {
    const result = checkIdentity({ ...base, account: null });
    expect(result.ok).toBe(false);
    expect(result.warnings.join(" ")).toMatch(/โทเคน/);
  });
});
