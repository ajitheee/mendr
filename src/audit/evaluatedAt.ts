// THE EVALUATION INSTANT — one clock read per run, pinnable across a batch, and never guessed.
//
// An audit's time-dependent answers all come from a single `now`:
//
//   * the bundled registry's AGE, and therefore its freshness grade, which decides whether a
//     zero-finding result is `no exposure` or `inconclusive`;
//   * `daysUntil` for every finding;
//   * the DEADLINE SEVERITY that follows — `22d ahead` / `due TODAY` / `39d past`.
//
// None of that is cosmetic. Severity is what a reader acts on, so a batch of scans that straddles a
// day boundary can hand two repositories different verdicts for no reason except when their turn
// came. That happened on 2026-09-29: runs 7 and 8 crossed the registry's 2.0-day mark, six of twelve
// repositories reported `ageDays: 1.9` and six reported `2`.
//
// WHY AN UNPARSEABLE PIN IS A HARD ERROR. The first version of this fell back to the system clock
// when it could not read the variable. That is the worst available behaviour: someone who
// deliberately pinned an instant would get a confident, valid-looking report computed at a DIFFERENT
// time than they asked for, with every deadline in it shifted and nothing saying so. A pin exists to
// make a run reproducible; silently ignoring it defeats the only reason to set it. So a present but
// unreadable value stops the run with a configuration error, and the report is never produced.
//
// WHY A BARE DATETIME IS ALSO REJECTED. JavaScript parses `2026-10-23` as UTC midnight but
// `2026-10-23T00:00:00` as LOCAL midnight — the same string means different instants on two
// machines, which is precisely the irreproducibility a pin is meant to remove. A date-only value is
// therefore DEFINED as UTC, an explicit offset is honoured, and a datetime without one is refused
// with a message that says what to add.

/** The environment variable that pins the instant. */
export const EVALUATED_AT_ENV = 'MENDR_EVALUATED_AT';

/** Where the evaluation instant came from. Recorded in the report. */
export type EvaluationTimeSource = 'system' | 'override';

export interface EvaluationTime {
  at: Date;
  source: EvaluationTimeSource;
}

/** A present-but-unusable pin. Carries a sentence for the operator, not a parser dump. */
export class EvaluatedAtError extends Error {}

/** `YYYY-MM-DD` — defined as UTC midnight. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/** RFC 3339 with an explicit offset: `Z`, `+HH:MM` or `-HH:MM`. */
const WITH_OFFSET = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2})?(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

/**
 * The instant this run evaluates against, and where it came from.
 *
 * - variable ABSENT → the system clock, read once here. `source: 'system'`.
 * - variable VALID → that instant, normalised to UTC. `source: 'override'`.
 * - variable PRESENT BUT UNUSABLE → throws {@link EvaluatedAtError}. Never falls back.
 */
export function resolveEvaluationTime(
  env: NodeJS.ProcessEnv = process.env,
  systemNow: () => Date = () => new Date(),
): EvaluationTime {
  const raw = env[EVALUATED_AT_ENV];
  if (raw === undefined) return { at: systemNow(), source: 'system' };
  const value = raw.trim();
  // An empty or whitespace-only value is a MISCONFIGURATION, not an absent variable: something set
  // it, and that something meant to pass an instant. Guessing which it meant is the error this
  // function exists to refuse.
  if (value === '') {
    throw new EvaluatedAtError(
      `${EVALUATED_AT_ENV} is set but empty. Give it a date (2026-10-23) or a timestamp with a ` +
        'timezone (2026-10-23T14:00:00Z), or unset it to use the current time.',
    );
  }
  if (!DATE_ONLY.test(value) && !WITH_OFFSET.test(value)) {
    // Name the two accepted shapes rather than echoing the parser, and call out the one mistake
    // that looks correct: a timestamp with no timezone.
    const looksLikeNakedDateTime = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}/.test(value);
    throw new EvaluatedAtError(
      `${EVALUATED_AT_ENV} is "${value}", which mendr cannot read as a specific instant. ` +
        (looksLikeNakedDateTime
          ? 'It has no timezone, so it would mean a different moment on every machine — add Z for UTC ' +
            `(${value}Z) or an offset such as +05:30.`
          : 'Use a date (2026-10-23, taken as UTC) or a timestamp with a timezone (2026-10-23T14:00:00Z).') +
        ' Nothing was scanned; the run stopped here rather than report a result computed at an unintended time.',
    );
  }
  // CHECK THE CALENDAR FROM THE STRING, NOT FROM THE PARSER. JavaScript's Date parser is lenient:
  // `2026-02-30T00:00:00Z` does not fail, it rolls over to March 2nd and returns a perfectly valid
  // Date. So `isNaN` never fires, and a typo would produce a report silently evaluated on a day
  // nobody typed — the exact silent-substitution this function exists to refuse. The fields are
  // therefore validated against what was written, before any Date is constructed.
  const fields = /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(value);
  const [, y, mo, d, hh, mm, ss] = (fields ?? []).map((x) => (x === undefined ? undefined : Number(x)));
  if (!isRealCalendarDate(y as number, mo as number, d as number) || !isRealClockTime(hh, mm, ss)) {
    throw new EvaluatedAtError(
      `${EVALUATED_AT_ENV} is "${value}", which has the right shape but is not a real date or time. ` +
        'Check the month, day, hour, minute and second. Nothing was scanned.',
    );
  }
  const at = new Date(DATE_ONLY.test(value) ? `${value}T00:00:00Z` : value);
  // Backstop only. Everything the parser could quietly normalise was refused above.
  if (Number.isNaN(at.getTime())) {
    throw new EvaluatedAtError(`${EVALUATED_AT_ENV} is "${value}", which mendr cannot read. Nothing was scanned.`);
  }
  return { at, source: 'override' };
}

function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/** Does this year-month-day exist on the Gregorian calendar? */
function isRealCalendarDate(y: number, m: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (m < 1 || m > 12 || d < 1) return false;
  const days = [31, isLeapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  return d <= days;
}

/** Hour 0-23, minute 0-59, second 0-60 (RFC 3339 admits a leap second). Absent fields are fine. */
function isRealClockTime(hh?: number, mm?: number, ss?: number): boolean {
  if (hh === undefined) return true;
  if (hh < 0 || hh > 23 || (mm as number) < 0 || (mm as number) > 59) return false;
  return ss === undefined || (ss >= 0 && ss <= 60);
}
