import { describe, expect, test } from "vitest";
import { htmlToPlainNote, htmlToText, plainTextToNoteHtml } from "@/lib/html-text";

describe("htmlToPlainNote — the site's note box is plain text", () => {
  test("headline + bullets become lines with '- ' bullets", () => {
    const html =
      "<p><b>[DEV-6395] ส่งโปรโมชันอัตโนมัติ</b></p><ul><li>ลูกค้าได้รับคูปองทันที</li><li>ตั้งเงื่อนไขได้</li></ul>";
    expect(htmlToPlainNote(html)).toBe(
      "[DEV-6395] ส่งโปรโมชันอัตโนมัติ\n- ลูกค้าได้รับคูปองทันที\n- ตั้งเงื่อนไขได้",
    );
  });

  test("decodes the numeric entities the old site stored Thai as", () => {
    expect(htmlToPlainNote("<p>&#3607;&#3635;</p>")).toBe("ทำ");
  });

  test("<br> and nested whitespace do not leave blank lines", () => {
    expect(htmlToPlainNote("<p>a<br><br>   b </p>\n\n<p></p>")).toBe("a\nb");
  });

  test("plain text passes through unchanged", () => {
    expect(htmlToPlainNote("แค่ข้อความ")).toBe("แค่ข้อความ");
  });
});

describe("plainTextToNoteHtml — rows pulled back from the site", () => {
  test("rebuilds a bold headline and a bullet list", () => {
    expect(plainTextToNoteHtml("หัวข้อ\n- ก\n• ข")).toBe(
      "<p><b>หัวข้อ</b></p><ul><li>ก</li><li>ข</li></ul>",
    );
  });

  test("a single line is a plain paragraph, not a headline", () => {
    expect(plainTextToNoteHtml("แค่บรรทัดเดียว")).toBe("<p>แค่บรรทัดเดียว</p>");
  });

  test("escapes anything that looks like markup — notes on the site are untrusted", () => {
    const html = plainTextToNoteHtml('<img src=x onerror="alert(1)">\n- 2 < 3');
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).toContain("2 &lt; 3");
  });

  test("round trip keeps the text", () => {
    const text = "[DEV-1] หัวข้อ\n- ก\n- ข";
    expect(htmlToPlainNote(plainTextToNoteHtml(text))).toBe(text);
  });
});

describe("htmlToText still flattens to one line", () => {
  test("tags become spaces", () => {
    expect(htmlToText("<p>a</p><p>b</p>")).toBe("a b");
  });
});
