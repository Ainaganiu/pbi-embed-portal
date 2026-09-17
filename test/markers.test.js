const test = require("node:test");
const assert = require("node:assert");

const {
  findNeedData,
  findClarify,
  parseClarify,
  splitChart,
  splitFollowUps,
  emitSafe,
  confirmsPreviousTurn,
  schemaContext,
} = require("../lib/chatHelpers");

test("schemaContext with only a schema description returns it unchanged", () => {
  const got = schemaContext({ schemaDescription: "Data[Genre], [Sales]" });
  assert.equal(got, "Data[Genre], [Sales]");
});

test("schemaContext labels measures and columns as their own sections", () => {
  const got = schemaContext({
    schemaDescription: "Data[Genre], [Sales]",
    measuresDescription: "[Sales] is total revenue net of returns.",
    columnsDescription: "Data[Genre] is one of six fixed values.",
  });
  assert.match(got, /Data\[Genre\], \[Sales\]/);
  assert.match(got, /Measure definitions:\n\[Sales\] is total revenue/);
  assert.match(got, /Column definitions:\nData\[Genre\] is one of six/);
});

test("schemaContext omits a section that was never filled in", () => {
  const got = schemaContext({
    schemaDescription: "Data[Genre], [Sales]",
    measuresDescription: "[Sales] is total revenue net of returns.",
  });
  assert.ok(!got.includes("Column definitions:"));
});

test("schemaContext with nothing at all falls back to the existing placeholder", () => {
  assert.equal(schemaContext({}), "(not described)");
});

// The failure these exist for: the model explains itself, THEN emits the
// marker. Under first-line-only detection the whole reply fell through as
// prose, so the user saw the raw marker and the action never ran.
const EXPLAINED_FIRST =
  "I can see \"Top Selling Genre\" on this page, but it isn't restricted to " +
  "2016 and only shows 5 genres.\n\n" +
  "NEED_DATA: Genre top 10 by [Total Sales] filtered to Year = 2016.";

test("NEED_DATA is found after a sentence of explanation", () => {
  const found = findNeedData(EXPLAINED_FIRST);
  assert.ok(found, "the marker must be found wherever it lands");
  assert.match(found.payload, /Genre top 10/);
});

test("the explanation before the marker is kept as the lead-in", () => {
  const found = findNeedData(EXPLAINED_FIRST);
  assert.match(found.lead, /^I can see/);
  assert.doesNotMatch(found.lead, /NEED_DATA/);
});

test("a reply with no marker escalates nothing", () => {
  assert.equal(findNeedData("Sales rose 12% in 2016."), null);
});

test("CLARIFY is also found after prose, and still parses", () => {
  const reply =
    "Happy to build one — two things decide what it shows.\n" +
    'CLARIFY: {"questions":[{"ask":"Which measure?","multi":true,"options":["Sales","Units"]}]}';
  const found = findClarify(reply);
  assert.ok(found);
  assert.match(found.lead, /^Happy to build one/);

  const questions = parseClarify(found.payload);
  assert.equal(questions.length, 1);
  assert.equal(questions[0].multi, true);
  assert.deepEqual(questions[0].options, ["Sales", "Units"]);
});

test("no marker ever reaches the bubble, including a partial one", () => {
  // Mid-stream the marker can arrive split across chunks; forwarding the
  // first half flashes "NEED" in the bubble before the final frame lands.
  assert.equal(emitSafe("The page shows five genres.\n\nNEED"), "The page shows five genres.\n\n");
  assert.equal(emitSafe("Answer.\n\nCLAR"), "Answer.\n\n");
  assert.equal(emitSafe("Answer.\n\nCHA"), "Answer.\n\n");
  assert.equal(emitSafe("Answer.\n\nFOLLOW_UPS: a | b"), "Answer.\n\n");
  assert.equal(emitSafe("A complete answer."), "A complete answer.");
});

test("a chart spec is split off the end of a streamed answer", () => {
  const reply =
    "Action led 2016 at 33,110.\n\n" +
    'CHART: {"type":"bar","labels":["Action","Sports"],"values":[33110,19470],"unit":"$K"}\n\n' +
    "FOLLOW_UPS: Which region led? | Compare with 2015 | Why did Sports fall?";

  const followUps = splitFollowUps(reply);
  assert.equal(followUps.followUps.length, 3);

  const chart = splitChart(followUps.answer);
  assert.equal(chart.answer, "Action led 2016 at 33,110.");
  assert.equal(chart.chart.type, "bar");
  assert.deepEqual(chart.chart.values, [33110, 19470]);
});

test("a malformed chart spec loses the chart, not the answer", () => {
  const got = splitChart("Sales rose.\n\nCHART: {not json");
  assert.equal(got.answer, "Sales rose.");
  assert.equal(got.chart, null);
});

test("a confirming turn reuses what the last turn asked for", () => {
  const history = [
    { role: "user", content: "total revenue by genre top 10 in 2016" },
    { role: "assistant", content: EXPLAINED_FIRST },
  ];
  assert.match(confirmsPreviousTurn("it's not on the page", history), /Genre top 10/);
  assert.match(confirmsPreviousTurn("yes", history), /Genre top 10/);
});

test("a real follow-up question is not treated as confirmation", () => {
  const history = [{ role: "assistant", content: EXPLAINED_FIRST }];
  assert.equal(confirmsPreviousTurn("what about 2015?", history), null);
  assert.equal(
    confirmsPreviousTurn("yes but show it by region instead", history),
    null,
    "a turn that adds a new constraint is a new question"
  );
});

test("confirmation with nothing to reuse does nothing", () => {
  assert.equal(confirmsPreviousTurn("yes", []), null);
  assert.equal(
    confirmsPreviousTurn("yes", [{ role: "assistant", content: "Sales rose 12%." }]),
    null
  );
});

test("a deictic question is constrained to what is on screen", () => {
  const { refersToScreenEntities } = require("../lib/chatHelpers");
  assert.equal(refersToScreenEntities("compare these games with their previous year value"), true);
  assert.equal(refersToScreenEntities("how do those publishers compare to 2015"), true);
  assert.equal(refersToScreenEntities("what about the ones shown"), true);
});

test("a fresh ranking is not constrained to what is on screen", () => {
  const { refersToScreenEntities } = require("../lib/chatHelpers");
  // The real failure: constrained to the five genres on screen, "top 10"
  // came back with five rows and an apology.
  assert.equal(refersToScreenEntities("total revenue by genre top 10 in 2016"), false);
  assert.equal(refersToScreenEntities("show me the top 5 publishers"), false);
  assert.equal(refersToScreenEntities("sales by region in 2015"), false);
});

test("a marker written inline, not on its own line, still fires", () => {
  // Across runs of the same question this model puts the marker on its own
  // line most times and inline at the end of a sentence the rest. Under
  // line-anchored matching those runs silently did nothing.
  const inline =
    "The page isn't filtered to 2016, so I'll fetch it. NEED_DATA: Genre totals for Year = 2016.";
  const found = findNeedData(inline);
  assert.ok(found, "an inline marker must still escalate");
  assert.match(found.payload, /^Genre totals/);
  assert.doesNotMatch(found.lead, /NEED_DATA/);
});

test("an inline CLARIFY still parses into questions", () => {
  const inline =
    'Two things decide this. CLARIFY: {"questions":[{"ask":"Which axis?","options":["Year","Region"]}]}';
  const found = findClarify(inline);
  assert.ok(found);
  assert.equal(found.lead, "Two things decide this.");
  assert.deepEqual(parseClarify(found.payload)[0].options, ["Year", "Region"]);
});
