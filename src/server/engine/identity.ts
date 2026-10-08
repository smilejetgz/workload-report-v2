// The workload account the report is written under (the owner of the JWT)
// must be the same person as the selected git commit authors — otherwise a
// report either carries somebody else's commits or lands under the wrong name.
// Pure function: warnings only, never blocks a submit on its own.

export type IdentityCheckInput = {
  /** From the workload JWT. null = no usable token yet. */
  workloadEmail: string | null;
  workloadName: string | null;
  /** Selected git identities (emails and/or names). */
  gitAuthors: string[];
};

export type IdentityCheck = { ok: boolean; warnings: string[] };

const lower = (v: string) => v.trim().toLowerCase();

export function checkIdentity(input: IdentityCheckInput): IdentityCheck {
  const warnings: string[] = [];
  const authors = input.gitAuthors.map(lower).filter(Boolean);
  const email = input.workloadEmail?.trim() ?? "";
  const name = input.workloadName?.trim() ?? "";

  if (authors.length === 0) {
    warnings.push(
      "ยังไม่ได้เลือก git user ของเรา — commit ของคนอื่นในทีมจะถูกนับเข้า workload ด้วย",
    );
  }
  if (!email) {
    warnings.push("ยังไม่ได้วางโทเคนของ workload — ยังไม่รู้ว่าจะส่งรายงานในนามใคร");
  }

  if (email && authors.length > 0) {
    // The git identity may be an email or a display name — either counts.
    const matchesGit =
      authors.includes(lower(email)) || (name.length > 0 && authors.includes(lower(name)));
    if (!matchesGit) {
      warnings.push(
        `บัญชี workload (${name ? `${name} · ` : ""}${email}) ไม่ตรงกับ git user ที่เลือก ` +
          `(${input.gitAuthors.join(", ")}) — ต้องเป็นคนเดียวกัน ไม่งั้นงานจะขึ้นผิดคน`,
      );
    }
  }

  return { ok: warnings.length === 0, warnings };
}
