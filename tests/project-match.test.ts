import { describe, expect, test } from "vitest";
import { normalizeHost, websiteForProject } from "@/server/engine/project-match";

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

describe("websiteForProject — the reverse for pulled rows", () => {
  test("uses the host for websites and the name for internal projects", () => {
    expect(websiteForProject(3787, projects)).toBe("seafreshgourmet.com");
    expect(websiteForProject(9430, projects)).toBe("Ketshopweb");
    expect(websiteForProject(null, projects)).toBeNull();
    expect(websiteForProject(123456, projects)).toBeNull();
  });
});
