import { describe, expect, test } from "vitest";
import { checkIdentity } from "@/server/engine/identity";

// The workload account is the JWT's owner — the v2 server writes every row
// under it, whatever the body says.
const base = {
  workloadEmail: "me@ket.com",
  workloadName: "Tirajet Chukleang",
  gitAuthors: ["me@ket.com"],
};

describe("checkIdentity — git author must match the workload account", () => {
  test("aligned identity has no warnings", () => {
    const result = checkIdentity(base);
    expect(result.warnings).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("warns when no git author is selected (would pull in teammates' commits)", () => {
    const result = checkIdentity({ ...base, gitAuthors: [] });
    expect(result.ok).toBe(false);
    expect(result.warnings.join(" ")).toMatch(/git/i);
  });

  test("warns when the account email is not one of the selected git authors", () => {
    const result = checkIdentity({ ...base, gitAuthors: ["someone.else@ket.com"] });
    expect(result.ok).toBe(false);
    expect(result.warnings.join(" ")).toContain("me@ket.com");
  });

  test("accepts a selected git author matched by the account name instead of email", () => {
    const result = checkIdentity({ ...base, gitAuthors: ["Tirajet Chukleang"] });
    expect(result.warnings).toEqual([]);
  });

  test("no token yet is reported", () => {
    const result = checkIdentity({ ...base, workloadEmail: null, workloadName: null });
    expect(result.ok).toBe(false);
    expect(result.warnings.join(" ")).toMatch(/โทเคน/);
  });
});
