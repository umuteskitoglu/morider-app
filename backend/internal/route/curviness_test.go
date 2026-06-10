package route

import (
	"math"
	"testing"
)

// straight line heading north along a meridian.
func straightLine(n int) []Point {
	pts := make([]Point, n)
	for i := range pts {
		pts[i] = Point{Lat: 41.0 + float64(i)*0.01, Lon: 29.0}
	}
	return pts
}

// zigzag alternates heading north and east every segment.
func zigzag(n int) []Point {
	pts := make([]Point, n)
	lat, lon := 41.0, 29.0
	for i := range pts {
		pts[i] = Point{Lat: lat, Lon: lon}
		if i%2 == 0 {
			lat += 0.01
		} else {
			lon += 0.01
		}
	}
	return pts
}

func TestCurvinessScore(t *testing.T) {
	if got := curvinessScore(straightLine(10)); got > 1e-6 {
		t.Errorf("straight line score = %v, want ~0", got)
	}
	zig := curvinessScore(zigzag(10))
	if zig < 30 {
		t.Errorf("zigzag score = %v, want clearly curvy (>30 deg/km)", zig)
	}
	if curvinessScore(straightLine(2)) != 0 {
		t.Error("2-point line must score 0")
	}
}

func TestPickByCurviness(t *testing.T) {
	plans := []RoutePlan{
		{Curviness: 80, Distance: 1},
		{Curviness: 5, Distance: 2},
		{Curviness: 40, Distance: 3},
	}
	if got := pickByCurviness(plans, 0); got.Curviness != 5 {
		t.Errorf("level 0 picked curviness %v, want 5", got.Curviness)
	}
	if got := pickByCurviness(plans, 1); got.Curviness != 80 {
		t.Errorf("level 1 picked curviness %v, want 80", got.Curviness)
	}
	if got := pickByCurviness(plans, 0.5); got.Curviness != 40 {
		t.Errorf("level 0.5 picked curviness %v, want 40", got.Curviness)
	}
	// Out-of-range levels clamp instead of panicking.
	if got := pickByCurviness(plans, 7); got.Curviness != 80 {
		t.Errorf("level 7 picked curviness %v, want 80", got.Curviness)
	}
	single := []RoutePlan{{Curviness: 10}}
	if got := pickByCurviness(single, 1); got.Curviness != 10 {
		t.Error("single plan must be returned unchanged")
	}
}

func TestAngleDiff(t *testing.T) {
	cases := []struct{ a, b, want float64 }{
		{10, 350, 20},
		{350, 10, -20},
		{180, 0, -180},
		{90, 90, 0},
	}
	for _, tc := range cases {
		if got := angleDiff(tc.a, tc.b); math.Abs(got-tc.want) > 1e-9 {
			t.Errorf("angleDiff(%v,%v) = %v, want %v", tc.a, tc.b, got, tc.want)
		}
	}
}

func TestParseOSRMRoutesAlternatives(t *testing.T) {
	body := `{"code":"Ok","routes":[
	  {"distance":1000,"duration":60,"geometry":{"coordinates":[[29.0,41.0],[29.0,41.01]]},"legs":[]},
	  {"distance":2000,"duration":120,"geometry":{"coordinates":[[29.0,41.0],[29.01,41.0],[29.01,41.01]]},"legs":[]}
	]}`
	plans, err := parseOSRMRoutes([]byte(body))
	if err != nil {
		t.Fatalf("parseOSRMRoutes: %v", err)
	}
	if len(plans) != 2 {
		t.Fatalf("expected 2 plans, got %d", len(plans))
	}
	if plans[1].Curviness <= plans[0].Curviness {
		t.Errorf("expected second (right-angle) route to score curvier: %v vs %v",
			plans[1].Curviness, plans[0].Curviness)
	}
}
