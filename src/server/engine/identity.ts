// The identity used to upload (workload create-task-list: task_by + email) must
// be the same person as the selected git commit authors — otherwise a report
// either carries somebody else's commits or lands under the wrong name.
// Pure function: warnings only, never blocks a submit on its own.

export type WorkloadEmployee = { name: string; email: string };

export type IdentityCheckInput = {
  workloadEmail: string | null;
  taskBy: string | null;
  /** Selected git identities (emails and/or names). */
  gitAuthors: string[];
  /** From workload /tasks/get-employee. null = list unavailable (no JWT). */
  employees: WorkloadEmployee[] | null;
};

export type IdentityCheck = {
  ok: boolean;
  warnings: string[];
  /** The employee row that matches the configured upload email, if any. */
  matchedEmployee: WorkloadEmployee | null;
};

const lower = (v: string) => v.trim().toLowerCase();

export function checkIdentity(input: IdentityCheckInput): IdentityCheck {
  const warnings: string[] = [];
  const authors = input.gitAuthors.map(lower).filter(Boolean);
  const email = input.workloadEmail?.trim() ?? "";
  const taskBy = input.taskBy?.trim() ?? "";

  if (authors.length === 0) {
    warnings.push(
      "ยังไม่ได้เลือก git user ของเรา — commit ของคนอื่นในทีมจะถูกนับเข้า workload ด้วย",
    );
  }
  if (!email) warnings.push("ยังไม่ได้ตั้ง email ที่ใช้ upload (workload create-task-list)");
  if (!taskBy) warnings.push("ยังไม่ได้ตั้ง task_by ที่ใช้ upload (workload create-task-list)");

  const matchedEmployee =
    input.employees && email
      ? (input.employees.find((e) => lower(e.email) === lower(email)) ?? null)
      : null;

  if (email && authors.length > 0) {
    // The git identity may be an email or a display name — either counts.
    const employeeName = matchedEmployee?.name ?? taskBy;
    const matchesGit =
      authors.includes(lower(email)) ||
      (employeeName.length > 0 && authors.includes(lower(employeeName)));
    if (!matchesGit) {
      warnings.push(
        `email ที่ใช้ upload (${email}) ไม่ตรงกับ git user ที่เลือก (${input.gitAuthors.join(", ")}) — ` +
          "ต้องเป็นคนเดียวกัน ไม่งั้นงานจะขึ้นผิดคน",
      );
    }
  }

  if (input.employees && email) {
    if (!matchedEmployee) {
      warnings.push(
        `email ${email} ไม่อยู่ใน employee ของ workload — เลือกจาก list ในหน้า Settings`,
      );
    } else if (taskBy && lower(matchedEmployee.name) !== lower(taskBy)) {
      warnings.push(
        `task_by "${taskBy}" ไม่ตรงกับชื่อใน workload ("${matchedEmployee.name}") — ใช้ชื่อตาม workload`,
      );
    }
  }

  return { ok: warnings.length === 0, warnings, matchedEmployee };
}
