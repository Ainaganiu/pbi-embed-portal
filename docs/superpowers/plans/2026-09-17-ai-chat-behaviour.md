# AI chat behaviour: answering like an analyst

## Context

The 2026-09-17 spec (`docs/superpowers/specs/2026-09-17-ai-chat-ux-design.md`) and its 15-task plan fix the *plumbing*: one SSE front door, a model router, one chart producer, content-driven chart height, error mapping, cancellation. That work makes the chat correct and consistent. It does not make it **good**.

What is still missing is judgement. Today the assistant:

- pads a one-number answer to ~90 words because the prompt demands a headline, a context sentence and a `"What this means:"` line regardless of what was asked
- draws a chart for almost anything that returns rows, including a card restating the number the sentence just gave
- spends the same thinking on "what was total revenue" as on "why did Q3 drop"
- treats each turn as fresh — it re-reads the page and re-derives context the previous turn already established
- never says "I'm not sure", never flags that a number is filtered, never volunteers the caveat an analyst would lead with

This plan adds the behaviour layer on top of Tasks 1–15: **tiered reasoning**, **adaptive answer registers**, **chart-when-it-earns-it**, **conversational memory that carries analytical context**, and **calibrated honesty**. The target is an assistant that reads like someone five years into the job — brief when the answer is simple, careful when it isn't, and never confidently wrong.

**Depends on:** Tasks 1–15 of `docs/superpowers/plans/2026-09-17-ai-chat-ux.md` landing first. This plan's tasks are numbered 16–24 and assume `routes/chat.js`, `lib/route.js`, `lib/answer/*.js`, `lib/budgets.js`, `lib/errors.js` and `public/chartGeometry.js` exist.

---

## Decisions taken

| Question | Decision |
|---|---|
| Relationship to existing plan | Layer on top. Tasks 16–24, no rework of 1–15. |
| Where reasoning cost goes | Tiered. The router emits an effort level alongside the path; simple lookups stay as fast as today. |
| Answer length | Adaptive, three registers. The ceiling rises only for genuine analysis. |
| Chart policy | Chart when it adds meaning. Decided in `lib/chartChoice.js`, testable, not model judgement. |

---

## Global constraints

Unchanged from the existing plan, repeated because they bind here too:

- CommonJS only. No new npm dependencies. No build step.
- Tests are `node --test`, `test/*.test.js`, `node:test` + `node:assert`.
- Browser code is plain ES2020 in IIFEs attaching to `window`.
- **British English** in all user-facing copy.
- Comments explain *why*, not *what*.
- IBCS chart rules are non-negotiable: vertical for time, horizontal for structure, colour reserved for variance.
- Every commit ends with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

Each task is a full TDD cycle: failing test → run → implement → run → commit.

---

## Task 16 — Effort tiers on the router

**Why:** The OpenAI adapter's own comment records 9.6s with reasoning against 4.2s without (`lib/llm/openai.js:20-21`). Paying that on "what was total revenue" is waste; not paying it on "why did margin fall" is the reason answers read shallow. The router already reads the question, the history and the schema outline in order to pick a path — it is the only place that knows enough to also price the answer, and it costs nothing extra to ask for one more field.

**Files:** `lib/route.js`, `lib/budgets.js`, `test/route.test.js`

`chooseRoute` gains a third field in its return shape:

```js
{ path, focusVisual, confidence, reason, effort }   // effort: "fast" | "standard" | "deep"
```

Tier definitions, added to `lib/budgets.js` as a frozen `EFFORT` map:

| tier | reasoning | answer maxTokens | when the router picks it |
|---|---|---|---|
| `fast` | none | 2,000 | a single figure, a lookup, a restatement, a confirmation |
| `standard` | `"low"` | 8,000 | a comparison, a ranking, a breakdown, a trend — the default |
| `deep` | `"medium"` | 16,000 | why / cause / driver / anomaly / "what should we do" / multi-step |

Router prompt addition (append to the existing path instructions):

