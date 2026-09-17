const test = require("node:test");
const assert = require("node:assert");

const { lintDax, groundingIssues } = require("../lib/daxLint");

const flat = (s) => s.replace(/\s+/g, " ").trim();

// Every case here is a query Power BI actually rejected during this session,
// after the model had been given the rule in the prompt AND a retry holding
// the engine's own error text. Prompting did not hold; these are the shapes
// that get repaired in code instead.

test("a FILTER placed after the name/value pairs is moved before them", () => {
  const rejected =
    `EVALUATE SUMMARIZECOLUMNS( Data[Genre], "Total Sales", [Total Sales], ` +
    `"Count of Games", [Count of Games], ` +
    `FILTER(Data, Data[Year] = 2016) )`;

  const { dax, notes } = lintDax(rejected);
  assert.ok(notes.length, "the misplaced filter must be reported");
  assert.match(
    flat(dax),
    /SUMMARIZECOLUMNS\(Data\[Genre\], FILTER\(Data, Data\[Year\] = 2016\), "Total Sales"/,
    "group-by, then filters, then the name/value pairs"
  );
});

test("several trailing filters are all moved, in order", () => {
  const rejected =
    `EVALUATE SUMMARIZECOLUMNS( 'Data'[Genre], "Total Revenue", [Total Sales], ` +
    `"Total Games", [Count of Games], ` +
    `FILTER('Data', 'Data'[Year] = 2016), ` +
    `FILTER('Data', 'Data'[Genre] IN {"Action","Sports"}) )`;

  const { dax } = lintDax(rejected);
  const inner = flat(dax);
  assert.ok(
    inner.indexOf("'Data'[Year] = 2016") < inner.indexOf('"Total Revenue"'),
    "both filters must precede the first name"
  );
  assert.ok(inner.indexOf("IN {") < inner.indexOf('"Total Revenue"'));
  // Nothing may be dropped.
  assert.match(inner, /"Total Revenue", \[Total Sales\]/);
  assert.match(inner, /"Total Games", \[Count of Games\]/);
});

test("a measure in a group-by slot becomes a name/value pair", () => {
  const { dax, notes } = lintDax(
    `EVALUATE SUMMARIZECOLUMNS([Total Revenue], 'Data'[Genre], "Rev", [Total Revenue])`
  );
  assert.ok(notes.some((n) => /measure/.test(n)));
  assert.match(flat(dax), /SUMMARIZECOLUMNS\('Data'\[Genre\]/);
});

test("VALUES() and DISTINCT() wrappers are unwrapped", () => {
  assert.match(
    flat(lintDax(`EVALUATE SUMMARIZECOLUMNS(VALUES('Genre'[Genre]), "S", [Sales])`).dax),
    /SUMMARIZECOLUMNS\('Genre'\[Genre\], "S", \[Sales\]\)/
  );
  assert.match(
    flat(lintDax(`EVALUATE SUMMARIZECOLUMNS(DISTINCT('Date'[Year]), "S", [Sales])`).dax),
    /SUMMARIZECOLUMNS\('Date'\[Year\], "S", \[Sales\]\)/
  );
});

test("a correct query is left byte-for-byte alone", () => {
  const fine =
    `EVALUATE SUMMARIZECOLUMNS('Data'[Genre], FILTER('Data', 'Data'[Year] = 2016), ` +
    `"Total Sales", [Total Sales])`;
  const { dax, notes } = lintDax(fine);
  assert.equal(dax, fine);
  assert.equal(notes.length, 0);
});

test("a query with no SUMMARIZECOLUMNS is untouched", () => {
  const other = `EVALUATE ROW("Total", [Total Sales])`;
  assert.equal(lintDax(other).dax, other);
});

// ---- grounding ----------------------------------------------------------

test("a year in the question missing from the query is caught", () => {
  const issues = groundingIssues(
    "total revenue by genre top 10 in 2016",
    `EVALUATE SUMMARIZECOLUMNS('Data'[Genre], "Rev", [Total Sales])`
  );
  assert.match(issues.join(" "), /2016/);
});

test("a fabricated constant column is caught", () => {
  // The real one: the model invented "YearFilter", 1 instead of filtering,
  // and the narrative on top still said "In 2016".
  const issues = groundingIssues(
    "top genres in 2016",
    `EVALUATE SUMMARIZECOLUMNS('Data'[Genre], "Rev", [Total Sales], "YearFilter", 1)`
  );
  assert.match(issues.join(" "), /constant/);
});

test("a properly filtered query raises nothing", () => {
  assert.deepEqual(
    groundingIssues(
      "total revenue by genre top 10 in 2016",
      `EVALUATE SUMMARIZECOLUMNS('Data'[Genre], FILTER('Data','Data'[Year]=2016), "Rev", [Total Sales])`
    ),
    []
  );
});

test("a question naming no period raises nothing", () => {
  assert.deepEqual(
    groundingIssues("top genres by revenue", `EVALUATE SUMMARIZECOLUMNS('Data'[Genre], "Rev", [Total Sales])`),
    []
  );
});

test("a breakdown question answered with raw row-level detail is caught", () => {
  // Asked for a breakdown, the model returned one row per transaction
  // instead of one row per genre -- the exact failure pattern grouping is
  // meant to catch, even though the query runs and even returns real data.
  const issues = groundingIssues("sales by genre", `EVALUATE 'Data'`);
  assert.match(issues.join(" "), /group|aggregat/i);
});

test("a top-N question over a raw table, with no grouping, is caught", () => {
  const issues = groundingIssues("top 10 genres by revenue", `EVALUATE TOPN(10, 'Data', 'Data'[Sales])`);
  assert.match(issues.join(" "), /group|aggregat/i);
});

test("a comparison question with no grouping is caught", () => {
  const issues = groundingIssues("compare genre sales this year and last", `EVALUATE 'Data'`);
  assert.match(issues.join(" "), /group|aggregat/i);
});

test("the same breakdown question raises nothing once the query actually groups", () => {
  assert.deepEqual(
    groundingIssues("sales by genre", `EVALUATE SUMMARIZECOLUMNS('Data'[Genre], "Sales", [Total Sales])`),
    []
  );
});

test("a question with no breakdown language raises nothing even over a raw table", () => {
  // "What is total sales" needs no per-category grouping at all.
  assert.deepEqual(groundingIssues("what is total sales", `EVALUATE ROW("Total", [Total Sales])`), []);
});

test("UNION ALL is caught — it is SQL, not DAX", () => {
  // The real one: asked to compare two years, the model wrote one ROW per
  // year and joined them with a SQL operator that does not exist in DAX.
  const issues = groundingIssues(
    "average resolution time for emails in 2022 and 2023",
    `EVALUATE ROW("2022", CALCULATE([M], 'Date'[Year] = 2022))\n` +
      `UNION ALL\n` +
      `EVALUATE ROW("2023", CALCULATE([M], 'Date'[Year] = 2023))`
  );
  assert.match(issues.join(" "), /UNION ALL|one EVALUATE/i);
});

test("two EVALUATE statements are caught — the endpoint runs one query", () => {
  const issues = groundingIssues(
    "emails in 2022 and 2023",
    `EVALUATE ROW("a", [M])\nEVALUATE ROW("b", [M])`
  );
  assert.match(issues.join(" "), /single EVALUATE/i);
  assert.match(issues.join(" "), /2 EVALUATE statements/i, "say how many, so the correction is concrete");
});

test("a single EVALUATE raises nothing on that count", () => {
  const issues = groundingIssues(
    "sales by genre",
    `EVALUATE SUMMARIZECOLUMNS('Data'[Genre], "Sales", [Sales])`
  );
  assert.ok(!/EVALUATE|UNION/i.test(issues.join(" ")));
});

test("a question naming two years wants them grouped, not one query per year", () => {
  // "in 2022 and 2023" carries no 'by', no 'top N' and no 'compare', but it
  // is still a comparison across a dimension.
  const issues = groundingIssues(
    "average resolution time for emails in 2022 and 2023",
    `EVALUATE ROW("v", CALCULATE([M], 'Date'[Year] = 2022))`
  );
  assert.match(issues.join(" "), /group|aggregat/i);
});

test("a question naming one year is not treated as a comparison", () => {
  const issues = groundingIssues(
    "average resolution time for emails in 2022",
    `EVALUATE ROW("v", CALCULATE([M], 'Date'[Year] = 2022))`
  );
  assert.ok(!/group|aggregat/i.test(issues.join(" ")));
});

test("'by' followed by a number is not mistaken for a breakdown dimension", () => {
  // "grew by 5%" names no category to group by.
  assert.deepEqual(groundingIssues("how much did sales grow by 5%", `EVALUATE ROW("Delta", [Delta])`), []);
});
