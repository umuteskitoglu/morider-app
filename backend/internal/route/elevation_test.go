package route

import (
	"math"
	"testing"
)

func TestParseElevations(t *testing.T) {
	body := []byte(`{"status":"OK","results":[
		{"elevation":12.5,"location":{"lat":41,"lng":29}},
		{"elevation":null,"location":{"lat":41.1,"lng":29.1}},
		{"elevation":880,"location":{"lat":41.2,"lng":29.2}}]}`)
	elevs, err := parseElevations(body, 3)
	if err != nil {
		t.Fatalf("parseElevations: %v", err)
	}
	want := []float64{12.5, 0, 880}
	for i, w := range want {
		if elevs[i] != w {
			t.Errorf("elevs[%d] = %g, want %g", i, elevs[i], w)
		}
	}
}

func TestParseElevationsErrors(t *testing.T) {
	if _, err := parseElevations([]byte(`{"status":"INVALID_REQUEST","results":[]}`), 0); err == nil {
		t.Error("expected error for non-OK status")
	}
	if _, err := parseElevations([]byte(`{"status":"OK","results":[{"elevation":1}]}`), 2); err == nil {
		t.Error("expected error for result count mismatch")
	}
	if _, err := parseElevations([]byte(`not json`), 1); err == nil {
		t.Error("expected error for invalid JSON")
	}
}

func TestAscentDescentHysteresis(t *testing.T) {
	// 2 m oscillations are DEM noise and must not count; the 20 m climb and
	// 10 m drop must.
	elevs := []float64{100, 102, 100, 102, 120, 118, 120, 110}
	gain, loss := ascentDescent(elevs, 5)
	if gain != 20 {
		t.Errorf("gain = %g, want 20", gain)
	}
	if loss != 10 {
		t.Errorf("loss = %g, want 10", loss)
	}
}

func TestAscentDescentGradualClimb(t *testing.T) {
	// A steady climb read in 5 m increments must sum to the full height even
	// though each step only just reaches the threshold.
	elevs := []float64{0, 5, 10, 15, 20, 25, 30, 35, 40}
	gain, loss := ascentDescent(elevs, 5)
	if gain != 40 {
		t.Errorf("gain = %g, want 40", gain)
	}
	if loss != 0 {
		t.Errorf("loss = %g, want 0", loss)
	}
}

func TestBuildElevationProfile(t *testing.T) {
	// ~1.11 km between consecutive points along a meridian (0.01° lat).
	points := []Point{{Lat: 41.00, Lon: 29}, {Lat: 41.01, Lon: 29}, {Lat: 41.02, Lon: 29}}
	elevs := []float64{10, 50, 30}
	prof := buildElevationProfile(points, elevs)

	if len(prof.Points) != 3 {
		t.Fatalf("len(points) = %d, want 3", len(prof.Points))
	}
	if prof.Points[0].Dist != 0 {
		t.Errorf("first sample dist = %g, want 0", prof.Points[0].Dist)
	}
	if d := prof.Points[2].Dist; math.Abs(d-2.22) > 0.05 {
		t.Errorf("last sample dist = %g, want ≈2.22", d)
	}
	if prof.Min != 10 || prof.Max != 50 {
		t.Errorf("min/max = %g/%g, want 10/50", prof.Min, prof.Max)
	}
	if prof.Gain != 40 || prof.Loss != 20 {
		t.Errorf("gain/loss = %g/%g, want 40/20", prof.Gain, prof.Loss)
	}
}

func TestBuildElevationProfileMismatch(t *testing.T) {
	prof := buildElevationProfile([]Point{{Lat: 41, Lon: 29}}, []float64{1, 2})
	if len(prof.Points) != 0 {
		t.Errorf("mismatched input should yield an empty profile, got %d points", len(prof.Points))
	}
}
