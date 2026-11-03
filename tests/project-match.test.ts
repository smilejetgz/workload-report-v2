import { describe, expect, test } from "vitest";
import { normalizeHost, resolveProjectId, websiteForProject } from "@/server/engine/project-match";

const projects = [
  { id: 3769, name: "pet-vet-store.com", websiteUrl: "pet-vet-store.com", isActive: true },
  { id: 3787, name: "seafreshgourmet.com", websiteUrl: "seafreshgourmet.com", isActive: true },
  { id: 9429, name: "KetBill", websiteUrl: null, isActive: true },
  { id: 9430, name: "Ketshopweb", websiteUrl: null, isActive: true },
  { id: 1, name: "old.com", websiteUrl: "old.com", isActive: false },
  { id: 2, name: "old.com (new)", websiteUrl: "old.com", isActive: true },
];

describe("normalizeHost", () => {
  test("strips scheme, www, path and case", () => {
    expect(normalizeHost("https://www.Pet-Vet-Store.com/shop?x=1")).toBe("pet-vet-store.com");
    expect(normalizeHost("http://seafreshgourmet.com/")).toBe("seafreshgourmet.com");
    expect(normalizeHost(null)).toBe("");
  });
});

describe("resolveProjectId — card website → workload project", () => {
  test("matches a customer site by host", () => {
    expect(resolveProjectId("http://pet-vet-store.com/", projects)).toBe(3769);
  });

  test("matches an internal project by name", () => {
    expect(resolveProjectId("Ketshopweb", projects)).toBe(9430);
    expect(resolveProjectId("ketbill", projects)).toBe(9429);
  });

  test("prefers the active project when a host is duplicated", () => {
    expect(resolveProjectId("old.com", projects)).toBe(2);
  });

  test("unknown or empty websites stay unassigned", () => {
    expect(resolveProjectId("nowhere.example", projects)).toBeNull();
    expect(resolveProjectId(null, projects)).toBeNull();
    expect(resolveProjectId("", projects)).toBeNull();
  });
});

describe("websiteForProject — the reverse for pulled rows", () => {
  test("uses the host for websites and the name for internal projects", () => {
    expect(websiteForProject(3787, projects)).toBe("seafreshgourmet.com");
    expect(websiteForProject(9430, projects)).toBe("Ketshopweb");
    expect(websiteForProject(null, projects)).toBeNull();
    expect(websiteForProject(123456, projects)).toBeNull();
  });
});
