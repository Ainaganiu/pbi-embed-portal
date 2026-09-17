# AI chat: model-led routing, one chart producer, one interaction layer

Date: 2026-09-17
Status: approved, not yet implemented

## Problem

The chat panel works, but three things hold it back.

**Routing is a regex in the browser.** `public/app.js:47-70` decides whether a
question is answered from the screen, from a DAX query, or as an authoring
request, using three regular expressions and a fallback of "six words or fewer
means screen". A misroute produces the wrong *kind* of answer, not a slightly
worse one.

**Charts are produced two ways.** The escalation path builds specs in code
(`buildChartSpec`); `/api/chat` asks the model for a spec in JSON and then
partially overrides it. The same rows can yield different charts. The model
also drops the chart line from its JSON often enough that `chartChoice.js`
already records it as the reason the code path exists.

**Charts are drawn at a fixed height.** `public/app.js:824` passes
`min(width * 0.72, 260)` whatever the data is, so a fifteen-row horizontal bar
chart gets about eleven pixels per row. This is the reported defect.

Underneath all three: streaming, progress, cancellation and error handling
exist on one path and not the others, because there are three endpoints.

## Approach

One SSE front door. The browser captures report state and posts a single
request; the server asks a small model call which path to take, then dispatches
to the existing pipelines. Cross-cutting concerns — streaming, stages,
cancellation, error translation, chart attachment — are implemented once.

Rejected: a routing call in the browser leaving three endpoints (the
cross-cutting work would be done three times); a single agentic tool loop
(larger rewrite, slower, and the three pipelines are already good at their
jobs); no router at all with the screen path handing off (puts the slow path in
front of the fast one).

## Architecture

### Routes and modules

`routes/chat.js` owns `POST /api/chat` and always responds as
`text/event-stream`. The three pipelines move out of `server.js`:

```
lib/answer/screen.js      run(ctx, emit)   from app.post("/api/chat/visual")
lib/answer/query.js       run(ctx, emit)   from app.post("/api/chat")
lib/answer/authoring.js   run(ctx, emit)   from routes/authoring.js
lib/route.js              chooseRoute(...) model router + regex fallback
lib/errors.js             describe(err)    failure -> {message, hint, retryable}
lib/budgets.js            every size and token cap, in one place
```

`server.js` keeps app wiring, branding, reports and embed tokens. It drops from
roughly 1,050 lines to a few hundred. The clarify handling currently duplicated
at `server.js:497` and `server.js:717` collapses into one implementation in
`routes/chat.js`.

`POST /api/chat/visual` and `POST /api/chat/authoring` are removed. They have
no consumers outside `public/app.js`, which changes in the same commit.

`POST /api/chat` keeps its path but not its contract: it returned a single
JSON body and now always returns an event stream. This is a breaking change to
anything calling it directly; nothing outside `public/app.js` does.

**Response cache.** `lib/llmCache.js` currently caches the whole `/api/chat`
JSON body for a repeated standalone question. It keeps that job, moved behind
the front door: the cache is consulted in `lib/answer/query.js` after routing,
and a hit is emitted as one delta plus a `done` frame so the SSE contract holds
either way. Screen-path answers are not cached — they depend on filter and
slicer state that the cache key does not capture.

### The router

`chooseRoute({ question, history, pageName, visualTitles, filterSummary,
schemaOutline, hasDataset })` makes one provider call and returns:

```json
{ "path": "screen" | "query" | "authoring",
  "focusVisual": "<visual name>" | null,
  "confidence": "high" | "low",
  "reason": "<one short line>" }
```

- `maxTokens: 400`, no extended reasoning. Target under one second.
- `schemaOutline` is table, column and measure *names* only, capped — the
  router decides a path, it does not write a query.
- `focusVisual` replaces the client-side `matchVisual` title scoring. The
  router sees the titles, so it can identify the visual a question points at
  without the 0.7-word-overlap heuristic.
- `confidence: "low"` is routed to `screen`. This preserves the existing
  principle: describing the wrong thing is cheaper to recover from than
  quoting a confidently wrong number.
- `hasDataset` false (report has no dataset id or no schema description)
  forces `screen`, since `query` and `authoring` cannot run.

**Fallback.** If the call fails, times out, or returns something that does not
validate against the shape above, `lib/route.js` falls back to the regexes
moved from `public/app.js` — `AUTHORING`, `SCREEN_REFERENCE`, `OPEN_ENDED`,
`SPECIFIC_QUESTION` and the six-word rule — unchanged in behaviour and unit
tested. A router outage degrades to today, not to nothing.

