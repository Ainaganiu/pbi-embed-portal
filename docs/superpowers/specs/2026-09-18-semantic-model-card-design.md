# One model card: the semantic model's structure merged with the admin's meaning

**Status:** design, approved in principle (approach B), not yet planned
**Date:** 2026-09-18

## The problem

Everything the chat knows about a report's data model is typed by hand into
three admin textboxes — `schemaDescription`, `measuresDescription`,
`columnsDescription`. That text is the only grounding the DAX generator and
the answer composer have, and nothing verifies a word of it.

Two failures follow, and both are silent:

- **It drifts.** A description naming `[Total Sales]` keeps teaching the model
  to write DAX against `[Total Sales]` long after the measure is renamed. The
  query then fails, or — worse — succeeds against something else and reads as
  an answer. The IT Service Ticket report carries 3,165 characters of typed
  description with no check that a single name in it exists.
- **It is incomplete by construction.** Nobody hand-lists 36 columns, so the
  model is told about the few that were remembered.

Meanwhile the semantic model itself holds the exact structure and knows
nothing about what any of it *means*: every `Description` field in the probed
model came back null. Power BI carries structure without meaning; the admin
carries meaning without verified structure. Neither is sufficient alone, and
today nothing brings them together or notices when they disagree.

## What we can actually read

Established by probe against the live IT Service Ticket model
(`spike-model-metadata`, 2026-09-17), using the existing service principal
with **no additional permissions granted**:

| Probe | Result |
|---|---|
| `INFO.VIEW.MEASURES()` | ✅ 13 rows |
| `INFO.VIEW.COLUMNS()` | ✅ 36 rows |
| `INFO.VIEW.TABLES()` | ✅ 3 rows |
| `INFO.VIEW.RELATIONSHIPS()` | ✅ 1 row |
| `INFO.MEASURES()` (raw DMV variant) | ❌ 400 — not needed, the VIEW variant carries the same fields |

These are ordinary DAX table functions inside `EVALUATE`, so they travel
through the existing `executeQuery` path in `lib/powerbi.js`. No new API, no
Premium requirement, no XMLA.

Fields that matter, confirmed present:

- **Names, tables, data types** — exact, for measures and columns.
- **`FormatString`** — populated where the author set one (`"0"` on
  `Interaction ID`). This is the only *factual* percentage signal available
  anywhere in the system.
- **Relationships**, pre-rendered by Power BI:
  `'DataTable'[Date Received] *[<-]1 'Date'[Date]`, with `IsActive`,
  cardinality and filter direction. The card uses this string **as given** —
  it is already readable, and re-rendering it into prettier arrow notation
  would be a transformation that can only introduce bugs.
- **`IsHidden`, `Type`, `DataCategory`, `StorageMode`, `SummarizeBy`.**

Known gaps:

- **`Description` is null throughout.** The admin textboxes remain the sole
  source of business meaning. This design does not reduce their importance;
  it gives them something accurate to attach to.
- **`Expression` was null on both sampled measures.** Either Power BI redacts
  formulas at this permission level, or those two measures alone lack one. The
  full dump settles it. The design treats `Expression` as *optional* and works
  either way.

## Approach

Three were considered; **B** was chosen.

- **A — fetch lazily, merge at prompt time, cache in memory.** No schema
  change, self-healing. Rejected because the reconciliation's most valuable
  output — where the description and the model disagree — would be computed on
  every question and shown to nobody, and the first question after each expiry
  pays four extra DAX round trips.
- **B — explicit sync from admin, stored, merged at prompt time.** ✅ Chosen.
  Puts the disagreement in front of the person who can fix it, at the moment
  they can fix it. Hot path pays nothing. Staleness is real but visible and
  one click to resolve. Matches the existing convention: admin-managed in
  Postgres, cached in memory with a TTL.
- **C — B plus background auto-refresh.** Rejected for now: auto-refresh can
  silently change what the AI sees between one question and the next.

## Design

### Components

**`lib/modelMetadata.js`** — acquisition. Runs the four `INFO.VIEW.*` queries
through `executeQuery`, normalises the rows, and filters system objects.
Returns a plain structure; never throws, so a caller always gets either
metadata or `null`.

Filtering is not optional cosmetics. The probed model contains a
`RowNumber-2662979B-1795-4F74-8F37-6A1BA8059B61` column and a hidden
`DateAutoTemplate` table; fed to a prompt raw, they teach the model that
those are things it may reference. Excluded: `IsHidden = true`,
`Type = "RowNumber"`, and auto-date tables (`DateAutoTemplate`,
`LocalDateTable_*`).

