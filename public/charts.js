// D3 chart rendering for chat answers, following IBCS (International Business
// Communication Standards) notation.
//
// The core idea of IBCS is that a chart is read, not decoded: the same visual
// vocabulary always means the same thing. Fill encodes the scenario —
//
//   AC (actual)        solid near-black
//   PY (previous year) solid light grey
//   PL (plan/budget)   white with a thin outline
//   FC (forecast)      hatched
//
// — and colour is reserved almost entirely for variance (green good, red bad),
// so a splash of red always means the same thing. That is why the configured
// brand accent deliberately does not reach chart data; it stays on the
// surrounding UI.
//
// Everything that doesn't carry information is removed: no background fills,
// no legend where a direct label will do, no gridlines and no axis where the
// data labels already give the values. The one exception is a chart whose
// bands are too narrow for direct labels — there a three-tick axis with
// hairline gridlines comes back, because a chart with no numbers anywhere on
// it is worse than one with a little furniture.
//
// Entry point: renderChart(container, spec, { width, maxHeight }) -- the height
// itself comes from the content, via ChartGeometry.
//
//   spec = {
//     type: "bar" | "column" | "line" | "donut" | "card" | "table" | "variance",
//     labels: [...],
//     unit: "$K",
//     // either a flat series…
//     values: [...],
//     // …or scenario-tagged series
//     series: [{ name, scenario: "AC"|"PY"|"PL"|"FC", values: [...] }]
//   }

