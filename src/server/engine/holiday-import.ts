// Import the company holiday calendar (Zoho People → ตัวติดตามการลา → วันหยุด).
//
// The bundled Thai holiday list is a guess at the national calendar; the
// company's own list is the truth, and it differs — it drops days the company
// works through and adds ones it does not. Both directions matter: a day we
// wrongly treat as a holiday is a day the report silently stops asking for.

export type ImportedHoliday = { date: string; name: string };

const DATE_RE = /(\d{4}-\d{2}-\d{2})/g;
const DEFAULT_NAME = "วันหยุด";
// "2026-04-06, Mon" — the weekday and the columns after it are not the name.
const NOISE_RE = /(\d{4}-\d{2}-\d{2})|,|\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/g;

/**
 * Parses either a table pasted out of Zoho People or a plain "date name" list.
 * A line holding only dates continues the holiday named above it — that is how
 * Zoho renders a multi-day holiday such as สงกรานต์.
 */
export function parseHolidayText(text: string): ImportedHoliday[] {
  const rows: ImportedHoliday[] = [];
  const seen = new Set<string>();
  let lastName = "";

  for (const line of text.split("\n")) {
    const dates = [...line.matchAll(DATE_RE)].map((m) => m[1]);
    if (dates.length === 0) continue; // header, blank, or a column-only line

    // The name is always the first column ("วันจักรี", "วันหยุดสงกรานต์"); an
    // empty first column means this line continues the holiday above it.
    const [first] = line.replace(NOISE_RE, " ").split("\t");
    const name = first.trim() || null;
    if (name) lastName = name;

    for (const date of dates) {
      if (seen.has(date)) continue;
      seen.add(date);
      rows.push({ date, name: name ?? lastName ?? DEFAULT_NAME });
    }
  }
  return rows.map((r) => ({ ...r, name: r.name || DEFAULT_NAME }));
}

export type HolidayImportPlan = {
  /** Days to store as holidays (target 0). */
  holidays: ImportedHoliday[];
  /** Bundled holidays the company works through — forced back to workdays. */
  revertToWorkday: string[];
  /** Imported dates outside the year being replaced. */
  skipped: string[];
};

export function planHolidayImport(input: {
  year: string;
  imported: ImportedHoliday[];
  /** Dates the bundled list treats as holidays (any year). */
  bundledDates: string[];
}): HolidayImportPlan {
  const inYear = (date: string) => date.slice(0, 4) === input.year;

  const holidays = input.imported.filter((h) => inYear(h.date));
  const skipped = input.imported.filter((h) => !inYear(h.date)).map((h) => h.date);

  // An empty import means "I have nothing to say about this year", not
  // "the company observes no holidays" — reverting on that would be a footgun.
  const importedDates = new Set(holidays.map((h) => h.date));
  const revertToWorkday =
    holidays.length === 0
      ? []
      : input.bundledDates.filter((date) => inYear(date) && !importedDates.has(date));

  return { holidays, revertToWorkday, skipped };
}
