import { describe, expect, test } from "vitest";
import { countUploadStates, uploadBadge } from "@/lib/format";

describe("uploadBadge — อัพแล้ว / ยังไม่อัพ / อัพไม่สำเร็จ", () => {
  test("submitted with a remote id is fully uploaded", () => {
    const badge = uploadBadge({ status: "submitted", remoteTaskId: "34975" });
    expect(badge.state).toBe("uploaded");
    expect(badge.label).toBe("อัพแล้ว");
  });

  test("submitted without a remote id says the id is not linked", () => {
    const badge = uploadBadge({ status: "submitted", remoteTaskId: null });
    expect(badge.state).toBe("uploaded");
    expect(badge.label).toContain("ยังไม่ผูก id");
  });

  test("draft and approved are not uploaded yet", () => {
    expect(uploadBadge({ status: "draft" }).state).toBe("pending");
    expect(uploadBadge({ status: "approved" }).state).toBe("pending");
    expect(uploadBadge({ status: "draft" }).label).toBe("ยังไม่อัพ");
  });

  test("failed is reported as a failed upload, even with a remote id", () => {
    const badge = uploadBadge({ status: "failed", remoteTaskId: "34975" });
    expect(badge.state).toBe("failed");
    expect(badge.label).toBe("อัพไม่สำเร็จ");
  });

  test("counts every state for the summary line", () => {
    expect(
      countUploadStates([
        { status: "submitted", remoteTaskId: "1" },
        { status: "submitted", remoteTaskId: null },
        { status: "draft" },
        { status: "approved" },
        { status: "failed" },
      ]),
    ).toEqual({ uploaded: 2, pending: 2, failed: 1 });
  });
});
