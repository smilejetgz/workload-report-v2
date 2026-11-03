// HTML note ⇄ plain text. Shared by the server (card topics, prompts,
// fingerprints, the upload) and the browser (deciding whether a topic repeats
// its note), because the two must agree character for character.
//
// The old workload API stored Thai as numeric entities ("&#3648;&#3614;…"), so
// skipping the decode leaves both the interface and the model reading entity
// codes instead of words. The new site keeps notes as plain text, so a card's
// HTML note is flattened with htmlToPlainNote before upload and rebuilt with
// plainTextToNoteHtml when a row is pulled back.

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, ref: string) => {
    const named = NAMED_ENTITIES[ref.toLowerCase()];
    if (named !== undefined) return named;
    if (!ref.startsWith("#")) return match; // unknown name — leave as written
    const code =
      ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
    return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
  });
}

/** One-line text: every tag becomes a space, whitespace collapses. */
export function htmlToText(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

const BULLET_RE = /^[-•*]\s+/;

/**
 * Multi-line text for the workload site's plain note field: block tags end a
 * line, every <li> becomes a "- " bullet, everything else is stripped.
 *
 *   <p><b>[DEV-1] หัวข้อ</b></p><ul><li>ก</li><li>ข</li></ul>
 *   →  "[DEV-1] หัวข้อ\n- ก\n- ข"
 */
export function htmlToPlainNote(html: string): string {
  const broken = html
    .replace(/\r\n?/g, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|ul|ol|blockquote|pre|tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(broken)
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line !== "" && line !== "-")
    .join("\n");
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The reverse for rows pulled back from the site: bullet lines ("- ", "• ")
 * become a <ul>, the first plain line is the bold headline, the rest are <p>.
 * The text is escaped, so anything typed into the site's note box can never
 * become markup here.
 */
export function plainTextToNoteHtml(text: string): string {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return "";

  const parts: string[] = [];
  let bullets: string[] = [];
  let sawHeadline = false;
  const flushBullets = () => {
    if (bullets.length === 0) return;
    parts.push(`<ul>${bullets.map((b) => `<li>${b}</li>`).join("")}</ul>`);
    bullets = [];
  };

  for (const line of lines) {
    if (BULLET_RE.test(line)) {
      bullets.push(escapeHtml(line.replace(BULLET_RE, "")));
      continue;
    }
    flushBullets();
    const escaped = escapeHtml(line);
    parts.push(!sawHeadline && lines.length > 1 ? `<p><b>${escaped}</b></p>` : `<p>${escaped}</p>`);
    sawHeadline = true;
  }
  flushBullets();
  return parts.join("");
}