(function () {
  // IBCS is near-monochrome by design; these are the only data colours.
  const INK = "#1a1a1a";
  const PY_GREY = "#c9ccd1";
  const HAIRLINE = "#d0d3d8";
  const GOOD = "#1f7a4d";
  const BAD = "#c0362c";

  const SCENARIOS = {
    AC: { fill: INK, stroke: "none", label: "Actual" },
    PY: { fill: PY_GREY, stroke: "none", label: "Previous year" },
    PL: { fill: "#ffffff", stroke: INK, label: "Plan" },
    FC: { fill: "url(#ibcs-hatch)", stroke: INK, label: "Forecast" },
  };

  function scenarioOf(series) {
    const key = String(series && series.scenario ? series.scenario : "AC").toUpperCase();
    return SCENARIOS[key] || SCENARIOS.AC;
  }

  function muted() {
    return (
      getComputedStyle(document.documentElement).getPropertyValue("--text-muted").trim() ||
      "#6b7080"
    );
  }

  function formatValue(n) {
    if (n === null || n === undefined || Number.isNaN(n)) return "";
    const abs = Math.abs(n);
    if (abs >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
    if (abs >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
    if (abs >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
    if (Number.isInteger(n)) return String(n);
    return n.toFixed(1);
  }

  function fullNumber(n) {
    return typeof n === "number" && !Number.isNaN(n) ? n.toLocaleString() : String(n ?? "");
  }

  // Normalises the shapes a model actually produces into one internal form:
  // { name, scenario, values[], scenarios[]? }.
  //
  // Models reliably get the *idea* right and the exact keys wrong — "categories"
  // for labels, "data" for values, points as {value, scenario} objects, or a
  // scenario tagged per point rather than per series (which is legitimate IBCS:
  // actuals and forecast along one timeline). Accepting these costs a few lines
  // and avoids silently rendering nothing.
  function numbersFrom(arr) {
    return (arr || []).map((d) => (d && typeof d === "object" ? +d.value || 0 : +d || 0));
  }

  function pointScenarios(arr) {
    const tags = (arr || []).map((d) => (d && typeof d === "object" && d.scenario ? String(d.scenario).toUpperCase() : null));
    return tags.some(Boolean) ? tags : null;
  }

  function labelsOf(spec) {
    const raw = spec.labels || spec.categories || [];
    return raw.map(String);
  }

  function seriesOf(spec) {
    if (Array.isArray(spec.series) && spec.series.length) {
      return spec.series.map((s) => {
        const points = s.values || s.data || [];
        return {
          name: s.name || scenarioOf(s).label,
          scenario: String(s.scenario || "AC").toUpperCase(),
          values: numbersFrom(points),
          scenarios: pointScenarios(points),
        };
      });
    }
    const points = spec.values || spec.data || [];
    return [
      {
        name: spec.label || "Actual",
        scenario: "AC",
        values: numbersFrom(points),
        scenarios: pointScenarios(points),
      },
    ];
  }

  // Per-point scenario wins over the series-level one when present.
  function fillFor(series, index) {
    const tag = series.scenarios && series.scenarios[index];
    return SCENARIOS[tag] || SCENARIOS[series.scenario] || SCENARIOS.AC;
  }

  function newSvg(container, width, height) {
    const svg = d3
      .select(container)
      .append("svg")
      .attr("width", width)
      .attr("height", height)
      .attr("viewBox", `0 0 ${width} ${height}`)
      .attr("role", "img");

    // Hatch fill for forecast scenarios.
    svg
      .append("defs")
      .append("pattern")
      .attr("id", "ibcs-hatch")
      .attr("width", 4)
      .attr("height", 4)
      .attr("patternUnits", "userSpaceOnUse")
      .attr("patternTransform", "rotate(45)")
      .append("rect")
      .attr("width", 2)
      .attr("height", 4)
      .attr("fill", INK);

    return svg;
  }

  // Title carries the unit, per IBCS — never a "(in thousands)" axis note.
  function addTitle(container, spec) {
    const parts = [];
    if (spec.label) parts.push(spec.label);
    if (spec.unit) parts.push(`in ${spec.unit}`);
    if (!parts.length) return;
    d3.select(container).append("div").attr("class", "ibcs-title").text(parts.join(" "));
  }

  // Scenario key, shown only when more than one scenario is present — a single
  // series needs no legend.
  function addLegend(container, series) {
    if (series.length < 2) return;
    const legend = d3.select(container).append("div").attr("class", "ibcs-legend");
    series.forEach((s) => {
      const item = legend.append("span").attr("class", "ibcs-legend-item");
      const sc = scenarioOf(s);
      item
        .append("span")
        .attr("class", "ibcs-swatch")
        .style("background", sc.fill === "url(#ibcs-hatch)" ? "repeating-linear-gradient(45deg," + INK + "," + INK + " 2px,#fff 2px,#fff 4px)" : sc.fill)
        .style("border", sc.stroke === "none" ? "none" : `1px solid ${INK}`);
      item.append("span").text(s.name);
    });
  }

  // IBCS drops the y-axis because direct labels carry the values. When the
  // bands are too narrow for direct labels, dropping both leaves a chart with
  // no numbers on it anywhere -- so the axis comes back instead.
  function addValueAxis(g, y, innerW) {
    const axis = g
      .append("g")
      .call(d3.axisLeft(y).ticks(3).tickSize(-innerW).tickFormat(formatValue));
    axis.select(".domain").remove();
    axis.selectAll("line").attr("stroke", HAIRLINE);
    axis.selectAll("text").attr("class", "ibcs-cat");
  }

  // ---- vertical columns: time on the horizontal axis -----------------------

  // Named because the axis decision has to predict the band width before the
  // scales are built, and a padding changed in one place only would silently
  // make that prediction wrong.
  const X0_PADDING = 0.3;
  const X1_PADDING = 0.08;

  function renderColumn(container, spec, width, height) {
    const series = seriesOf(spec);
    const labels = labelsOf(spec);
    addTitle(container, spec);

    // The raw slot per bar, less what the two band paddings below will take
    // out of it -- an estimate of x1.bandwidth() before the scales exist, so
    // the margin and the axis can be decided together from one number.
    const slot = (width - 16) / Math.max(1, labels.length) / Math.max(1, series.length);
    const approxBand = slot * (1 - X0_PADDING) * (1 - X1_PADDING);
    const needsAxis = !ChartGeometry.labelsFit(approxBand);
    const margin = { top: 18, right: 8, bottom: 30, left: needsAxis ? 34 : 8 };
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;

    const svg = newSvg(container, width, height);
    const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    const x0 = d3.scaleBand().domain(labels).range([0, innerW]).padding(X0_PADDING);
    const x1 = d3
      .scaleBand()
      .domain(series.map((s) => s.name))
      .range([0, x0.bandwidth()])
      .padding(X1_PADDING);

    const all = series.flatMap((s) => s.values);
    // Widened to include zero: a domain of [0, max] renders every negative
    // value as a zero-height bar, which reads as "no data" rather than "down".
    const y = d3
      .scaleLinear()
      .domain([Math.min(0, d3.min(all) ?? 0), Math.max(0, d3.max(all) ?? 1)])
      .nice()
      .range([innerH, 0]);
    const zeroY = y(0);

    labels.forEach((label, i) => {
      const group = g.append("g").attr("transform", `translate(${x0(label)},0)`);
      series.forEach((s) => {
        const sc = fillFor(s, i);
        const v = s.values[i] ?? 0;
        group
          .append("rect")
          .attr("x", x1(s.name))
          .attr("y", Math.min(zeroY, y(v)))
          .attr("width", x1.bandwidth())
          .attr("height", Math.max(1, Math.abs(y(v) - zeroY)))
          .attr("fill", sc.fill)
          .attr("stroke", sc.stroke)
          .attr("stroke-width", sc.stroke === "none" ? 0 : 1)
          .append("title")
          .text(`${label} · ${s.name}: ${fullNumber(v)}`);

        // Direct labels replace the y-axis entirely. They sit outside the bar
        // on whichever side it grew: ink on ink is an invisible label.
        if (!needsAxis) {
          group
            .append("text")
            .attr("class", "ibcs-value")
            .attr("x", x1(s.name) + x1.bandwidth() / 2)
            .attr("y", v >= 0 ? y(v) - 4 : y(v) + 4)
            .attr("dy", v >= 0 ? null : "0.8em")
            .attr("text-anchor", "middle")
            .text(formatValue(v));
        }
      });
    });

    if (needsAxis) addValueAxis(g, y, innerW);

    // The zero line, drawn over any gridlines the axis above brought with it.
    g.append("line")
      .attr("x1", 0)
      .attr("x2", innerW)
      .attr("y1", zeroY)
      .attr("y2", zeroY)
      .attr("stroke", INK);

    const crowded = x0.bandwidth() < 50;
    g.append("g")
      .attr("transform", `translate(0,${innerH})`)
      .call(d3.axisBottom(x0).tickSize(0).tickPadding(6))
      .call((sel) => sel.select(".domain").remove())
      .selectAll("text")
      .attr("class", "ibcs-cat")
      .attr("transform", crowded ? "rotate(-35)" : null)
      .style("text-anchor", crowded ? "end" : "middle");

    addLegend(container, series);
  }

  // ---- horizontal bars: structure comparison ------------------------------

  function renderBar(container, spec, width, height) {
    const series = seriesOf(spec);
    const labels = labelsOf(spec);
    addTitle(container, spec);

    const labelW = Math.min(150, Math.max(70, d3.max(labels, (l) => l.length) * 6.2));
    const margin = { top: 6, right: 46, bottom: 6, left: labelW };
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;

    const svg = newSvg(container, width, height);
    const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    const y0 = d3.scaleBand().domain(labels).range([0, innerH]).padding(0.28);
    const y1 = d3
      .scaleBand()
      .domain(series.map((s) => s.name))
      .range([0, y0.bandwidth()])
      .padding(0.08);
    const all = series.flatMap((s) => s.values);
    // Widened to include zero: a domain of [0, max] renders every negative
    // value as a zero-width bar, which reads as "no data" rather than "down".
    const x = d3
      .scaleLinear()
      .domain([Math.min(0, d3.min(all) ?? 0), Math.max(0, d3.max(all) ?? 1)])
      .range([0, innerW]);
    const zeroX = x(0);

    labels.forEach((label, i) => {
      const group = g.append("g").attr("transform", `translate(0,${y0(label)})`);

      const gutter = labelW - 12;
      group
        .append("text")
        .attr("class", "ibcs-cat")
        .attr("x", -8)
        .attr("y", y0.bandwidth() / 2)
        .attr("dy", "0.35em")
        .attr("text-anchor", "end")
        .text(ChartGeometry.truncateLabel(label, gutter))
        .append("title")
        .text(label);

      series.forEach((s) => {
        const sc = fillFor(s, i);
        const v = s.values[i] ?? 0;
        group
          .append("rect")
          .attr("x", Math.min(zeroX, x(v)))
          .attr("y", y1(s.name))
          .attr("width", Math.max(1, Math.abs(x(v) - zeroX)))
          .attr("height", y1.bandwidth())
          .attr("fill", sc.fill)
          .attr("stroke", sc.stroke)
          .attr("stroke-width", sc.stroke === "none" ? 0 : 1)
          .append("title")
          .text(`${label} · ${s.name}: ${fullNumber(v)}`);

        // Outside the bar on whichever side it grew: ink on ink is an
        // invisible label.
        group
          .append("text")
          .attr("class", "ibcs-value")
          .attr("x", v >= 0 ? x(v) + 4 : x(v) - 4)
          .attr("y", y1(s.name) + y1.bandwidth() / 2)
          .attr("dy", "0.35em")
          .attr("text-anchor", v >= 0 ? "start" : "end")
          .text(formatValue(v));
      });
    });

    g.append("line")
      .attr("x1", zeroX)
      .attr("x2", zeroX)
      .attr("y1", 0)
      .attr("y2", innerH)
      .attr("stroke", INK);

    addLegend(container, series);
  }

  // ---- line: time series --------------------------------------------------

  function renderLine(container, spec, width, height) {
    const series = seriesOf(spec);
    const labels = labelsOf(spec);
    addTitle(container, spec);

    const margin = { top: 16, right: 40, bottom: 30, left: 8 };
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;

    const svg = newSvg(container, width, height);
    const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    const x = d3.scalePoint().domain(labels).range([0, innerW]).padding(0.5);
    const all = series.flatMap((s) => s.values);
    const y = d3.scaleLinear().domain(d3.extent(all)).nice().range([innerH, 0]);

    series.forEach((s) => {
      const isPrior = s.scenario === "PY";
      const stroke = isPrior ? PY_GREY : INK;

      g.append("path")
        .datum(s.values)
        .attr("fill", "none")
        .attr("stroke", stroke)
        .attr("stroke-width", isPrior ? 1.5 : 2)
        .attr("stroke-dasharray", s.scenario === "FC" ? "4 3" : null)
        .attr(
          "d",
          d3
            .line()
            .x((_, i) => x(labels[i]))
            .y((d) => y(d))
        );

      // Label the series at its last point instead of a legend.
      const lastIndex = s.values.length - 1;
      if (lastIndex >= 0) {
        g.append("text")
          .attr("class", "ibcs-series-label")
          .attr("x", x(labels[lastIndex]) + 5)
          .attr("y", y(s.values[lastIndex]))
          .attr("dy", "0.35em")
          .attr("fill", stroke)
          .text(s.name);
      }
    });

    g.append("line")
      .attr("x1", 0)
      .attr("x2", innerW)
      .attr("y1", innerH)
      .attr("y2", innerH)
      .attr("stroke", INK);

    const step = Math.max(1, Math.ceil(labels.length / (innerW / 55)));
    g.append("g")
      .attr("transform", `translate(0,${innerH})`)
      .call(
        d3
          .axisBottom(x)
          .tickValues(labels.filter((_, i) => i % step === 0))
          .tickSize(0)
          .tickPadding(6)
      )
      .call((sel) => sel.select(".domain").remove())
      .selectAll("text")
      .attr("class", "ibcs-cat");
  }

  // ---- variance: deviation from a baseline --------------------------------

  function renderVariance(container, spec, width, height) {
    const labels = labelsOf(spec);
    const series = seriesOf(spec);

    // Either an explicit variance series, or AC minus PY.
    let values;
    if (series.length >= 2) {
      const ac = series.find((s) => s.scenario === "AC") || series[0];
      const py = series.find((s) => s.scenario === "PY") || series[1];
      values = ac.values.map((v, i) => v - (py.values[i] ?? 0));
    } else {
      values = series[0].values;
    }

    addTitle(container, { ...spec, label: spec.label || "Variance" });

    const labelW = Math.min(150, Math.max(70, d3.max(labels, (l) => l.length) * 6.2));
    const margin = { top: 6, right: 46, bottom: 6, left: labelW };
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;

    const svg = newSvg(container, width, height);
    const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    const extent = d3.extent(values);
    const span = Math.max(Math.abs(extent[0] || 0), Math.abs(extent[1] || 0)) || 1;
    const x = d3.scaleLinear().domain([-span, span]).range([0, innerW]);
    const y = d3.scaleBand().domain(labels).range([0, innerH]).padding(0.3);
    const zero = x(0);

    labels.forEach((label, i) => {
      const v = values[i] ?? 0;
      const positive = v >= 0;
      g.append("rect")
        .attr("x", positive ? zero : x(v))
        .attr("y", y(label))
        .attr("width", Math.abs(x(v) - zero))
        .attr("height", y.bandwidth())
        // Colour carries meaning here and nowhere else.
        .attr("fill", positive ? GOOD : BAD)
        .append("title")
        .text(`${label}: ${v >= 0 ? "+" : ""}${fullNumber(v)}`);

      const gutter = labelW - 12;
      g.append("text")
        .attr("class", "ibcs-cat")
        .attr("x", -8)
        .attr("y", y(label) + y.bandwidth() / 2)
        .attr("dy", "0.35em")
        .attr("text-anchor", "end")
        .text(ChartGeometry.truncateLabel(label, gutter))
        .append("title")
        .text(label);

      g.append("text")
        .attr("class", "ibcs-value")
        .attr("x", positive ? x(v) + 4 : x(v) - 4)
        .attr("y", y(label) + y.bandwidth() / 2)
        .attr("dy", "0.35em")
        .attr("text-anchor", positive ? "start" : "end")
        .attr("fill", positive ? GOOD : BAD)
        .text((v >= 0 ? "+" : "") + formatValue(v));
    });

    g.append("line")
      .attr("x1", zero)
      .attr("x2", zero)
      .attr("y1", 0)
      .attr("y2", innerH)
      .attr("stroke", INK);
  }

  // ---- donut: parts of a whole, in greyscale -------------------------------
  //
  // A ring rather than a filled circle: the hole removes the centre, where
  // angle differences are hardest to judge, and leaves the arc length doing
  // the work. Still the last resort -- a bar is easier to read -- so it is
  // chosen only where the question is genuinely about a share of a whole.
  // "pie" stays as an alias so answers already in a transcript still draw.

  function renderDonut(container, spec, width, height) {
    const data = spec.labels.map((l, i) => ({
      label: String(l),
      value: +(spec.values ? spec.values[i] : seriesOf(spec)[0].values[i]) || 0,
    }));
    addTitle(container, spec);

    const legendW = Math.min(170, Math.max(110, width * 0.34));
    const chartW = width - legendW;
    const radius = Math.max(20, Math.min(chartW, height) / 2 - 10);
    const total = d3.sum(data, (d) => d.value) || 1;
    // A greyscale ramp keeps colour free to mean "variance" elsewhere.
    const shade = d3.scaleLinear().domain([0, Math.max(1, data.length - 1)]).range([0.18, 0.82]);

    const svg = newSvg(container, width, height);
    const g = svg.append("g").attr("transform", `translate(${chartW / 2},${height / 2})`);
    const arcs = d3.pie().sort(null).value((d) => d.value)(data);
    const arc = d3.arc().innerRadius(radius * 0.55).outerRadius(radius);

    g.selectAll("path")
      .data(arcs)
      .join("path")
      .attr("d", arc)
      .attr("fill", (_, i) => d3.interpolateGreys(shade(i)))
      .attr("stroke", "#fff")
      .attr("stroke-width", 1)
      .append("title")
      .text((d) => `${d.data.label}: ${fullNumber(d.data.value)} (${((d.data.value / total) * 100).toFixed(1)}%)`);

    g.selectAll("text.slice")
      .data(arcs.filter((d) => d.endAngle - d.startAngle > 0.35))
      .join("text")
      .attr("class", "slice")
      .attr("transform", (d) => `translate(${arc.centroid(d)})`)
      .attr("text-anchor", "middle")
      .attr("dy", "0.35em")
      .style("font-size", Math.max(10, Math.round(radius * 0.12)) + "px")
      .style("font-weight", "600")
      .style("fill", (d, i) => (shade(i) > 0.55 ? "#fff" : INK))
      .text((d) => `${Math.round((d.data.value / total) * 100)}%`);

    const legend = svg
      .append("g")
      .attr("transform", `translate(${chartW + 8},${Math.max(10, height / 2 - data.length * 9)})`);
    data.forEach((d, i) => {
      const row = legend.append("g").attr("transform", `translate(0,${i * 18})`);
      row.append("rect").attr("width", 10).attr("height", 10).attr("fill", d3.interpolateGreys(shade(i)));
      row
        .append("text")
        .attr("x", 15)
        .attr("y", 9)
        .style("font-size", "11px")
        .style("fill", muted())
        .text(d.label.length > 18 ? d.label.slice(0, 17) + "…" : d.label);
    });
  }

  // ---- card: a single headline figure -------------------------------------

  function renderCard(container, spec, width, height) {
    const values = seriesOf(spec)[0].values;
    const value = values.length === 1 ? values[0] : d3.sum(values);
    const caption = [spec.label, spec.unit ? `in ${spec.unit}` : ""].filter(Boolean).join(" ");

    const wrap = d3.select(container).append("div").attr("class", "chart-card").style("height", height + "px");
    wrap
      .append("div")
      .attr("class", "chart-card-value")
      .style("font-size", Math.max(28, Math.min(64, width / 6)) + "px")
      .attr("title", fullNumber(value))
      .text(formatValue(value));
    if (caption) wrap.append("div").attr("class", "chart-card-caption").text(caption);
  }

  // ---- table: IBCS layout, with variance columns when scenarios allow -----

  function renderTable(container, spec, width) {
    addTitle(container, spec);
    const wrap = d3.select(container).append("div").attr("class", "chart-table-wrap");
    const table = wrap.append("table").attr("class", "chart-table ibcs-table");

    let columns;
    let rows;

    if (Array.isArray(spec.rows) && spec.rows.length) {
      columns = spec.columns && spec.columns.length ? spec.columns : [];
      rows = spec.rows;
    } else {
      const series = seriesOf(spec);
      const labels = (spec.labels || []).map(String);
      columns = ["", ...series.map((s) => s.name)];
      rows = labels.map((label, i) => [label, ...series.map((s) => s.values[i] ?? null)]);

      // Δ and Δ% are the point of an IBCS table whenever a comparison exists.
      const ac = series.find((s) => s.scenario === "AC");
      const py = series.find((s) => s.scenario === "PY");
      if (ac && py) {
        columns = [...columns, "Δ", "Δ%"];
        rows = rows.map((row, i) => {
          const a = ac.values[i] ?? 0;
          const p = py.values[i] ?? 0;
          return [...row, a - p, p === 0 ? null : ((a - p) / Math.abs(p)) * 100];
        });
      }
    }

    const isVarianceCol = columns.map((c) => c === "Δ" || c === "Δ%");

    table
      .append("thead")
      .append("tr")
      .selectAll("th")
      .data(columns)
      .join("th")
      .attr("class", (d, i) => (i === 0 ? "" : "num"))
      .text((d) => d);

    table
      .append("tbody")
      .selectAll("tr")
      .data(rows)
      .join("tr")
      .selectAll("td")
      .data((row) => row.map((cell, i) => ({ cell, i })))
      .join("td")
      .attr("class", (d) => {
        if (d.i === 0) return "";
        const classes = ["num"];
        if (isVarianceCol[d.i] && typeof d.cell === "number") {
          classes.push(d.cell >= 0 ? "var-good" : "var-bad");
        }
        return classes.join(" ");
      })
      .text((d) => {
        if (d.cell === null || d.cell === undefined) return "–";
        if (typeof d.cell !== "number") return d.cell;
        const sign = isVarianceCol[d.i] && d.cell > 0 ? "+" : "";
        if (columns[d.i] === "Δ%") return sign + d.cell.toFixed(1) + "%";
        return sign + d.cell.toLocaleString();
      });

    wrap.style("max-width", width + "px");
  }

  const RENDERERS = {
    bar: renderBar,
    column: renderColumn,
    line: renderLine,
    donut: renderDonut,
    pie: renderDonut,
    card: renderCard,
    table: renderTable,
    variance: renderVariance,
  };

  // Whatever was drawn, as rows. The chart may be a truncated view of the
  // answer; this is not -- it carries every category the spec holds.
  function toCsv(spec) {
    const esc = (v) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    if (Array.isArray(spec.rows) && spec.rows.length) {
      return [spec.columns || [], ...spec.rows].map((r) => r.map(esc).join(",")).join("\n");
    }

    const labels = labelsOf(spec);
    const series = seriesOf(spec);
    const header = [spec.label || "Category", ...series.map((s) => s.name)];
    const body = labels.map((label, i) => [label, ...series.map((s) => s.values[i] ?? "")]);
    return [header, ...body].map((r) => r.map(esc).join(",")).join("\n");
  }

  function renderChart(container, spec, opts = {}) {
    container.innerHTML = "";
    if (!spec) return;

    const width = opts.width || container.clientWidth || 320;
    const maxHeight = opts.maxHeight || 2000;

    let type = RENDERERS[spec.type] ? spec.type : "bar";
    const labels = labelsOf(spec);
    const hasSeries = Array.isArray(spec.series) && spec.series.length;
    const hasValues = Array.isArray(spec.values || spec.data) && (spec.values || spec.data).length;
    const tableHasRows = type === "table" && Array.isArray(spec.rows) && spec.rows.length;

    if (type !== "card" && !tableHasRows && (!labels.length || (!hasValues && !hasSeries))) return;

    // A column chart whose bands have collapsed is not a column chart any
    // more. Horizontal bars have room for as many categories as they need.
    if (type === "column" && labels.length && width / labels.length < 26) type = "bar";

    const height = ChartGeometry.heightFor(type, labels.length || 1, width, maxHeight);
    RENDERERS[type](container, { ...spec, labels }, width, height);

    if (spec.truncated) {
      d3.select(container)
        .append("div")
        .attr("class", "ibcs-note")
        .text(`Top ${spec.truncated.shown} of ${spec.truncated.total}`);
    }
  }

  window.PortalCharts = { renderChart, toCsv };
})();