> Also say how much thinking this question is worth.
> `"fast"` — the answer is one number or one fact; there is nothing to work out once the data is in hand.
> `"standard"` — the answer needs a comparison, a ranking or a shape read, but the method is obvious.
> `"deep"` — the answer needs you to work something out: a cause, a driver, an anomaly, a recommendation, or several steps chained together.
> Most questions are `"standard"`. Do not use `"deep"` for a question that is merely long.

**Guards** (all in `lib/route.js`, tested):

- An unrecognised or missing `effort` normalises to `"standard"`, never to `"deep"` — an unparseable router response must not silently double the bill.
- `fallbackRoute` always returns `"standard"`. The regexes cannot judge depth, and guessing `fast` there would make an outage degrade to *worse* than today.
- The authoring path forces `"standard"` regardless of what the router says — measure authoring has a fixed method and a validation round trip already.

**Tests:** each tier round-trips; unknown string → `standard`; missing field → `standard`; fallback → `standard`; authoring path → `standard` even when the router said `deep`.

---

## Task 17 — Effort reaches the pipelines

**Why:** Task 16 produces the number; nothing consumes it yet. The tier has to reach both the DAX call and the composing call, because a `deep` question needs the thinking in the *answer*, not in the query generation — the query for "why did Q3 drop" is usually simple, the interpretation is not.

**Files:** `lib/answer/query.js`, `lib/answer/screen.js`, `lib/answer/authoring.js`, `routes/chat.js`

`ctx` gains `ctx.effort`, set in `routes/chat.js` from `route.effort`. Each pipeline reads `BUDGETS.EFFORT[ctx.effort]` and applies:

- `reasoning` on the **composing / answer** call (the DAX generation call keeps `reasoning: "low"` at every tier — writing a query is not the hard part, and a slow query generation delays the first token)
- `maxTokens` on the composing call
- the answer register (Task 18) selected by the same tier

The `stage` emitted for a `deep` question becomes `"reasoning"` rather than `"composing"`, so the client can say "Working through it…" instead of "Writing it up…". A 10-second wait with an honest label reads as care; the same wait under "Writing it up…" reads as a hang.

Client label addition in `public/app.js`: `reasoning` → "Working through it…".

**Tests:** a `deep` ctx produces a request with `reasoning: "medium"` and `maxTokens: 16000`; a `fast` ctx produces no `reasoning` key and `maxTokens: 2000`; DAX generation is `"low"` at all three tiers.

---

## Task 18 — Three answer registers

**Why:** The current data-path prompt (`server.js:947-955`, moving to `lib/answer/query.js` in Task 7) mandates a bolded headline, one to two sentences of context, and a closing `"What this means:"`. That is the right shape for an analytical question and the wrong shape for "how many orders last month" — where it produces a bolded number, a sentence restating the number, and a "what this means" that means nothing. Users read the padding as the assistant not understanding the question.

**Files:** `lib/answer/registers.js` (new), `lib/answer/query.js`, `lib/answer/screen.js`, `test/registers.test.js`

New module exporting `registerFor(effort)` returning the prose contract to splice into the answer prompt:

