# Real DAX in the model card, read from the semantic model's own definition

**Status:** design, approved in principle, not yet planned
**Date:** 2026-09-18

## The problem

The model card (`lib/modelCard.js`, shipped earlier today) already carries a
per-measure `expression` field — but it is always `null`. `executeQueries`,
the Power BI REST API this app already uses for `INFO.VIEW.*` DAX, redacts
`Expression` unconditionally as an anti-exfiltration measure; no permission
grant changes that (confirmed by probe — see below). The AI writing DAX today
has the measure's name, type and format string, but never sees how an
existing measure is actually computed, so it cannot follow the model's own
conventions or reuse logic correctly. Calculated columns are invisible in the
same way: `INFO.VIEW.COLUMNS()` doesn't even carry an expression field today,
so a column like `Year = YEAR(Data[Date])` looks identical to an ordinary
imported column.

## What we can actually read

The tenant now has a Fabric trial capacity, and the service principal has
been granted `Dataset.Read.All` / `SemanticModel.Read.All` — Fabric API
permissions (`api.fabric.microsoft.com`), distinct from the classic Power BI
REST API this app already calls (`api.powerbi.com`). These unlock **Get
Semantic Model Definition** (`POST
.../workspaces/{id}/semanticModels/{id}/getDefinition`), which is a
different mechanism entirely: not a query, but an export of the model's
actual definition file.

Three things were confirmed live against the trial capacity, each a
throwaway probe, none kept:

1. **The permission chain works end to end.** A Fabric-scoped AAD token
   (`https://api.fabric.microsoft.com/.default`, same client-credentials
   flow, different scope) successfully calls `getDefinition`.
2. **It is a long-running operation.** The call returns `202` with a
   `Location` header; polling that URL eventually returns `Succeeded`, then a
   `/result` fetch returns the payload. Took roughly 10 seconds end to end
   against the trial dataset.
3. **`?format=TMSL` returns a single `model.bim` JSON file** instead of a
   folder of TMDL text files (the default). This is the standard, documented
   AMO/TMSL schema: `model.tables[].measures[].expression`,
   `model.tables[].columns[].expression` (present only when
   `type: "calculated"`), and `model.relationships[]` with
   `fromTable`/`fromColumn`/`toTable`/`toColumn`/`crossFilteringBehavior`.
   Confirmed against the trial model: `DISTINCTCOUNT(Data[Console])` came
   back verbatim as a measure's `expression`, and a calculated column's
   `Year = YEAR(Data[Date])` came back the same way.

The TMSL payload also contains each table's `partitions` (the full
Power-Query/M source — in the probed model, this included a local file path:
`C:\Users\...\Analytics Corper Data Challenge.csv`), plus `dataSources`,
`roles`, and `perspectives`. **None of this is read.** Only the three
whitelisted shapes above are extracted; everything else in the payload is
never parsed, stored, or logged.

## Approach

**Fetch TMSL, extract a narrow whitelist, merge into the existing metadata
shape.** No new storage, no new prompt integration point.

Two alternatives considered and rejected:

- **Parse the default TMDL text format instead of requesting TMSL.** TMDL is
  a real grammar (indentation-significant blocks, multi-line expression
  continuations) that would need its own parser. TMSL is flat JSON matching
  a schema Analysis Services has published for a decade. Confirmed via probe
  that `?format=TMSL` is a supported, documented conversion — there is no
  reason to write a parser when the API converts for us.
- **Store and eventually surface the full TMSL/M-query definition** (for a
  future model-review/audit feature). Explicitly out of scope — the earlier
  brainstorming conversation scoped this work to DAX-generation grounding
  only, sequenced before any review-feature work. The M-query source is
  discarded specifically because it isn't useful for DAX generation and can
  carry local file paths or other author-environment detail that has no
  business reaching an AI prompt.

## Design

### New component: `lib/modelDefinition.js`

Acquisition only, mirroring `lib/modelMetadata.js`'s shape and contract:

```
async function fetchModelDefinition(credentials, { workspaceId, datasetId }) {
  // -> { measures: [{name, expression}], columns: [{name, table, expression}],
  //      relationships: [{fromTable, fromColumn, toTable, toColumn, isActive,
  //      crossFilteringBehavior}] }
  // -> null on ANY failure: no Fabric permission, non-Fabric-capacity
  //    workspace, LRO timeout, malformed response. Never throws.
}
```

Internals:

- A second AAD token scope (`https://api.fabric.microsoft.com/.default`),
  requested and cached independently of the existing Power BI token — they
  are different resources and must not share a cache entry.
- `POST .../getDefinition?format=TMSL`. On `200`, use the body directly. On
  `202`, poll `Location` (honouring `Retry-After`) up to a hard ceiling —
  proposed **90 seconds total**, since this runs synchronously inside an
  admin's "Sync from model" click, which already does four sequential DAX
  queries. Exceeding the ceiling returns `null`, exactly like any other
  failure.
- Decode the `model.bim` part (base64 → JSON), then extract **only**:
  - `model.tables[].measures[]` → `{name, expression}`
  - `model.tables[].columns[]` where `type === "calculated"` → `{name,
    table, expression}` (an ordinary imported column has no `expression` in
    TMSL and contributes nothing here)
  - `model.relationships[]` → `{fromTable, fromColumn, toTable, toColumn,
    isActive: !== false, crossFilteringBehavior}`
