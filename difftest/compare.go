package difftest

import (
	"fmt"
	"math"
	"sort"
	"strings"
)

// Stats summarises one side's distribution of one metric.
type Stats struct {
	N      int     `json:"n"`
	Mean   float64 `json:"mean"`
	SD     float64 `json:"sd"`
	Median float64 `json:"median"`
	P10    float64 `json:"p10"`
	P90    float64 `json:"p90"`
	Min    float64 `json:"min"`
	Max    float64 `json:"max"`
}

func summarize(xs []float64) Stats {
	s := Stats{N: len(xs)}
	if len(xs) == 0 {
		return s
	}
	sorted := append([]float64(nil), xs...)
	sort.Float64s(sorted)
	sum := 0.0
	for _, x := range sorted {
		sum += x
	}
	s.Mean = sum / float64(len(xs))
	v := 0.0
	for _, x := range sorted {
		v += (x - s.Mean) * (x - s.Mean)
	}
	if len(xs) > 1 {
		s.SD = math.Sqrt(v / float64(len(xs)-1))
	}
	s.Median = quantile(sorted, 0.5)
	s.P10 = quantile(sorted, 0.1)
	s.P90 = quantile(sorted, 0.9)
	s.Min, s.Max = sorted[0], sorted[len(sorted)-1]
	return s
}

func quantile(sorted []float64, q float64) float64 {
	if len(sorted) == 1 {
		return sorted[0]
	}
	pos := q * float64(len(sorted)-1)
	lo := int(math.Floor(pos))
	hi := int(math.Ceil(pos))
	f := pos - float64(lo)
	return sorted[lo]*(1-f) + sorted[hi]*f
}

// ksTwoSample returns the two-sample Kolmogorov-Smirnov statistic and its asymptotic p-value.
func ksTwoSample(a, b []float64) (d, p float64) {
	if len(a) == 0 || len(b) == 0 {
		return 0, 1
	}
	x := append([]float64(nil), a...)
	y := append([]float64(nil), b...)
	sort.Float64s(x)
	sort.Float64s(y)
	i, j := 0, 0
	for i < len(x) && j < len(y) {
		v := math.Min(x[i], y[j])
		for i < len(x) && x[i] <= v {
			i++
		}
		for j < len(y) && y[j] <= v {
			j++
		}
		diff := math.Abs(float64(i)/float64(len(x)) - float64(j)/float64(len(y)))
		if diff > d {
			d = diff
		}
	}
	n, m := float64(len(x)), float64(len(y))
	en := math.Sqrt(n * m / (n + m))
	lambda := (en + 0.12 + 0.11/en) * d
	return d, kolmogorovQ(lambda)
}

func kolmogorovQ(lambda float64) float64 {
	if lambda < 1e-9 {
		return 1
	}
	sum := 0.0
	sign := 1.0
	for k := 1; k <= 100; k++ {
		term := sign * 2 * math.Exp(-2*float64(k*k)*lambda*lambda)
		sum += term
		if math.Abs(term) < 1e-10 {
			break
		}
		sign = -sign
	}
	return math.Max(0, math.Min(1, sum))
}

// Severity levels, worst first.
const (
	SevGross       = "gross"
	SevSignificant = "significant"
	SevMinor       = "minor"
	SevOK          = "ok"
	SevCaveat      = "caveat"
)

var sevRank = map[string]int{SevGross: 4, SevSignificant: 3, SevMinor: 2, SevCaveat: 1, SevOK: 0}

// MetricComparison is one metric of one test, engine against game.
type MetricComparison struct {
	Metric   string  `json:"metric"`
	Focus    bool    `json:"focus"`
	Engine   Stats   `json:"engine"`
	Game     Stats   `json:"game"`
	KSD      float64 `json:"ksD"`
	KSP      float64 `json:"ksP"`
	Effect   float64 `json:"effect"` // |mean difference| / pooled SD (SD floored at 0.5)
	Severity string  `json:"severity"`
	Reason   string  `json:"reason,omitempty"`
}

