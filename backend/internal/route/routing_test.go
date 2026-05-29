package route

import (
	"math"
	"testing"
)

const osrmSample = `{
  "code": "Ok",
  "routes": [{
    "distance": 4700.0,
    "duration": 558.0,
    "geometry": { "coordinates": [[28.9784, 41.0082], [28.99, 41.015], [29.01, 41.02]] },
    "legs": [{
      "steps": [
        { "name": "Kennedy Cd", "distance": 1200.0, "maneuver": { "type": "depart", "modifier": "" } },
        { "name": "Atatürk Bulvarı", "distance": 2500.0, "maneuver": { "type": "turn", "modifier": "left" } },
        { "name": "", "distance": 1000.0, "maneuver": { "type": "arrive", "modifier": "" } }
      ]
    }]
  }]
}`

func approx(a, b float64) bool { return math.Abs(a-b) < 1e-9 }

func TestParseOSRMRoute(t *testing.T) {
	plan, err := parseOSRMRoute([]byte(osrmSample))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !approx(plan.Distance, 4.7) {
		t.Errorf("Distance = %v km, want 4.7", plan.Distance)
	}
	if !approx(plan.Duration, 9.3) {
		t.Errorf("Duration = %v min, want 9.3", plan.Duration)
	}
	if len(plan.Points) != 3 {
		t.Fatalf("expected 3 points, got %d", len(plan.Points))
	}
	if plan.Points[0].Lat != 41.0082 || plan.Points[0].Lon != 28.9784 {
		t.Errorf("first point lon/lat swapped: %+v", plan.Points[0])
	}
	if len(plan.Steps) != 3 {
		t.Fatalf("expected 3 steps, got %d", len(plan.Steps))
	}
	if plan.Steps[1].Instruction != "Sola dön - Atatürk Bulvarı" {
		t.Errorf("unexpected instruction: %q", plan.Steps[1].Instruction)
	}
}

func TestParseOSRMRouteErrors(t *testing.T) {
	cases := []struct {
		name string
		body string
	}{
		{"no route", `{"code":"NoRoute","routes":[]}`},
		{"empty routes", `{"code":"Ok","routes":[]}`},
		{"malformed json", `{not json`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := parseOSRMRoute([]byte(tc.body)); err == nil {
				t.Errorf("expected error for %s, got nil", tc.name)
			}
		})
	}
}

func TestManeuverText(t *testing.T) {
	cases := []struct {
		typ, modifier, name, want string
	}{
		{"depart", "", "Kennedy Cd", "Yola çık - Kennedy Cd"},
		{"arrive", "", "", "Varış noktası"},
		{"turn", "right", "Bağdat Cd", "Sağa dön - Bağdat Cd"},
		{"turn", "sharp left", "", "Keskin sola"},
		{"roundabout", "", "Meydan", "Dönel kavşağa gir - Meydan"},
		{"continue", "straight", "", "Düz devam et"},
		{"fork", "unknown", "", "Devam et"},
	}
	for _, tc := range cases {
		got := maneuverText(tc.typ, tc.modifier, tc.name)
		if got != tc.want {
			t.Errorf("maneuverText(%q,%q,%q) = %q, want %q", tc.typ, tc.modifier, tc.name, got, tc.want)
		}
	}
}
