package route

import (
	"context"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
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
		typ, modifier, name string
		exit                int
		want                string
	}{
		{"depart", "", "Kennedy Cd", 0, "Yola çık - Kennedy Cd"},
		{"arrive", "", "", 0, "Varış noktası"},
		{"arrive", "right", "", 0, "Varış noktası sağda"},
		{"turn", "right", "Bağdat Cd", 0, "Sağa dön - Bağdat Cd"},
		{"turn", "sharp left", "", 0, "Keskin sola"},
		{"roundabout", "", "Meydan", 0, "Dönel kavşağa gir - Meydan"},
		{"roundabout", "right", "Meydan", 2, "Dönel kavşaktan 2. çıkışa çık - Meydan"},
		{"exit roundabout", "right", "", 0, "Dönel kavşaktan çık"},
		{"fork", "slight left", "", 0, "Çatalda solda kal"},
		{"fork", "straight", "", 0, "Çatalda düz devam et"},
		{"end of road", "left", "", 0, "Yolun sonunda sola dön"},
		{"on ramp", "slight right", "O-4", 0, "Sağdan bağlantı yoluna gir - O-4"},
		{"off ramp", "right", "", 0, "Sağdaki çıkışı kullan"},
		{"merge", "slight left", "", 0, "Sola katıl"},
		{"continue", "straight", "", 0, "Düz devam et"},
		{"fork", "unknown", "", 0, "Çatalda düz devam et"},
	}
	for _, tc := range cases {
		got := maneuverText(tc.typ, tc.modifier, tc.name, tc.exit)
		if got != tc.want {
			t.Errorf("maneuverText(%q,%q,%q,%d) = %q, want %q", tc.typ, tc.modifier, tc.name, tc.exit, got, tc.want)
		}
	}
}

func TestDropNoiseSteps(t *testing.T) {
	steps := []Step{
		{Type: "depart", Distance: 100},
		{Type: "new name", Modifier: "straight", Distance: 400},
		{Type: "turn", Modifier: "left", Distance: 200},
		{Type: "continue", Modifier: "straight", Distance: 300},
		{Type: "continue", Modifier: "left", Distance: 50},
		{Type: "arrive", Distance: 0},
	}
	got := dropNoiseSteps(steps)
	if len(got) != 4 {
		t.Fatalf("expected 4 steps after filtering, got %d", len(got))
	}
	// Dropped lengths fold into the previous kept step so totals still match.
	if !approx(got[0].Distance, 500) {
		t.Errorf("depart distance = %v, want 500 (absorbed new name)", got[0].Distance)
	}
	if !approx(got[1].Distance, 500) {
		t.Errorf("turn distance = %v, want 500 (absorbed continue straight)", got[1].Distance)
	}
	if got[2].Modifier != "left" || got[3].Type != "arrive" {
		t.Errorf("unexpected steps kept: %+v", got)
	}
}

func TestBuildRouteURL(t *testing.T) {
	two := []Point{{Lat: 41.0, Lon: 28.9}, {Lat: 41.1, Lon: 29.0}}
	five := []Point{{Lat: 41.0, Lon: 28.9}, {Lat: 41.02, Lon: 28.92}, {Lat: 41.04, Lon: 28.94}, {Lat: 41.06, Lon: 28.96}, {Lat: 41.1, Lon: 29.0}}
	cases := []struct {
		name         string
		waypoints    []Point
		alternatives bool
		withRadiuses bool
		contains     []string
		omits        []string
	}{
		{
			name:         "two waypoints with radiuses",
			waypoints:    two,
			withRadiuses: true,
			contains: []string{
				"/route/v1/driving/28.9,41;29,41.1?", // lon,lat wire order
				"continue_straight=false",
				"snapping=any",
				"radiuses=unlimited;unlimited",
			},
			omits: []string{"alternatives"},
		},
		{
			name:         "five waypoints caps intermediates",
			waypoints:    five,
			withRadiuses: true,
			contains:     []string{"radiuses=unlimited;250;250;250;unlimited"},
		},
		{
			name:         "alternatives requested",
			waypoints:    two,
			alternatives: true,
			withRadiuses: true,
			contains:     []string{"alternatives=3"},
		},
		{
			name:      "without radiuses",
			waypoints: two,
			contains:  []string{"continue_straight=false", "snapping=any"},
			omits:     []string{"radiuses"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			url := buildRouteURL("http://osrm:5000", "driving", tc.waypoints, tc.alternatives, tc.withRadiuses)
			for _, want := range tc.contains {
				if !strings.Contains(url, want) {
					t.Errorf("url %q missing %q", url, want)
				}
			}
			for _, not := range tc.omits {
				if strings.Contains(url, not) {
					t.Errorf("url %q should not contain %q", url, not)
				}
			}
		})
	}
}