### Client flow

`public/app.js` on submit:

1. Capture report state via `captureReportState(null)` — always, for every
   question, with no focus visual yet. The calls inside it are already
   parallelised, and this overlaps the network, so it adds no wall-clock for
   the paths that need it and a small client-side cost for those that do not.
2. `POST /api/chat` with `{ reportId, question, state, history }` and an
   `AbortController` signal.
3. Render SSE events.

`isVisualQuestion`, `isAuthoringQuestion`, `matchVisual`, `titleWords`,
`refreshVisualTitles` and their regexes are deleted from the browser. The
titles are now carried inside `state`.

Because the router returns `focusVisual` *after* state was captured, the
focused visual's deeper row export cannot happen during capture. Instead
`lib/answer/screen.js` marks the named visual as the focus in the rendered
state and gives it the larger character budget. The uniform per-visual export
row count rises to compensate (see Budgets).

### SSE contract

One event vocabulary for all paths. The server emits tokens; the client owns
the wording.

```
{ "stage": "routing" | "reading" | "writing_query" | "running_query"
         | "retrying_query" | "escalating" | "validating" | "composing" }
{ "delta": "<text>" }
{ "done": true, "answer", "chart", "followUps", "questions", "clarify",
  "dax", "rowCount", "visualContext" }
{ "error": { "message", "hint", "retryable" } }
```

Client labels: routing "Working out how to answer this…", reading "Reading the
current view…", writing_query "Writing the query…", running_query "Running it
against the model…", retrying_query "Adjusting the query…", escalating "The
page can't answer that — querying the model…", validating "Checking it runs
against your model…", composing "Writing it up…".

`retrying_query` covers the self-correction at `server.js:895` — a second LLM
call and a second Power BI round trip that is currently invisible.

**Non-streaming providers.** Anthropic and Gemini have no `completeStream`.
The front door still responds as SSE and emits the finished text as a single
delta. The degradation at `server.js:745`, where those providers are told
escalation is unavailable, is removed — escalation works for them, just
without token-by-token text.

**Cancellation.** The client aborts the fetch; the server handles
`req.on("close")` by setting `ctx.aborted`, which is checked before each
provider call and each Power BI call. Cancelling stops spending, not just
displaying. The send button becomes a stop button while a request is in
flight.

## Charts

### One producer

`buildChartSpec(question, rows, { intent, caption })` in `lib/chartChoice.js`
is the only source of chart specs, on every path.

The answer call in `lib/answer/query.js` no longer emits a `chart` object. Its
JSON becomes `{ answer, followUps, intent }` where `intent` is one of
`share | change | trend | ranking | single`. `chooseChartType` consumes
`intent` in place of the `SHARE_QUESTION` and `CHANGE_QUESTION` regexes, which
are deleted. An absent or unrecognised `intent` is treated as no hint, and the
shape-based rules decide alone.

The `fixed` flag in `chooseChartType` stays: shape-determined cases (a single
value is a card; time is vertical) still override the hint.

### Height from content

`renderChart(container, spec, { width, maxHeight })`. The `height` option is
gone. Each renderer computes its own:

- `bar`, `variance`: `rows * 28 + margins`, minimum 120.
- `column`: aspect-based, but if the computed band width falls below the
  readable threshold the spec is re-rendered as `bar`.
- `line`: `width * 0.5`, clamped.
- `donut`: driven by legend row count.
- `card`: 120, unchanged.
- `table`: natural height, scrolling within `maxHeight`.

`maxHeight` is advisory: a chart taller than it scrolls within the figure
rather than being compressed. `public/app.js` passes width and `maxHeight`
only.

### Too many categories

Above 18 categories, `buildChartSpec` sorts descending by the plotted measure,
keeps the top 15, and sets `truncated: { shown: 15, total: 37 }`. The renderer
prints "top 15 of 37" as a caption. The full set stays reachable through the
enlarge modal and the CSV download.

This applies to the produced spec, not to the rows sent to the model — the
model still sees the full result set up to the row budget.

### Always readable

If direct value labels do not fit — the `x1.bandwidth() > 22` condition at
`charts.js:218` and its equivalents — the renderer draws a minimal three-tick
y-axis with a hairline rather than omitting values entirely. The current
behaviour yields a chart with no numbers anywhere, because IBCS has already
removed the axis and the gridlines.

### Correctness fixes

- `bar` and `column` scale domains become `d3.extent` widened to include zero,
  with a zero line drawn when the minimum is negative. Today the domain is
  `[0, max]`, so negative values render as zero-width.
