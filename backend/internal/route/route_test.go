package route

import "testing"

func TestLineStringWKT(t *testing.T) {
	points := []Point{
		{Lat: 41.0082, Lon: 28.9784},
		{Lat: 39.9334, Lon: 32.8597},
	}
	got := LineStringWKT(points)
	want := "LINESTRING(28.9784 41.0082, 32.8597 39.9334)"
	if got != want {
		t.Fatalf("LineStringWKT = %q, want %q", got, want)
	}
}

func TestParseGeoJSONLine(t *testing.T) {
	raw := `{"type":"LineString","coordinates":[[28.9784,41.0082],[32.8597,39.9334]]}`
	points := parseGeoJSONLine(raw)
	if len(points) != 2 {
		t.Fatalf("expected 2 points, got %d", len(points))
	}
	if points[0].Lon != 28.9784 || points[0].Lat != 41.0082 {
		t.Fatalf("unexpected first point: %+v", points[0])
	}
}
