// Day-plan prompt builder. Pure function — snapshot-tested.

import type { StyleExample } from "@/db/schema";
import { formatEvidenceText, stripHtml, type DayEvidence } from "./evidence";

const THAI_DAYS = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];

export type PromptInput = {
  evidence: DayEvidence;
  taskTypeNames: string[];
  rulesMd: string | null;
  styleExamples: StyleExample[];
  repairNote?: string | null;
};

export function buildDayPrompt(input: PromptInput): string {
  const { evidence } = input;
  const targetHours = evidence.targetSec / 3600;
  const dow = THAI_DAYS[new Date(`${evidence.date}T00:00:00Z`).getUTCDay()];
  const hasCommits = evidence.commits.length > 0;
  const coverageLine = hasCommits
    ? `Commit hashes that MUST all be covered by some card's evidence.commits: ` +
      evidence.commits.map((c) => c.hash.slice(0, 8)).join(", ")
    : "No commits today — no commit coverage required.";

  const styleBlock =
    input.styleExamples.length > 0
      ? input.styleExamples
          .slice(0, 3)
          .map(
            (ex, i) =>
              `Example ${i + 1} (task_type: ${ex.taskType}, ${ex.durationSec / 3600}h):\n${ex.noteHtml}`,
          )
          .join("\n\n")
      : "(no examples yet — use the format shown in the schema example)";

  const alreadyReported =
    evidence.existingRemote.length > 0
      ? evidence.existingRemote
          .map((r) => `- [${r.taskType}] ${r.durationSec / 3600}h: ${r.notePlain}`)
          .join("\n")
      : "(none)";

  return `You are generating one day of a workload report for a software engineer.
Analyse the evidence below and produce work cards that credibly describe what was done.
Return ONLY a JSON object — no markdown fences, no commentary before or after.

## Output JSON schema (follow exactly)
{
  "date": "${evidence.date}",
  "cards": [
    {
      "topic": "short Thai headline of the work topic",
      "task_type": "one of the allowed task types",
      "website": null,
      "clickup_task": "custom id like DEV-6395 if the card is tied to one task, else null",
      "note_html": "<p><b>[DEV-6395] หัวข้องาน</b></p><ul><li>รายละเอียดสั้น ๆ</li></ul>",
      "hours": 2.5,
      "time_of_day": "morning",
      "origin": "git",
      "evidence": { "commits": ["a1b2c3d4"], "tasks": ["DEV-6395"] },
      "confidence": 0.9
    }
  ],
  "reviewer_notes": "optional: anything the reviewer should know (Thai)"
}

## Evidence priority (read this before anything else)
1. Git commits are the ground truth: they are the work that actually happened.
   Start from the commits, group them into work topics, and write those cards FIRST.
2. ${coverageLine}
   One card may cover many commits — group related ones instead of dropping any.
3. ClickUp is SUPPLEMENTARY. Use it to name the ticket, borrow the task's wording,
   and understand what the commits were for. A ClickUp task on its own is NOT
   evidence that work happened that day.
4. Add a card with no commit behind it only when (a) a task was closed or commented
   on that day, or (b) there are no commits at all this day, or (c) commits are all
   covered and hours are still missing.
5. Never let a ClickUp-only card take hours away from work the commits prove.
   Order the cards: commit-backed first, ClickUp-only next, inferred filler last.

## Hard rules
- "date" MUST be "${evidence.date}" (${dow}).
- Produce 2-5 cards. Total hours MUST sum to exactly ${targetHours} hours.
- hours: multiples of 0.25, each card between 0.5 and 4 hours.
- task_type MUST be exactly one of: ${input.taskTypeNames.join(", ")}.
- Group by WORK TOPIC / activity, never by repository name.
- note_html: HTML only, tags allowed: <p> <b> <ul> <li> <code>. Headline pattern:
  <p><b>[TICKET-ID] หัวข้อ</b></p> (omit [TICKET-ID] when there is none), then <ul> bullets.
  Each bullet under 14 words. Combine similar commits — do not restate messages verbatim.
- LANGUAGE: Thai as base, keep technical terms / product names / API names / file names
  in English (e.g. discount, endpoint, order, middleware). Natural Thai grammar with
  English tech terms inlined. Do NOT include commit hashes inside note_html.
- evidence.commits: hashes (≥7 chars) of the commits this card covers.
  evidence.tasks: ClickUp custom ids / task ids this card covers. Use only ids that
  appear in the evidence below — never invent ids.
- clickup_task: leave it null. The app attaches the ClickUp task and its url
  itself, from the ticket ids carried by the commits you cite — a card with no
  such commit gets no ClickUp reference, and that is intended.
- origin: "git" whenever the card cites at least one commit (this should be most cards),
  "clickup" only when it cites no commit but real task/comment activity that day,
  "inferred" when you are filling time without direct evidence.
- Do NOT duplicate anything listed under "Already reported".
- Filling time: only AFTER every commit and every real activity above is covered,
  and only to top up the remaining hours — never as the substance of the day.
  Use work that plausibly surrounds the evidence (review, testing, debugging of
  the same tickets), origin "inferred", confidence ≤ 0.4, and say so in
  reviewer_notes. A day with no evidence never reaches you: it is left empty on
  purpose, so never pad one out from the backlog.

## Style examples from previously submitted reports (mimic tone and formatting)
${styleBlock}

${input.rulesMd ? `## Additional user rules (override style, not the JSON contract)\n${stripHtml(input.rulesMd).slice(0, 2000)}\n` : ""}
## Evidence for ${evidence.date} (target: ${targetHours} hours)
${formatEvidenceText(evidence)}

## Already reported on ${evidence.date} (do not duplicate)
${alreadyReported}
${input.repairNote ? `\n## Fix these problems from your previous attempt\n${input.repairNote}\n` : ""}`;
}
