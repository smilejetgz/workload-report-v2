import { describe, expect, test } from "vitest";
import {
  isMyCommit,
  parseAuthorFilters,
  parseAuthorLog,
  type GitAuthor,
} from "@/server/sources/git";

const SEP = "\x1f";
const line = (email: string, name: string, iso: string) => [email, name, iso].join(SEP);

describe("parseAuthorLog", () => {
  const raw = [
    line("me@ket.com", "Tirajet Chukleang", "2026-08-19T10:00:00+07:00"),
    line("me@ket.com", "Tirajet Chukleang", "2026-08-20T11:00:00+07:00"),
    line("other@ket.com", "Somchai", "2026-08-18T09:00:00+07:00"),
    line("ME@KET.COM", "tirajet", "2026-08-21T09:00:00+07:00"),
    "",
  ].join("\n");

  test("aggregates commits per author email, case-insensitively", () => {
    const authors = parseAuthorLog(raw);
    const mine = authors.find((a) => a.email === "me@ket.com") as GitAuthor;
    expect(mine.commits).toBe(3);
    expect(authors).toHaveLength(2);
  });

  test("keeps the most recent commit date and the most-used name", () => {
    const mine = parseAuthorLog(raw).find((a) => a.email === "me@ket.com")!;
    expect(mine.name).toBe("Tirajet Chukleang");
    expect(mine.lastCommitAt?.slice(0, 10)).toBe("2026-08-21");
  });

  test("sorts by commit count, descending", () => {
    expect(parseAuthorLog(raw)[0].email).toBe("me@ket.com");
  });

  test("ignores malformed lines", () => {
    expect(parseAuthorLog("garbage\n\n")).toEqual([]);
  });
});

describe("parseAuthorFilters", () => {
  test("reads a JSON array", () => {
    expect(parseAuthorFilters('["a@b.com","c@d.com"]')).toEqual(["a@b.com", "c@d.com"]);
  });

  test("reads a comma / newline separated list", () => {
    expect(parseAuthorFilters("a@b.com, c@d.com\ne@f.com")).toEqual([
      "a@b.com",
      "c@d.com",
      "e@f.com",
    ]);
  });

  test("empty input means no filter", () => {
    expect(parseAuthorFilters(null)).toEqual([]);
    expect(parseAuthorFilters("  ")).toEqual([]);
  });
});

describe("isMyCommit", () => {
  const commit = { authorEmail: "Me@Ket.com", authorName: "Tirajet Chukleang" };

  test("no filter selected → every commit counts", () => {
    expect(isMyCommit(commit, [])).toBe(true);
  });

  test("matches the selected email case-insensitively", () => {
    expect(isMyCommit(commit, ["me@ket.com"])).toBe(true);
  });

  test("matches a selected author name too", () => {
    expect(isMyCommit(commit, ["tirajet chukleang"])).toBe(true);
  });

  test("rejects a teammate's commit", () => {
    expect(isMyCommit({ authorEmail: "other@ket.com", authorName: "Somchai" }, ["me@ket.com"])).toBe(
      false,
    );
  });
});
