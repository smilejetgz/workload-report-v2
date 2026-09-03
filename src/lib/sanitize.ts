// Whitelist HTML sanitizer for workload notes. Shared by the server (AI output,
// card edits, rows pulled back from workload) and the client (edit preview and
// render). Notes are rendered with dangerouslySetInnerHTML, and their content
// comes from a model, from teammates typing on the workload website, and from
// the v1 database — none of it is trusted.

const ALLOWED_TAGS = new Set(["p", "b", "ul", "li", "code", "i", "br", "strong", "em"]);

// Anchored: only ever tested against a slice that starts at a "<".
// A tag name must follow "<" (or "</") immediately and begin with a letter —
// the same rule browsers use, so "2 < 3" stays the text the user wrote instead
// of being eaten as a tag.
const TAG_AT_START = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)[^>]*>/;

/**
 * Rewrites the input tag by tag: an allowed tag is re-emitted in canonical form
 * (no attributes), a disallowed tag is dropped, and a "<" that does not begin a
 * tag is escaped.
 *
 * The escaping is what makes this safe. A pass that merely deletes disallowed
 * tags lets the surrounding text close back up — "<" + <img …> + "img …>"
 * becomes a live "<img …>" — so every "<" that survives must be inert.
 */
export function sanitizeNoteHtml(html: string): string {
  let out = "";
  let i = 0;

  while (i < html.length) {
    const char = html[i];
    if (char !== "<") {
      out += char;
      i += 1;
      continue;
    }

    const match = TAG_AT_START.exec(html.slice(i));
    if (!match) {
      out += "&lt;"; // not a tag — must never pair with later text
      i += 1;
      continue;
    }

    const [raw, closing, name] = match;
    const tag = name.toLowerCase();
    if (ALLOWED_TAGS.has(tag)) out += tag === "br" ? "<br>" : `<${closing}${tag}>`;
    i += raw.length; // disallowed tags are consumed whole, attributes included
  }

  return out.replace(/\s+</g, " <").trim();
}
