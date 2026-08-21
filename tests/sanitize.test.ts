import { describe, expect, test } from "vitest";
import { sanitizeNoteHtml } from "@/lib/sanitize";

describe("sanitizeNoteHtml — no allowed tag may be reassembled from what we drop", () => {
  test("keeps the whitelisted note markup untouched", () => {
    const html = "<p><b>หัวข้อ</b></p><ul><li>รายการ <code>fn()</code></li></ul>";
    expect(sanitizeNoteHtml(html)).toBe(html);
  });

  test("strips attributes, including event handlers", () => {
    expect(sanitizeNoteHtml('<p onclick="steal()">ok</p>')).toBe("<p>ok</p>");
  });

  test("drops disallowed tags entirely", () => {
    const clean = sanitizeNoteHtml('<img src=x onerror="alert(1)">hi<iframe src="//evil"></iframe>');
    expect(clean).not.toContain("<img");
    expect(clean).not.toContain("<iframe");
    expect(clean).toContain("hi");
  });

  // A single pass that only deletes disallowed tags lets the leftover text
  // re-form one: "<" + "<img …>" removed + "img …>" === "<img …>".
  test("a nested-tag payload cannot rebuild an executable tag", () => {
    const payload = "<<img src=x onerror=alert(1)>img src=x onerror=alert(1)>";
    const clean = sanitizeNoteHtml(payload);
    expect(clean).not.toMatch(/<\s*img/i);
    expect(clean).not.toMatch(/<\s*script/i);
  });

  test("the same trick with a script tag is also neutralised", () => {
    const clean = sanitizeNoteHtml("<<script>script>alert(1)</script>");
    expect(clean).not.toMatch(/<\s*script/i);
  });

  test("a stray angle bracket is escaped, never left to pair with later text", () => {
    expect(sanitizeNoteHtml("a < b")).not.toMatch(/<[a-zA-Z]/);
    expect(sanitizeNoteHtml("2 < 3 and 5 > 4")).toContain("&lt;");
  });

  test("output is stable — sanitising twice changes nothing", () => {
    const payload = "<<img src=x onerror=alert(1)>img src=x onerror=alert(1)><p>ok</p>";
    const once = sanitizeNoteHtml(payload);
    expect(sanitizeNoteHtml(once)).toBe(once);
  });

  test("comments and doctype-like junk cannot start a tag", () => {
    expect(sanitizeNoteHtml("<!--<script>alert(1)</script>-->")).not.toMatch(/<\s*script/i);
  });
});