- Everything else in the parsed JSON (`partitions`, `dataSources`, `roles`,
  `perspectives`, `annotations`, `cultures`) is discarded at the point of
  extraction — never assigned to a variable that outlives the function,
  never logged.

### Merge point: the sync route

`routes/admin.js`'s existing `POST /reports/:id/sync-model` (built earlier
today) already orchestrates `fetchModelMetadata` → `setModelMetadata`. This
adds one more best-effort step in between: call `fetchModelDefinition`
(independently — its failure must never affect the `fetchModelMetadata`
result), and where it succeeds, overlay real `expression` values onto the
metadata by matching measure/column name before the JSONB is stored. Where
`fetchModelDefinition` returns `null`, the sync proceeds exactly as it does
today — `expression` stays `null`, nothing else changes. The sync
response's `counts` gains two fields, `measuresWithExpression` and
`calculatedColumnsWithExpression`, so an admin can see from the existing
panel whether the DAX enrichment actually took, rather than needing server
logs to tell a permission problem from a non-Fabric workspace.

`lib/modelMetadata.js`'s `normalise()` shape gains one addition:
**calculated columns now carry an `expression` field** (currently absent
entirely from the column shape, since `INFO.VIEW.COLUMNS()` was never asked
for one) — `null` until a definition merge sets it, same convention as the
existing measure `expression` field.

No new database column. The merged `expression` values live inside the
existing `model_metadata` JSONB exactly like every other field.

### Rendering: `lib/modelCard.js`

`render()`'s per-measure and per-calculated-column entries gain one more
line, placed between the name/type line and the description line(s) — the
same relative position an admin's description already occupies:

```
MEASURES
  [Number of Console]  Integer · format "0"
      = DISTINCTCOUNT(Data[Console])
      (no description)

COLUMNS
  'Data'[Year]  Int64 · format "0"
      = YEAR(Data[Date])
      (no description)
```

An ordinary (non-calculated) column renders exactly as it does today — no
blank `= ` line, since it has no expression to show.

Relationships gain a `(bidirectional)` tag, alongside the existing
`(inactive)` tag, when `crossFilteringBehavior` reports both-directions
filtering — this changes what DAX is correct to write (ambiguous filter
propagation, when `USERELATIONSHIP` is needed), so it belongs in the card
regardless of whether the admin ever thinks to mention it.

**`lib/answer/dax.js` (the DAX generator) needs no changes.** It already
consumes `schemaContext()` — the single integration point — which now
happens to contain real formulas. This is the same "five prompts, none of
them change" property the model-card feature established, extended rather
than broken.

### Failure and fallback

Same standing rules as the model-card feature, extended to cover this:

- `fetchModelDefinition` never throws; any failure (no Fabric permission,
  non-Fabric-capacity workspace, LRO timeout, malformed payload) resolves to
  `null` and is logged, matching `fetchModelMetadata`'s existing contract.
- A definition-fetch failure **does not fail the sync**. The route's
  existing "write nothing on total failure" rule applies only to
  `fetchModelMetadata` returning `null` (a report has no usable metadata at
  all); a definition failure alongside a successful `fetchModelMetadata`
  still stores good INFO.VIEW-only metadata, exactly as it does today for a
  non-Fabric workspace.
- `render()`/`reconcile()` gain no new field they don't already guard —
  `expression` is read defensively (`item.expression &&
  ...`), so a metadata row saved before this feature shipped (no
  `expression` key on its columns at all) renders identically to one saved
  after it, with the field simply absent.
- The existing `schemaContext()` try/catch (added in the earlier
  whole-branch review's fix wave) already covers any render failure here —
  no new catch needed.

### Testing

`fetch` is stubbed throughout; no test touches Power BI or Fabric.

- **`modelDefinition`** — the 200-immediate path; the 202→poll→`Succeeded`→
  `/result` path; a poll that never resolves within the ceiling → `null`; a
  token request that fails → `null`; a malformed/missing `model.bim` part →
  `null`; the field whitelist itself (a measure's `expression` extracted, a
  non-calculated column contributing nothing, a calculated column's
  `expression` extracted, relationship fields extracted including
  `crossFilteringBehavior`); confirms `partitions`/`dataSources` never reach
  the returned shape even when present in the fixture payload.
- **`modelMetadata`** — merge behaviour: a definition present overlays
  `expression` by name match; a definition absent (`null`) leaves the
  existing INFO.VIEW-only shape completely unchanged, same output as before
  this feature existed.
- **`modelCard`** — a measure/calculated-column with an `expression` renders
  the `= ...` line in the right position; one without renders exactly as
  today; a bidirectional relationship gets the new tag; an inactive one
  keeps its existing tag; both tags never co-occur incorrectly.

## Not in this design

- **A model-review/audit feature.** Explicitly sequenced after this, per the
  brainstorming conversation — this design is DAX-generation grounding only.
- **Storing or ever surfacing the Power-Query/M source.** Discarded at
  extraction, not merely unused.
- **Relationship reconciliation between the two sources.** `INFO.VIEW.RELATIONSHIPS()`
  already renders a relationship as a ready-made string; TMSL's
  `crossFilteringBehavior` is additive (one new tag), not a replacement for
  it.
- **RLS roles, perspectives, hierarchies, calculation groups.** Present in
  the TMSL payload, not extracted. Out of scope for DAX-generation grounding;
  revisit if a model-review feature is scoped later.
