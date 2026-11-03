// The person a report is uploaded as is whoever owns the workload token — the
// site stores every row under the token's user. That person must be the same
// as the selected git commit authors, otherwise a report either carries
// somebody else's commits or lands under the wrong name.
// Pure function: warnings only, never blocks a submit on its own.

export type WorkloadAccount = { email: string; name: string };

export type IdentityCheckInput = {
  /** From GET /auth/me (cached in settings). null = no usable token yet. */
  account: WorkloadAccount | null;
  /** Selected git identities (emails and/or names). */
  gitAuthors: string[];
};

export type IdentityCheck = {
  ok: boolean;
  warnings: string[];
  account: WorkloadAccount | null;
};

const lower = (v: string) => v.trim().toLowerCase();

export function checkIdentity(input: IdentityCheckInput): IdentityCheck {
  const warnings: string[] = [];
  const authors = input.gitAuthors.map(lower).filter(Boolean);
  const account = input.account;

  if (authors.length === 0) {
    warnings.push(
      "ยังไม่ได้เลือก git user ของเรา — commit ของคนอื่นในทีมจะถูกนับเข้า workload ด้วย",
    );
  }
  if (!account) {
    warnings.push("ยังไม่มีโทเคน workload ที่ใช้ได้ — ยังไม่รู้ว่ารายงานจะขึ้นในชื่อใคร");
  }

  if (account && authors.length > 0) {
    // The git identity may be an email or a display name — either counts.
    const matchesGit =
      (account.email.length > 0 && authors.includes(lower(account.email))) ||
      (account.name.length > 0 && authors.includes(lower(account.name)));
    if (!matchesGit) {
      warnings.push(
        `โทเคน workload เป็นของ ${account.name || account.email} (${account.email}) ` +
          `ไม่ตรงกับ git user ที่เลือก (${input.gitAuthors.join(", ")}) — ` +
          "ต้องเป็นคนเดียวกัน ไม่งั้นงานจะขึ้นผิดคน",
      );
    }
  }

  return { ok: warnings.length === 0, warnings, account };
}