**`fast` — the direct answer.**
> Answer in one sentence, leading with the figure. Add a second sentence only if the number is meaningless without a qualifier (the period it covers, the filter in force, a unit that isn't obvious). Do not add a headline, do not add a "what this means". Under 35 words.

**`standard` — the finding.** (today's shape, kept)
> Open with the finding in bold on its own line. Then one or two sentences citing the actual figures, with the comparison or context that makes them mean something. Close with one sentence beginning "What this means:". Under 90 words.

**`deep` — the read.**
> Open with the finding in bold on its own line. Then set out what the data shows, what drives it, and what is uncertain about that reading — in that order, as flowing prose or at most three short bullets. Name the figures you are reasoning from. If two readings of the data are both defensible, say so and say which you favour and why. Close with one sentence beginning "What this means:". Under 180 words.

**Shared across all three** (appended by `registerFor` in every case):

> Write plain business English. Thousands separators on every figure. Never state a number that is not in the data you were given. If the data does not answer what was asked, say that plainly first — do not answer a nearby question instead and leave the user to notice.

The 180-word ceiling on `deep` is the only ceiling that rises. The existing spec's note holds: raised `maxTokens` is thinking room, not licence to write more — the extra tokens are spent in reasoning, and the visible answer grows only for the questions that genuinely have more to say.

**Tests:** `registerFor` returns distinct text per tier; every tier's text contains the shared honesty clause; an unknown tier falls back to `standard`.

---

## Task 19 — Chart only when it adds meaning

**Why:** `chooseChartType` currently answers "which chart" and never "whether". So a one-row result becomes a card that restates the sentence above it, and a three-row result becomes a bar chart with three bars, both of which a reader's eye skips. A chart earns its place when the shape carries something the sentence cannot: a ranking's spread, a trend's turn, a share's balance, a comparison's gap.

**Files:** `lib/chartChoice.js`, `test/chartChoice.test.js`

New export `shouldChart(rows, intent, question)` → `{ chart: boolean, reason: string }`, consulted by `buildChartSpec` before anything else. Returns `false` for:

1. **A single value**, unless the question explicitly asked for a chart or a card (`/\b(chart|graph|plot|show me|visuali[sz]e)\b/i`). The number belongs in the sentence.
2. **Two or three categorical rows** with one measure, *unless* `intent === "share"` — "63% against 37%" reads better as a sentence than as two bars, but a share of a whole is exactly what a donut is for.
3. **No numeric column** (already handled; folded in here so there is one gate).
4. **A result the answer fully enumerates** — heuristic: row count ≤ 3 and every label appears in the answer text. Checked in `query.js` after the answer returns, not inside `buildChartSpec`, since it needs the prose.

Returns `true` otherwise. Temporal data is never suppressed — even two points over time carry a direction, and the IBCS rule that time is vertical presumes something is drawn.

`buildChartSpec` returns `null` when `shouldChart` says no, and the existing `null` handling in `renderAnswerRow` already omits the figure cleanly.

**Explicit override:** when the user asks for a chart in words, `shouldChart` returns `true` even for a single value — a card is then exactly what was requested. The regex above is the only place model judgement enters this decision, and it is applied to the *user's* words, not the model's.

**Tests:** one row one measure → no chart; same with "show me a chart of…" → card; three rows share intent → donut; three rows ranking intent → no chart; two temporal points → column; twenty rows → chart; the enumeration heuristic with a matching and a non-matching answer.

---

## Task 20 — Analytical memory across turns

**Why:** `historyForModel` (`public/app.js:457-462`) sends only `{q, answer}`, deliberately excluding charts and DAX. That was right when history existed to resolve pronouns. It is wrong now that follow-up chips actively steer users into chains: "and 2023?" arrives with no record of what filter, what grain or what measure the previous turn settled on, so the model re-derives them and often differently. The user experiences this as the assistant forgetting a decision it made thirty seconds ago.

**Files:** `public/app.js`, `lib/chatHelpers.js`, `lib/answer/query.js`, `lib/budgets.js`, `test/chatHelpers.test.js`

Each answered turn gains a **context line** — a compact statement of what that turn established, produced by the answering model as one more JSON field:

```json
{ "answer": "...", "intent": "...", "followUps": [...],
  "context": "Revenue by region, 2024 YTD, excluding internal transfers" }
```

Under 20 words, naming the measure, the grain and any filter in force. Stored alongside the turn in localStorage and sent back as part of history — as a distinct `system`-flavoured line, not folded into the answer text, so it can be shown or suppressed independently.

Server side, `sanitizeHistory` gains a `context` field (same untrusted-input treatment: string, capped at 200 chars). `lib/answer/query.js` renders prior context into the prompt as:

> Earlier in this conversation you established: <context>. If this question builds on that, carry those choices forward rather than re-deciding them. If it moves to something else, say so in your first line.

**Budget:** `HISTORY_CONTEXT_CHARS: 200`, and context lines are kept for the last 10 exchanges (matching `HISTORY_EXCHANGES_TO_MODEL`).

**Client surfacing:** the context line of the *current* turn renders as a small muted line under the answer, in the same slot as the existing `visualContext` footnote — "Revenue by region, 2024 YTD, excluding internal transfers". This makes the assistant's working assumptions visible, which is the single highest-value honesty affordance in the panel: a wrong assumption becomes correctable instead of invisible.

**Tests:** context survives sanitisation; over-long context is truncated; a missing context field doesn't break the prompt; the rendered prompt fragment is absent when no prior context exists.

---

## Task 21 — Calibrated honesty

**Why:** The prompts already forbid inventing numbers, and that holds well. What they do not do is require the assistant to volunteer what it is unsure *about*. An analyst's value is disproportionately in the caveat — "that's up 12%, but November had an extra shipping week" — and today that sentence never appears unless the data makes it unavoidable.

**Files:** `lib/answer/registers.js`, `lib/answer/query.js`, `lib/answer/screen.js`, `test/registers.test.js`

Appended to the `standard` and `deep` registers only (a `fast` lookup has nothing to caveat):

> Say what would change your answer. If the figures rest on an assumption you had to make, if a comparison is not like-for-like, if the period is incomplete, or if the result is small enough that it could be noise — say so in one clause, inside the answer, not as a disclaimer afterwards. One caveat at most, and only a real one. An answer hedged on nothing is worth less than a plain answer.

The last sentence matters: without it models produce a caveat every time, which trains users to skip them.

**Row truncation** already gets declared under the existing plan's invariant 24. This extends the same principle to three more cases handled in `lib/answer/query.js`:

- **Empty result** — say the query ran and returned nothing, and name the most likely reason from the filters applied. Never render this as an error; an empty result is an answer.
- **Filtered screen state** — when `screen.js` renders state with slicers active, the answer must name the filter in force before quoting a total. Already partly covered by the existing "Respect the current filter/slicer state" rule; promoted here from a preference to a requirement with a worked phrasing.
- **Single-row-of-many** — when the DAX returned one row because of a `TOPN` the user did not ask for, say so.

**Tests:** both registers carry the caveat clause; `fast` does not; the "one caveat at most" sentence is present wherever the clause is.

---

## Task 22 — The reasoning trace, disclosed not hidden

**Why:** A `deep` question takes ten seconds and then produces prose. The user has no way to tell whether that was ten seconds of analysis or ten seconds of stalling, and no way to check the reasoning if the conclusion surprises them. The DAX disclosure already sets the pattern — the query is there under a `<details>` for anyone who wants it, invisible to everyone who doesn't.

**Files:** `lib/answer/query.js`, `public/app.js`, `public/style.css`

On the `deep` tier only, the answer JSON gains `"workings"` — three to five short lines naming the steps taken and the figures each produced. Not the model's raw chain of thought (which is neither available on every provider nor meant for display), but a stated method:

```
Compared Q3 2024 revenue (£1,240,000) against Q3 2023 (£1,410,000) — down 12.1%
Broke the fall down by region: North −28%, others within ±4%
Checked North's order count: flat, so the fall is in average order value
```

Rendered in a `<details>` labelled "How I worked this out", placed directly beneath the answer and above the chart, styled as the existing DAX disclosure. Absent on `fast` and `standard`, where there is no method to show.

This is cheap — the model has just done the work — and it converts the slowest answers from the least trustworthy into the most.

**Tests:** `workings` present on deep, absent elsewhere; malformed `workings` (not an array, empty strings) degrades to omitting the disclosure rather than rendering an empty one.

---

## Task 23 — Chart design refinements

**Why:** Tasks 10, 11 and 13 of the existing plan fix chart *correctness* — height from content, negatives, truncation, label fit, the toolbar. What they do not address is whether a chart reads well at a glance. These are the remaining gaps found in the renderer read-through, each small and each independently testable.

**Files:** `public/charts.js`, `public/chartGeometry.js`, `public/style.css`, `test/chartGeometry.test.js`

1. **Number formatting is inconsistent.** `renderTable` does `.toFixed(1) + "%"`; `renderColumn`/`renderBar` print raw values. Add `formatValue(v, unit)` to `chartGeometry.js` — thousands separators, magnitude suffixes above 10,000 (`1.2M`, `340k`), one decimal below 10, currency symbol from `spec.unit`. Used by every renderer and by the table, so one figure never appears two ways on one screen.

2. **No emphasis in a ranking.** In IBCS a bar chart of a ranking should let the eye find the subject. Where the answer's prose names a category that appears in `spec.labels`, mark it `spec.highlight` and render that bar in `INK` with the rest at 60% opacity. This is the one place emphasis is allowed without breaking the colour rule — it is a tint, not a hue.

3. **Donut legend ordering.** Currently draws in row order. Sort slices descending by value before the pie layout so the ring reads clockwise from largest, and the legend matches — the standard convention, and the reason a donut is readable at all.

4. **Sparkline register for trivial trends.** When a temporal result has 2–4 points and the register is `fast`, render a 40px-tall inline sparkline beside the sentence rather than a full column chart. `heightFor` gains a `sparkline` type. Keeps a one-line answer one line.

5. **Empty and single-category states.** A chart that would draw one bar renders as a card instead (shape rule, `fixed: true`). A chart whose values are all zero renders the note "All values are zero" rather than a flat baseline that looks like a rendering failure.

6. **Dark mode.** `public/style.css` has no `prefers-color-scheme` block and `charts.js` hardcodes `INK #1a1a1a`. Move the five chart constants to CSS custom properties read via the existing `muted()` pattern, and add a `@media (prefers-color-scheme: dark)` token block. Scope: tokens only — no layout changes.

**Tests:** `formatValue` across magnitudes, negatives, zero, null, currency and percent units; `heightFor("sparkline", …)`; the highlight index resolver against a matching and non-matching answer; donut sort order.

---

## Task 24 — Documentation and final verification

**Files:** `README.md`, `docs/superpowers/specs/2026-09-17-ai-chat-ux-design.md`

- Add a "How answers are shaped" section to the README: the three tiers, what picks them, the three registers, and the chart-suppression rule. Someone changing a prompt needs to know a register exists before they edit around one.
- Append a "Behaviour layer" section to the design doc recording the four decisions taken here, so the spec and the code stay in step.
- Note the new honest limitation: **`deep` questions cost roughly three times a lookup** — worth stating next to the existing "chat cost scales with the page" entry.

**Verification gates:**

```
npm test          # budgets, errors, route, registers, chartChoice, chartGeometry, chatHelpers, starters, daxLint, markers
npm run check     # exit 0
```

Manual walk, four questions against a live report, each checked for the named property:

| question | expect |
|---|---|
| "what was total revenue last quarter" | `fast` tier, one sentence, no chart, sub-5s |
| "revenue by region" | `standard` tier, bar chart, headline + what this means |
| "why did North fall in Q3" | `deep` tier, "Working through it…" label, workings disclosure, a real caveat |
| "and the quarter before?" | carries the previous turn's measure and filter without re-asking; context line reflects it |

Plus: ask a question the data cannot answer and confirm the assistant says so in its first line rather than answering a nearby question.

---

## Out of scope

- An agentic tool loop (the existing spec rejected it; still rejected).
- Persisting a user's manual chart type choice.
- Server-side conversation storage (no viewer identity exists; the localStorage constraint stands).
- Multi-turn clarification chains — one clarification round remains the limit.
- Proactive insights (the assistant volunteering findings unprompted).

---

## Sequencing note

16 → 17 → 18 are a chain: the tier is produced, then routed, then consumed. 19, 20, 21 are independent of each other and can be done in any order once 18 lands. 22 depends on 17 (needs the tier). 23 is independent of everything and could be done first if you want a visible win early. 24 last.