**Storage** — two new nullable columns on `reports`, added with the
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` convention already used for
`problem_statement`:

- `model_metadata JSONB` — the normalised structure
- `model_metadata_synced_at TIMESTAMPTZ` — drives the "last synced" stamp

**`lib/modelCard.js`** — reconciliation and rendering. Takes the stored
metadata plus the three admin description fields and produces two things from
one pass:

1. `render(metadata, report)` → the merged card, a string, for prompts.
2. `reconcile(metadata, report)` → `{ described, undescribed, unknownReferences, notes }`
   for the admin UI.

**Admin UI** — a "Sync from model" button on the report editor, the last-synced
stamp, and the reconciliation report rendered inline.

**`schemaContext()` in `lib/chatHelpers.js`** — the single integration point.
Returns the merged card when metadata exists, and today's behaviour byte for
byte when it does not. Five prompts consume this function; none of them
change.

### The merged card

```
SEMANTIC MODEL — It Service Ticket Overview
Read from the model on 2026-09-18. Names and types are exact — use them verbatim.

TABLES
  'DataTable'                     Import
  'Date'                          Import · date table

RELATIONSHIPS
  'DataTable'[Date Received] *[<-]1 'Date'[Date]   (active, single direction)

MEASURES
  [1_ Total Interactions]         Integer
      Every ticket received, regardless of outcome.
  [2_ Breaches (Outside SLA)]     Integer · format "0"
      (no description)

COLUMNS
  'DataTable'[Interaction Type]   Text
      The channel a ticket arrived through.
  'DataTable'[Date Received]      DateTime

NOTES
  <admin prose that matched no single object, preserved verbatim>
```

`(no description)` is deliberate. A gap the model can see is a gap it can say
it doesn't know about, which is what `GROUNDING_RULE` asks of it.

### Matching

For each real object, look for its name in the admin's free text:

1. **Qualified or bracketed** — `[Name]`, `'Table'[Name]`, `Table[Name]`.
   High confidence, always matched.
2. **Bare whole-word**, case-insensitive, only when the name is 4 characters
   or longer. `Interaction Type` matches; a column called `ID` or `No` does
   not, because a bare match on those would attach unrelated prose to them.

The matched description is the line containing the reference. Where a name is
referenced on several lines, **all of them are attached, in order** — an admin
who wrote about a measure in two places meant both, and picking one silently
discards half of what they said. Lines matching no object become `NOTES` —
business rules and context are worth keeping even when they belong to no
single column.

**Unknown references** are bracketed tokens in the admin text that match no
real object. These are the drift detector, and they are reported to the admin
but **never rendered into the card** — repeating a name that does not exist is
precisely the behaviour this design removes.

### Budget

A wide model would otherwise flood every prompt. The card is capped by a new
`BUDGETS.MODEL_CARD_CHARS = 20000`, rendered in order of value: tables,
relationships, measures, then columns grouped by table. Columns truncate
first — they are the most numerous and the least individually load-bearing —
and the card states how many were omitted rather than ending mid-list.

20,000 sits against the existing `STATE_CHARS: 40000` for captured screen
state, and comfortably fits the probed model whole (13 measures, 36 columns).
It is a ceiling for pathological models, not a target.

### Failure and fallback

- A sync failure shows the error in admin and **retains the previous
  metadata**. A failed refresh must not leave a report worse off than before
  it was attempted.
- With no metadata, `schemaContext()` behaves exactly as it does today.
- Chat is never blocked by metadata being absent, stale or unfetchable.
- `hasChat` gating is **unchanged** — still `datasetId && schemaDescription`.
  Metadata is additive here. Making chat availability depend on a successful
  fetch is a bigger decision and is deliberately not taken in this design.

### Testing

`executeQuery` is stubbed throughout; no test touches Power BI.

- **`modelMetadata`** — normalisation and filtering, using fixture rows copied
  from the real probe output, including the `RowNumber-…` column and the
  hidden `DateAutoTemplate` table that must be excluded.
- **`modelCard`** — each matching form (bracketed, qualified, bare, too-short
  bare, no match); unknown references detected and excluded from the card;
  leftover prose preserved as notes; budget truncation states what it dropped.
- **`schemaContext`** — renders the card when metadata is present; falls back
  to today's exact output when it is not.

## Not in this design

- **Distinct filter values.** `INFO` cannot say that `Interaction Type`
  contains "Calls"/"Chats"/"Emails". That needs `DISTINCT()` queries against
  the data and is a separate piece of work, worth doing next.
- **Replacing the admin description fields.** They carry the only business
  meaning in the system.
- **Auto-refresh.**

## Follow-on this unlocks

`FormatString` is the definitive percentage signal. The chart format hint
shipped on 2026-09-17 currently asks the DAX-generating model to *guess*
whether a result is a percentage, with what decimal precision and at what
scale. Where a measure carries `FormatString` such as `"0.00%"`, that guess
can be replaced by fact. Deliberately out of scope here — it belongs after the
metadata exists and is trusted — but it is the clearest win sitting behind
this work.
