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
