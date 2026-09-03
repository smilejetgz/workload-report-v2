import { describe, expect, test } from "vitest";
import { checkIdentity } from "@/server/engine/identity";

const base = {
  workloadEmail: "me@ket.com",
  taskBy: "Tirajet Chukleang",
  gitAuthors: ["me@ket.com"],
  employees: [{ name: "Tirajet Chukleang", email: "me@ket.com" }],
};

describe("checkIdentity — git author must match the workload upload identity", () => {
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

  test("warns when the upload email is not one of the selected git authors", () => {
    const result = checkIdentity({ ...base, gitAuthors: ["someone.else@ket.com"] });
    expect(result.ok).toBe(false);
    expect(result.warnings.join(" ")).toContain("me@ket.com");
  });

  test("accepts a selected git author matched by name instead of email", () => {
    const result = checkIdentity({ ...base, gitAuthors: ["Tirajet Chukleang"] });
    expect(result.warnings).toEqual([]);
  });

  test("warns when the upload email is not a workload employee", () => {
    const result = checkIdentity({
      ...base,
      employees: [{ name: "Somchai", email: "other@ket.com" }],
    });
    expect(result.ok).toBe(false);
    expect(result.warnings.join(" ")).toMatch(/employee/i);
  });

  test("warns when task_by does not match the employee name for that email", () => {
    const result = checkIdentity({ ...base, taskBy: "Someone Else" });
    expect(result.ok).toBe(false);
    expect(result.warnings.join(" ")).toContain("Tirajet Chukleang");
  });

  test("skips the employee checks when the list is unavailable", () => {
    const result = checkIdentity({ ...base, employees: null });
    expect(result.warnings).toEqual([]);
  });

  test("missing workload identity is reported", () => {
    const result = checkIdentity({ ...base, workloadEmail: null, taskBy: null });
    expect(result.ok).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
