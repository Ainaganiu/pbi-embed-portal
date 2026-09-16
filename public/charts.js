// D3-based chart rendering for chat answers.
//
// One entry point — renderChart(container, spec, opts) — which clears the
// container and draws the chart described by `spec`:
//   { type: "bar"|"line"|"pie"|"card", labels: [], values: [], label: "" }
//
// Every renderer reads the --accent CSS variable so charts follow whatever
// branding the admin has configured, and takes explicit width/height so the
// same spec can be re-rendered larger in the enlarge modal rather than being
// scaled up (which would blur text and thicken strokes).

(function () {
  const MARGIN = { top: 16, right: 16, bottom: 56, left: 56 };

  function accent() {
    return (
      getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() ||
      "#3b5bfd"
    );
  }

  function muted() {
    return (
      getComputedStyle(document.documentElement).getPropertyValue("--text-muted").trim() ||
      "#6b7080"
    );
  }

  // Shorten large numbers for axis ticks / labels: 82740 -> 82.7K
  function formatValue(n) {
    if (n === null || n === undefined || Number.isNaN(n)) return "";
    const abs = Math.abs(n);
    if (abs >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
    if (abs >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
    if (abs >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
    if (Number.isInteger(n)) return String(n);
    return n.toFixed(2);
  }

  function fullNumber(n) {
    if (typeof n !== "number" || Number.isNaN(n)) return String(n ?? "");
    return n.toLocaleString();
  }

  function newSvg(container, width, height) {
    return d3
      .select(container)
      .append("svg")
      .attr("width", width)
      .attr("height", height)
      .attr("viewBox", `0 0 ${width} ${height}`)
      .attr("role", "img");
  }

  // Build a categorical palette by rotating the accent hue — keeps pie slices
  // visually related to the brand instead of an unrelated rainbow.
  function palette(n) {
    const base = d3.hsl(accent());
    return d3.range(n).map((i) => {
      const c = d3.hsl(base);
      c.h = (base.h + (i * 360) / Math.max(n, 1) * 0.55) % 360;
      c.s = Math.min(1, base.s * (i % 2 ? 0.75 : 1));
      c.l = Math.min(0.78, base.l * (1 + (i % 3) * 0.12));
      return c.formatHex();
    });
  }

  function renderBar(container, spec, width, height) {
    const data = spec.labels.map((l, i) => ({ label: String(l), value: +spec.values[i] || 0 }));
    const svg = newSvg(container, width, height);
    const innerW = width - MARGIN.left - MARGIN.right;
    const innerH = height - MARGIN.top - MARGIN.bottom;
    const g = svg.append("g").attr("transform", `translate(${MARGIN.left},${MARGIN.top})`);

    const x = d3.scaleBand().domain(data.map((d) => d.label)).range([0, innerW]).padding(0.25);
    const y = d3
      .scaleLinear()
      .domain([0, d3.max(data, (d) => d.value) || 1])
      .nice()
      .range([innerH, 0]);

    g.append("g")
      .attr("class", "grid")
      .call(d3.axisLeft(y).ticks(5).tickSize(-innerW).tickFormat(formatValue));

    const xAxis = g
      .append("g")
      .attr("transform", `translate(0,${innerH})`)
      .call(d3.axisBottom(x));

    // Rotate labels when they'd otherwise collide.
    const crowded = x.bandwidth() < 60;
    xAxis
      .selectAll("text")
      .attr("transform", crowded ? "rotate(-35)" : null)
      .style("text-anchor", crowded ? "end" : "middle")
      .attr("dx", crowded ? "-0.5em" : null)
      .attr("dy", crowded ? "0.3em" : "0.8em");

    g.selectAll("rect.bar")
      .data(data)
      .join("rect")
      .attr("class", "bar")
      .attr("x", (d) => x(d.label))
      .attr("y", (d) => y(d.value))
      .attr("width", x.bandwidth())
      .attr("height", (d) => innerH - y(d.value))
      .attr("rx", 3)
      .attr("fill", accent())
      .append("title")
      .text((d) => `${d.label}: ${fullNumber(d.value)}`);

    // Value labels only when there's room for them.
    if (x.bandwidth() > 28) {
      g.selectAll("text.value")
        .data(data)
        .join("text")
        .attr("class", "value")
        .attr("x", (d) => x(d.label) + x.bandwidth() / 2)
        .attr("y", (d) => y(d.value) - 5)
        .attr("text-anchor", "middle")
        .style("fill", muted())
        .style("font-size", "11px")
        .text((d) => formatValue(d.value));
    }
  }

  function renderLine(container, spec, width, height) {
    const data = spec.labels.map((l, i) => ({ label: String(l), value: +spec.values[i] || 0 }));
    const svg = newSvg(container, width, height);
    const innerW = width - MARGIN.left - MARGIN.right;
    const innerH = height - MARGIN.top - MARGIN.bottom;
    const g = svg.append("g").attr("transform", `translate(${MARGIN.left},${MARGIN.top})`);

    const x = d3.scalePoint().domain(data.map((d) => d.label)).range([0, innerW]).padding(0.5);
    const y = d3
      .scaleLinear()
      .domain(d3.extent(data, (d) => d.value))
      .nice()
      .range([innerH, 0]);

    g.append("g")
      .attr("class", "grid")
      .call(d3.axisLeft(y).ticks(5).tickSize(-innerW).tickFormat(formatValue));

    // Thin out tick labels on dense series so they stay readable.
    const step = Math.max(1, Math.ceil(data.length / (innerW / 60)));
    const xAxis = g
      .append("g")
      .attr("transform", `translate(0,${innerH})`)
      .call(d3.axisBottom(x).tickValues(data.filter((_, i) => i % step === 0).map((d) => d.label)));
    xAxis
      .selectAll("text")
      .attr("transform", "rotate(-35)")
      .style("text-anchor", "end")
      .attr("dx", "-0.5em")
      .attr("dy", "0.3em");

    g.append("path")
      .datum(data)
      .attr("fill", "none")
      .attr("stroke", accent())
      .attr("stroke-width", 2)
      .attr(
        "d",
        d3
          .line()
          .x((d) => x(d.label))
          .y((d) => y(d.value))
          .curve(d3.curveMonotoneX)
      );

    g.selectAll("circle.pt")
      .data(data)
      .join("circle")
      .attr("class", "pt")
      .attr("cx", (d) => x(d.label))
      .attr("cy", (d) => y(d.value))
      .attr("r", data.length > 40 ? 0 : 3)
      .attr("fill", accent())
      .append("title")
      .text((d) => `${d.label}: ${fullNumber(d.value)}`);
  }

  function renderPie(container, spec, width, height) {
    const data = spec.labels.map((l, i) => ({ label: String(l), value: +spec.values[i] || 0 }));
    const legendW = Math.min(180, Math.max(120, width * 0.34));
    const chartW = width - legendW;
    const radius = Math.max(20, Math.min(chartW, height) / 2 - 12);
    const colors = palette(data.length);
    const total = d3.sum(data, (d) => d.value) || 1;

    const svg = newSvg(container, width, height);
    const g = svg.append("g").attr("transform", `translate(${chartW / 2},${height / 2})`);

    const arcs = d3.pie().sort(null).value((d) => d.value)(data);
    const arc = d3.arc().innerRadius(radius * 0.55).outerRadius(radius);

    g.selectAll("path")
      .data(arcs)
      .join("path")
      .attr("d", arc)
      .attr("fill", (_, i) => colors[i])
      .attr("stroke", "var(--surface, #fff)")
      .attr("stroke-width", 1.5)
      .append("title")
      .text((d) => `${d.data.label}: ${fullNumber(d.data.value)} (${((d.data.value / total) * 100).toFixed(1)}%)`);

    // Percentage labels on slices big enough to hold them. Use style() not
    // attr() for fill — the stylesheet's `text { fill: ... }` rule would
    // otherwise win over a presentation attribute and wash these out.
    g.selectAll("text.slice")
      .data(arcs.filter((d) => d.endAngle - d.startAngle > 0.35))
      .join("text")
      .attr("class", "slice")
      .attr("transform", (d) => `translate(${arc.centroid(d)})`)
      .attr("text-anchor", "middle")
      .attr("dy", "0.35em")
      .style("font-size", Math.max(11, Math.round(radius * 0.13)) + "px")
      .style("font-weight", "700")
      .style("fill", "#fff")
      .text((d) => `${Math.round((d.data.value / total) * 100)}%`);

    const legend = svg
      .append("g")
      .attr("transform", `translate(${chartW + 8},${Math.max(12, height / 2 - data.length * 9)})`);
    data.forEach((d, i) => {
      const row = legend.append("g").attr("transform", `translate(0,${i * 18})`);
      row.append("rect").attr("width", 10).attr("height", 10).attr("rx", 2).attr("fill", colors[i]);
      row
        .append("text")
        .attr("x", 15)
        .attr("y", 9)
        .style("font-size", "11px")
        .style("fill", muted())
        .text(d.label.length > 18 ? d.label.slice(0, 17) + "…" : d.label);
    });
  }

  function renderCard(container, spec, width, height) {
    // A single headline number. Takes values[0], falling back to the sum when
    // the model hands back a series anyway.
    const value =
      spec.values && spec.values.length === 1
        ? +spec.values[0]
        : d3.sum(spec.values || [], (v) => +v || 0);
    const caption = spec.label || (spec.labels && spec.labels[0]) || "";

    const wrap = d3
      .select(container)
      .append("div")
      .attr("class", "chart-card")
      .style("height", height + "px");

    wrap
      .append("div")
      .attr("class", "chart-card-value")
      .style("color", accent())
      .style("font-size", Math.max(28, Math.min(72, width / 6)) + "px")
      .attr("title", fullNumber(value))
      .text(formatValue(value));

    if (caption) wrap.append("div").attr("class", "chart-card-caption").text(caption);
  }

  const RENDERERS = { bar: renderBar, line: renderLine, pie: renderPie, card: renderCard };

  function renderChart(container, spec, opts = {}) {
    container.innerHTML = "";
    if (!spec) return;

    const width = opts.width || container.clientWidth || 320;
    const height = opts.height || Math.round(width * 0.66);

    const type = RENDERERS[spec.type] ? spec.type : "bar";
    const values = Array.isArray(spec.values) ? spec.values : [];
    const labels = Array.isArray(spec.labels) ? spec.labels : [];

    // A card needs no labels; every other type needs matched label/value pairs.
    if (type !== "card" && (!labels.length || !values.length)) return;

    RENDERERS[type](container, { ...spec, labels, values }, width, height);
  }

  window.PortalCharts = { renderChart };
})();