- Category labels truncate to the label gutter with an ellipsis and carry a
  `<title>` with the full text. Today a long name is clipped by the SVG edge
  and is simply gone.

### Controls

Each figure gets a toolbar: chart-type switcher, CSV download, PNG download,
enlarge. The type switcher offers only types valid for that data shape — the
validity test is a new export from `lib/chartChoice.js`, shared so the browser
and server agree. A manual choice applies to that figure only and is not
persisted.

A `ResizeObserver` on the chat log re-renders each figure from its stored spec
when the panel is dragged. Today a chart keeps the width it was born at.

## Interaction

### Errors

`lib/errors.js` maps failures to `{ message, hint, retryable }`:

| failure | message | hint |
|---|---|---|
| AAD token expired / 401 from Power BI | Lost the connection to Power BI | Reload the page |
| dataset or workspace not found | Can't reach this report's data | Check the report's IDs in admin |
| DAX rejected after the retry | Couldn't write a query that runs | The report's data description may be out of date; query shown below |
| provider rate limit | The AI service is busy | Retry in a moment (retryable) |
| provider auth failure | The AI service rejected the key | Check the API key in admin |
| anything else | Something went wrong answering that | raw message under details |

The raw error stays available under a "details" disclosure and in the server
log. It stops being the headline.

### Clarify

Alongside Continue, a "Just choose for me" button resends the original
question with an appended instruction to take the most reasonable reading and
state the assumption in the first line of the answer. Today an ambiguous
question is a hard stop until the user engages with the chips.

Everything else about the clarify block — multi-select questions, the
`n of m` Continue label, resending the original question with the answers
appended after an em dash — is unchanged.

### Openers

`GET /api/chat/starters/:reportId` returns four short starter questions
generated from the report's schema description and problem statement. Cached
per report in memory, invalidated when that report is saved through `/admin`.
On any failure, the four hardcoded questions at `index.html:91-94` are used —
they become the fallback rather than the default.

## Budgets

All caps move to `lib/budgets.js`. New values:

| cap | now | after |
|---|---|---|
| chars per context visual | 300 | 1,200 |
| chars for the focused visual | 1,800 | 6,000 |
| total rendered screen state | 7,500 | 40,000 |
| visuals in prompt | 25 | 25 (unchanged) |
| export rows per visual | 10 context / 50 focus | 30 uniform |
| result rows into the answer | 50 | 500 |
| result chars | 20,000 | 120,000 |
| exchanges sent to the model | 4 | 10 |
| history messages accepted | 8 | 20 |
| chars per remembered turn | 1,500 | 4,000 |
| exchanges kept in localStorage | 15 | 40 |
| `maxTokens`, analysis calls | 5,000 | 16,000 |
| `maxTokens`, router | — | 400 |

`reasoning: "low"` extends from escalation only to all DAX generation and to
the composing call. The 90-word and 110-word answer ceilings are unchanged:
this is thinking room, not licence to write more.

Row truncation stops being silent. When a result exceeds the row budget, the
answer prompt is told how many rows were dropped and instructed to say so, and
the chart caption carries the same note.

**Cost note.** The screen-state caps are paid on every question on the screen
path, not only on hard ones. A busy page at 25 visuals and 1,200 characters
each is a materially larger prompt every turn. Keeping the caps in one module
means they can be dialled back from one file.

## Testing

`npm test` runs `node --test "test/*.test.js"`. Existing suites for
`chartChoice`, `daxLint` and markers keep passing unchanged except where
`chartChoice`'s signature changes.

New unit tests:

- `lib/route.js` fallback: each regex branch and the six-word rule, asserting
  the behaviour matches the deleted browser code.
- `lib/route.js` response handling: valid payload, malformed JSON, unknown
  `path` value, missing fields, `hasDataset` false forcing `screen` — each
  falling back correctly.
- `buildChartSpec` with each `intent`, and with `intent` absent or unknown.
- `buildChartSpec` truncation: sort order, `shown`/`total`, and that fewer
  than 18 categories are untouched.
- Chart geometry, extracted from `charts.js` into a pure testable module:
  height for row count, the label-fit decision, label truncation.
- `lib/errors.js`: each mapped failure and the unmapped default.

The d3 drawing itself stays unverified except by eye.

## Out of scope

RLS-aware embed tokens; multi-tenant or per-user report visibility; an
agentic tool loop; embed-token auto-refresh; persisting a user's manual chart
type choice.
