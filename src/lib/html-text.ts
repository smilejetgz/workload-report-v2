// HTML note → plain text. Shared by the server (card topics, prompts,
// fingerprints) and the browser (deciding whether a topic repeats its note),
// because the two must agree character for character.
//
// The workload API stores Thai as numeric entities ("&#3648;&#3614;…"), so
// skipping the decode leaves both the interface and the model reading entity
// codes instead of words.

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function htmlToText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, ref: string) => {
      const named = NAMED_ENTITIES[ref.toLowerCase()];
      if (named !== undefined) return named;
      if (!ref.startsWith("#")) return match; // unknown name — leave as written
      const code =
        ref[1] === "x" || ref[1] === "X"
          ? parseInt(ref.slice(2), 16)
          : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
    })
    .replace(/\s+/g, " ")
    .trim();
}
