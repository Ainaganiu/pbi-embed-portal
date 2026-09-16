// Power BI authoring knowledge the assistant draws on.
//
// Split into two pieces on purpose:
//
// - CORE_RULES is short and goes into every DAX generation call. It encodes
//   the mistakes that actually broke queries against these reports, so it
//   earns its place in the prompt despite costing prefill on every question.
//
// - PATTERNS is the larger library and is only loaded on the authoring path,
//   where the user is asking how to build something. Keeping it out of the
//   hot path matters: response time scales with how much the model is handed.

const CORE_RULES = `
DAX correctness rules:
- Quote table names in single quotes: 'Table'[Column].
- A boolean filter passed to CALCULATE must compare ONE column to a value.
  'T'[Col] = "X" is valid; YEAR('T'[Date]) = 2023 is not — wrap that in
  FILTER('T', YEAR('T'[Date]) = 2023).
- Filter dates through the model's date dimension ('Date'[Year]) rather than
  applying YEAR()/MONTH() to a fact-table column; it keeps time intelligence
  working and is far faster.
- Use DIVIDE(a, b) instead of a / b — it returns BLANK on divide-by-zero
  instead of erroring.
- Use only tables, columns and measures that exist, spelled exactly as given,
  including any numeric or underscore prefixes.
- SUMMARIZECOLUMNS takes its arguments in a fixed order: group-by columns
  first, then any FILTER tables, then the "Name", expression pairs last.
  Putting a FILTER after a name/expression pair fails with "expects a column
  name as argument number N".
- Don't name a VAR after a DAX keyword or function. "Current" in particular is
  rejected by the engine; use Cur, Curr or ThisPeriod instead. The same applies
  to Date, Value, Filter, Order, Rank, Min, Max, Sum and Average.
`.trim();

const PATTERNS = `
Authoring guidance.

Measure vs calculated column:
- Measure: aggregates, evaluated in the filter context of the visual. Nearly
  always the right choice for anything summarised. Costs no model storage.
- Calculated column: computed row by row at refresh and stored in the model.
  Use only when the value must be sliced, filtered or used on an axis.
- Rule of thumb: if it's a number in the values well, make it a measure.

Variables — prefer them for anything non-trivial:
  Sales YoY % =
  VAR Current = [Total Sales]
  VAR Prior = CALCULATE([Total Sales], SAMEPERIODLASTYEAR('Date'[Date]))
  RETURN DIVIDE(Current - Prior, Prior)
Variables are evaluated once, make intent readable, and avoid repeating an
expensive expression.

Time intelligence (all require a marked date table):
- Prior year:    CALCULATE([M], SAMEPERIODLASTYEAR('Date'[Date]))
- Year to date:  CALCULATE([M], DATESYTD('Date'[Date]))
- Rolling 12m:   CALCULATE([M], DATESINPERIOD('Date'[Date], MAX('Date'[Date]), -12, MONTH))
- Running total: CALCULATE([M], FILTER(ALLSELECTED('Date'[Date]), 'Date'[Date] <= MAX('Date'[Date])))

Share of total — remove the filter you're comparing against:
  % of Total = DIVIDE([Total Sales], CALCULATE([Total Sales], ALLSELECTED('Data'[Category])))
Use ALL to ignore every filter, ALLSELECTED to respect outside slicers.

Ranking:
  Rank = RANKX(ALLSELECTED('Data'[Game]), [Total Sales], , DESC, DENSE)
For a top-N table use TOPN; for a top-N measure, wrap with RANKX and filter.

Conditional / threshold logic:
  Within SLA % = DIVIDE(CALCULATE(COUNTROWS('T'), 'T'[Within SLA] = "Yes"), COUNTROWS('T'))

Common mistakes to call out when reviewing someone's DAX:
- Filtering on a measure inside CALCULATE's boolean argument (not allowed).
- Using a calculated column where a measure belongs — bloats the model and
  breaks slicing.
- FILTER over a whole fact table when a column predicate would do; FILTER is
  row-by-row and much slower.
- Missing a date table, so time intelligence silently returns blank.
- Nested IF chains that SWITCH(TRUE(), …) would express more clearly.
`.trim();

module.exports = { CORE_RULES, PATTERNS };
