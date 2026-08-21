import { describe, expect, test } from "vitest";
import { resolveClickupLink, type LinkableTask } from "@/server/engine/clickup-link";

const tasks: LinkableTask[] = [
  { taskId: "86d42gkvq", customId: "DEV-6836", url: "https://app.clickup.com/t/86d42gkvq" },
  { taskId: "86d421q8k", customId: "DEV-6826", url: "https://app.clickup.com/t/86d421q8k" },
  { taskId: "86czb2y7w", customId: null, url: "https://app.clickup.com/t/86czb2y7w" },
];

const commits = [
  { hash: "a1b2c3d4e5f6a7b8", ticketIds: ["DEV-6836"] },
  { hash: "bbbb1111cccc2222", ticketIds: ["DEV-6836", "DEV-6826"] },
  { hash: "cccc2222dddd3333", ticketIds: ["cu-86czb2y7w"] },
  { hash: "dddd3333eeee4444", ticketIds: [] },
];

// The rule is deliberately narrow: a commit carries a ticket id → attach that
// ClickUp task's link. Anything else gets no link.
describe("resolveClickupLink — only a ticket id inside a commit produces a link", () => {
  test("attaches the link for the ticket id in a commit the card cites", () => {
    const link = resolveClickupLink({
      card: { evidence: { commits: ["a1b2c3d4"], tasks: [] } },
      commits,
      tasks,
    });
    expect(link).toEqual({
      taskId: "86d42gkvq",
      customId: "DEV-6836",
      url: "https://app.clickup.com/t/86d42gkvq",
    });
  });

  test("picks the ticket that most of the cited commits share", () => {
    const link = resolveClickupLink({
      card: { evidence: { commits: ["a1b2c3d4", "bbbb1111"], tasks: [] } },
      commits,
      tasks,
    });
    expect(link?.customId).toBe("DEV-6836");
  });

  test("resolves a raw ClickUp ref (CU-…) from a commit too", () => {
    const link = resolveClickupLink({
      card: { evidence: { commits: ["cccc2222"], tasks: [] } },
      commits,
      tasks,
    });
    expect(link?.taskId).toBe("86czb2y7w");
  });

  test("matches ticket ids case-insensitively", () => {
    const link = resolveClickupLink({
      card: { evidence: { commits: ["eeee5555"], tasks: [] } },
      commits: [{ hash: "eeee5555ffff6666", ticketIds: ["dev-6826"] }],
      tasks,
    });
    expect(link?.customId).toBe("DEV-6826");
  });

  test("a cited commit without a ticket id gets no link", () => {
    expect(
      resolveClickupLink({
        card: { evidence: { commits: ["dddd3333"], tasks: [] } },
        commits,
        tasks,
      }),
    ).toBeNull();
  });

  // A card with no commit behind it (ClickUp-activity or filler) must not carry
  // a link — a ticket url next to invented hours reads as proof it is real.
  test("a card citing no commits gets no link, even when it names a task", () => {
    expect(
      resolveClickupLink({
        card: { evidence: { commits: [], tasks: ["DEV-6826"] } },
        commits,
        tasks,
      }),
    ).toBeNull();
  });

  test("a ticket id that is not a task we synced yields no link", () => {
    expect(
      resolveClickupLink({
        card: { evidence: { commits: ["ffff7777"], tasks: [] } },
        commits: [{ hash: "ffff7777aaaa8888", ticketIds: ["DEV-9999"] }],
        tasks,
      }),
    ).toBeNull();
  });

  test("a synced task without a url yields no link", () => {
    expect(
      resolveClickupLink({
        card: { evidence: { commits: ["aaaa9999"], tasks: [] } },
        commits: [{ hash: "aaaa9999bbbb0000", ticketIds: ["DEV-1"] }],
        tasks: [{ taskId: "x1", customId: "DEV-1", url: null }],
      }),
    ).toBeNull();
  });

  test("only commits the card actually cites are consulted", () => {
    expect(
      resolveClickupLink({
        card: { evidence: { commits: ["dddd3333"], tasks: [] } },
        commits, // a1b2c3d4 carries DEV-6836 but this card does not cite it
        tasks,
      }),
    ).toBeNull();
  });
});
