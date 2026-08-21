import { describe, expect, test } from "vitest";
import { extractTicketIds } from "@/server/sources/git";

describe("extractTicketIds — real ticket keys only", () => {
  test("picks up the project's Jira-style keys", () => {
    expect(extractTicketIds("feat(DEV-6771): trim the balloon box")).toEqual(["DEV-6771"]);
    expect(extractTicketIds("fix ISSUE-7709 export order")).toEqual(["ISSUE-7709"]);
  });

  test("picks up ClickUp task refs", () => {
    expect(extractTicketIds("closes CU-86czb2y7w")).toEqual(["CU-86czb2y7w"]);
    expect(extractTicketIds("ref #86czb2y7w")).toEqual(["#86czb2y7w"]);
  });

  // Every one of these was pulled out of this repo's real history and sent to
  // ClickUp as a lookup that could never match.
  test("ignores CSS hex colours", () => {
    for (const color of ["#FFFFFF", "#dddddd", "#f5f6fa", "#17C950", "#B12629", "#FDECECFF"]) {
      expect(extractTicketIds(`background: ${color};`)).toEqual([]);
    }
  });

  test("ignores technical acronyms that look like keys", () => {
    expect(extractTicketIds("timestamps follow ISO-8601")).toEqual([]);
    expect(extractTicketIds("hash with SHA-256 and MD-5")).toEqual([]);
    expect(extractTicketIds("see RFC-3339 and UTF-8")).toEqual([]);
  });

  test("ignores a prefix that contains a digit, such as a version", () => {
    expect(extractTicketIds("bump to V8-7-5")).toEqual([]);
    expect(extractTicketIds("Version-8-7-5 deployed")).toEqual([]);
  });

  test("keeps a genuine key that merely sits next to noise", () => {
    expect(extractTicketIds("DEV-6395 emits ISO-8601 timestamps #FFFFFF")).toEqual(["DEV-6395"]);
  });

  test("de-duplicates and upper-cases Jira-style keys", () => {
    expect(extractTicketIds("dev-6395 and DEV-6395")).toEqual(["DEV-6395"]);
  });

  test("a one-letter prefix is not a key", () => {
    expect(extractTicketIds("part A-1 of the plan")).toEqual([]);
  });
});