// TestComparison is one test's verdict.
type TestComparison struct {
	ID          string             `json:"id"`
	Type        string             `json:"type"`
	Group       string             `json:"group"`
	Severity    string             `json:"severity"`
	Worst       *MetricComparison  `json:"worst,omitempty"`
	Metrics     []MetricComparison `json:"metrics"`
	EngineNotes []string           `json:"engineNotes,omitempty"`
	GameNotes   []string           `json:"gameNotes,omitempty"`
	GameCaveat  string             `json:"gameCaveat,omitempty"`
}

// Report is the comparator's output.
type Report struct {
	EngineLabel string            `json:"engine"`
	GameLabel   string            `json:"game"`
	Counts      map[string]int    `json:"counts"`
	Tests       []*TestComparison `json:"tests"`
	Missing     []string          `json:"missing,omitempty"`
}

// Tolerances: RNG streams differ between the two sides, so only distributional differences
// count, and only when they are both statistically clear and large enough to matter.
const (
	grossAbs        = 3.0  // medians this far apart (and at least grossRel) ...
	grossRel        = 0.5  // ... relative to the larger median, with non-overlapping p10..p90 bands
	signifP         = 1e-3 // KS p-value below which a shift is "significant" ...
	signifRel       = 0.2  // ... if the means also differ by 20% (and at least 1)
	minorP          = 1e-2
	successGrossGap = 0.5 // success-rate gap that is gross on its own
)

func classify(metric string, e, g Stats, p float64) (string, string) {
	if metric == "success" {
		gap := math.Abs(e.Mean - g.Mean)
		switch {
		case gap >= successGrossGap:
			return SevGross, fmt.Sprintf("success rate %.0f%% vs %.0f%%", 100*e.Mean, 100*g.Mean)
		case gap >= 0.2 && p < signifP:
			return SevSignificant, fmt.Sprintf("success rate %.0f%% vs %.0f%%", 100*e.Mean, 100*g.Mean)
		case p < minorP:
			return SevMinor, fmt.Sprintf("success rate %.0f%% vs %.0f%%", 100*e.Mean, 100*g.Mean)
		}
		return SevOK, ""
	}
	medDiff := math.Abs(e.Median - g.Median)
	larger := math.Max(math.Abs(e.Median), math.Abs(g.Median))
	bandsApart := e.P90 < g.P10 || g.P90 < e.P10
	// One side (almost) never produces what the other (almost) always does.
	// Only for amounts: a position metric (a box centre, a top) is legitimately 0.
	zeroVsSome := !isPositionMetric(metric) &&
		((e.Median == 0 && g.P10 > 0 && g.Median >= grossAbs) || (g.Median == 0 && e.P10 > 0 && e.Median >= grossAbs))
	if zeroVsSome {
		return SevGross, fmt.Sprintf("median %s vs %s: one side never has it", fmtNum(e.Median), fmtNum(g.Median))
	}
	if medDiff >= math.Max(grossAbs, grossRel*larger) && bandsApart {
		return SevGross, fmt.Sprintf("median %s vs %s, p10..p90 bands do not overlap", fmtNum(e.Median), fmtNum(g.Median))
	}
	meanDiff := math.Abs(e.Mean - g.Mean)
	meanLarger := math.Max(math.Abs(e.Mean), math.Abs(g.Mean))
	if p < signifP && meanDiff >= math.Max(1, signifRel*meanLarger) {
		return SevSignificant, fmt.Sprintf("mean %s vs %s (KS p=%.1e)", fmtNum(e.Mean), fmtNum(g.Mean), p)
	}
	if p < minorP && meanDiff >= 0.1*meanLarger {
		return SevMinor, fmt.Sprintf("mean %s vs %s (KS p=%.1e)", fmtNum(e.Mean), fmtNum(g.Mean), p)
	}
	return SevOK, ""
}

func isPositionMetric(metric string) bool {
	switch metric {
	case "bbox.cx", "bbox.cz", "bbox.minY", "bbox.maxY", "top", "logTop":
		return true
	}
	return false
}

func fmtNum(v float64) string {
	if v == math.Trunc(v) {
		return fmt.Sprintf("%.0f", v)
	}
	return fmt.Sprintf("%.2f", v)
}