func TestFetchRoutesRadiusFallback(t *testing.T) {
	var urls []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		urls = append(urls, r.URL.String())
		if strings.Contains(r.URL.RawQuery, "radiuses") {
			// OSRM reports a via-point with no road inside the radius as an
			// HTTP 400 with a JSON code — the fallback must read the body.
			w.WriteHeader(http.StatusBadRequest)
			w.Write([]byte(`{"code":"NoSegment","message":"Could not find a matching segment"}`))
			return
		}
		w.Write([]byte(osrmSample))
	}))
	defer srv.Close()

	r := NewOSRMRouter(srv.URL, "driving")
	plans, err := r.fetchRoutes(context.Background(), []Point{{Lat: 41.0, Lon: 28.9}, {Lat: 41.05, Lon: 28.95}, {Lat: 41.1, Lon: 29.0}}, false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !approx(plans[0].Distance, 4.7) {
		t.Errorf("Distance = %v km, want 4.7", plans[0].Distance)
	}
	if len(urls) != 2 {
		t.Fatalf("expected 2 requests (radiuses then fallback), got %d: %v", len(urls), urls)
	}
	if !strings.Contains(urls[0], "radiuses=unlimited;250;unlimited") {
		t.Errorf("first request should cap intermediates: %q", urls[0])
	}
	if strings.Contains(urls[1], "radiuses") {
		t.Errorf("fallback request should drop radiuses: %q", urls[1])
	}
}

func TestFetchRoutesHardFailure(t *testing.T) {
	var calls int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"code":"NoRoute","message":"Impossible route between points"}`))
	}))
	defer srv.Close()

	r := NewOSRMRouter(srv.URL, "driving")
	if _, err := r.fetchRoutes(context.Background(), []Point{{Lat: 41.0, Lon: 28.9}, {Lat: 41.1, Lon: 29.0}}, false); err == nil {
		t.Fatal("expected error when both attempts fail")
	}
	if calls != 2 {
		t.Errorf("expected 2 attempts, got %d", calls)
	}
}

func TestParseOSRMRouteRoundaboutExitAndRef(t *testing.T) {
	body := `{
	  "code": "Ok",
	  "routes": [{
	    "distance": 1000.0,
	    "duration": 60.0,
	    "geometry": { "coordinates": [[28.9, 41.0], [28.91, 41.01]] },
	    "legs": [{
	      "steps": [
	        { "name": "", "ref": "D-100", "distance": 500.0, "maneuver": { "type": "depart", "modifier": "" } },
	        { "name": "", "distance": 400.0, "maneuver": { "type": "roundabout", "modifier": "right", "exit": 3 } },
	        { "name": "", "distance": 0.0, "maneuver": { "type": "arrive", "modifier": "" } }
	      ]
	    }]
	  }]
	}`
	plan, err := parseOSRMRoute([]byte(body))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if plan.Steps[0].Name != "D-100" {
		t.Errorf("nameless step should fall back to ref, got %q", plan.Steps[0].Name)
	}
	if plan.Steps[1].Exit != 3 {
		t.Errorf("exit = %d, want 3", plan.Steps[1].Exit)
	}
	if plan.Steps[1].Instruction != "Dönel kavşaktan 3. çıkışa çık" {
		t.Errorf("unexpected instruction: %q", plan.Steps[1].Instruction)
	}
}