// Compare compares two result sets test by test and metric by metric.
func Compare(m *Manifest, engine, game *Results, engineLabel, gameLabel string) *Report {
	rep := &Report{EngineLabel: engineLabel, GameLabel: gameLabel, Counts: map[string]int{}}
	byID := map[string]*Test{}
	for _, t := range m.Tests {
		byID[t.ID] = t
	}
	ids := make([]string, 0, len(engine.Tests))
	for id := range engine.Tests {
		ids = append(ids, id)
	}
	for id := range game.Tests {
		if _, ok := engine.Tests[id]; !ok {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	for _, id := range ids {
		et, gt := engine.Tests[id], game.Tests[id]
		if et == nil || gt == nil || len(et.Placements) == 0 || len(gt.Placements) == 0 {
			side := "game"
			if et == nil || len(et.Placements) == 0 {
				side = "engine"
			}
			rep.Missing = append(rep.Missing, fmt.Sprintf("%s (no %s placements)", id, side))
			continue
		}
		tc := &TestComparison{ID: id, Type: et.Type, Group: et.Group, EngineNotes: et.Notes, GameNotes: gt.Notes, GameCaveat: et.GameCaveat}
		focus := map[string]bool{}
		if t := byID[id]; t != nil {
			for _, f := range t.Metrics {
				focus[f] = true
			}
		}
		es, gs := Samples(et.Placements), Samples(gt.Placements)
		keys := map[string]bool{}
		for k := range es {
			keys[k] = true
		}
		for k := range gs {
			keys[k] = true
		}
		for _, k := range SortedKeys(keys) {
			ev := es[k]
			if ev == nil {
				ev = make([]float64, len(et.Placements))
			}
			gv := gs[k]
			if gv == nil {
				gv = make([]float64, len(gt.Placements))
			}
			e, g := summarize(ev), summarize(gv)
			if e.Max == 0 && e.Min == 0 && g.Max == 0 && g.Min == 0 {
				continue
			}
			d, p := ksTwoSample(ev, gv)
			pooled := math.Sqrt((e.SD*e.SD + g.SD*g.SD) / 2)
			effect := math.Abs(e.Mean-g.Mean) / math.Max(pooled, 0.5)
			sev, reason := classify(k, e, g, p)
			mc := MetricComparison{Metric: k, Focus: focus[k], Engine: e, Game: g, KSD: d, KSP: p, Effect: effect, Severity: sev, Reason: reason}
			tc.Metrics = append(tc.Metrics, mc)
		}
		sort.SliceStable(tc.Metrics, func(i, j int) bool {
			a, b := tc.Metrics[i], tc.Metrics[j]
			if sevRank[a.Severity] != sevRank[b.Severity] {
				return sevRank[a.Severity] > sevRank[b.Severity]
			}
			if a.Focus != b.Focus {
				return a.Focus
			}
			return a.Effect > b.Effect
		})
		tc.Severity = SevOK
		if len(tc.Metrics) > 0 && tc.Metrics[0].Severity != SevOK {
			w := tc.Metrics[0]
			tc.Worst = &w
			tc.Severity = w.Severity
		}
		// A carver the game refuses to place is expected, not a finding.
		if tc.GameCaveat != "" && summarize(gs["success"]).Mean == 0 {
			tc.Severity = SevCaveat
		}
		rep.Counts[tc.Severity]++
		rep.Tests = append(rep.Tests, tc)
	}
	sort.SliceStable(rep.Tests, func(i, j int) bool {
		a, b := rep.Tests[i], rep.Tests[j]
		if sevRank[a.Severity] != sevRank[b.Severity] {
			return sevRank[a.Severity] > sevRank[b.Severity]
		}
		ae, be := 0.0, 0.0
		if a.Worst != nil {
			ae = a.Worst.Effect
		}
		if b.Worst != nil {
			be = b.Worst.Effect
		}
		return ae > be
	})
	return rep
}

// Markdown renders the report.
func (r *Report) Markdown() string {
	var sb strings.Builder
	fmt.Fprintf(&sb, "# Feature placement differential report\n\n")
	fmt.Fprintf(&sb, "Engine: `%s`  \nGame: `%s`\n\n", r.EngineLabel, r.GameLabel)
	fmt.Fprintf(&sb, "| gross | significant | minor | caveat | ok | missing |\n|---|---|---|---|---|---|\n")
	fmt.Fprintf(&sb, "| %d | %d | %d | %d | %d | %d |\n\n", r.Counts[SevGross], r.Counts[SevSignificant], r.Counts[SevMinor],
		r.Counts[SevCaveat], r.Counts[SevOK], len(r.Missing))
	sb.WriteString("Tolerances: RNG streams differ, so a metric is compared as a distribution. **gross** = success rates " +
		"50+ points apart, or one side never produces what the other nearly always does, or medians at least max(3, 50%) apart " +
		"with non-overlapping p10..p90 bands. **significant** = two-sample KS p < 0.001 and means 20% (and at least 1) apart. " +
		"**minor** = KS p < 0.01 and means 10% apart.\n\n")

	section := func(title, sev string, limit int) {
		var rows []*TestComparison
		for _, t := range r.Tests {
			if t.Severity == sev {
				rows = append(rows, t)
			}
		}
		if len(rows) == 0 {
			return
		}
		fmt.Fprintf(&sb, "## %s (%d)\n\n", title, len(rows))
		sb.WriteString("| test | type | metric | engine median [p10..p90] | game median [p10..p90] | KS D | effect | why |\n|---|---|---|---|---|---|---|---|\n")
		for _, t := range rows {
			shown := 0
			for _, mc := range t.Metrics {
				if mc.Severity != sev || shown >= limit {
					continue
				}
				shown++
				fmt.Fprintf(&sb, "| %s | %s | `%s` | %s [%s..%s] | %s [%s..%s] | %.2f | %.1f | %s |\n",
					t.ID, strings.TrimPrefix(t.Type, "minecraft:"), mc.Metric,
					fmtNum(mc.Engine.Median), fmtNum(mc.Engine.P10), fmtNum(mc.Engine.P90),
					fmtNum(mc.Game.Median), fmtNum(mc.Game.P10), fmtNum(mc.Game.P90), mc.KSD, mc.Effect, mc.Reason)
			}
		}
		sb.WriteString("\n")
	}
	section("Gross discrepancies", SevGross, 6)
	section("Significant discrepancies", SevSignificant, 4)
	section("Minor discrepancies", SevMinor, 2)

	var caveats []string
	for _, t := range r.Tests {
		if t.Severity == SevCaveat {
			caveats = append(caveats, fmt.Sprintf("- %s: %s", t.ID, t.GameCaveat))
		}
	}
	if len(caveats) > 0 {
		fmt.Fprintf(&sb, "## Not comparable in game (%d)\n\n%s\n\n", len(caveats), strings.Join(caveats, "\n"))
	}
	if len(r.Missing) > 0 {
		fmt.Fprintf(&sb, "## Missing (%d)\n\n", len(r.Missing))
		for _, m := range r.Missing {
			fmt.Fprintf(&sb, "- %s\n", m)
		}
		sb.WriteString("\n")
	}
	var notes []string
	for _, t := range r.Tests {
		for _, n := range t.GameNotes {
			if strings.HasPrefix(n, "[warning]") { // build warnings, when the "game" is an engine run
				continue
			}
			notes = append(notes, fmt.Sprintf("- %s (game): %s", t.ID, n))
		}
		for _, n := range t.EngineNotes {
			if strings.Contains(n, "outside the dump region") || strings.Contains(n, "left the engine volume") || strings.Contains(n, "stopped") {
				notes = append(notes, fmt.Sprintf("- %s (engine): %s", t.ID, n))
			}
		}
	}
	if len(notes) > 0 {
		fmt.Fprintf(&sb, "## Notes\n\n%s\n\n", strings.Join(notes, "\n"))
	}
	fmt.Fprintf(&sb, "## All tests\n\n| test | type | verdict | worst metric |\n|---|---|---|---|\n")
	for _, t := range r.Tests {
		worst := ""
		if t.Worst != nil {
			worst = fmt.Sprintf("`%s` %s", t.Worst.Metric, t.Worst.Reason)
		}
		fmt.Fprintf(&sb, "| %s | %s | %s | %s |\n", t.ID, strings.TrimPrefix(t.Type, "minecraft:"), t.Severity, worst)
	}
	return sb.String()
}
