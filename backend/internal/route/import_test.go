package route

import "testing"

func TestParseRouteFileDetectsGPX(t *testing.T) {
	name, points, err := ParseRouteFile([]byte(sampleTrackGPX))
	if err != nil {
		t.Fatalf("ParseRouteFile(gpx): %v", err)
	}
	if name != "Sile Yolu" || len(points) != 3 {
		t.Errorf("got name=%q points=%d, want Sile Yolu / 3", name, len(points))
	}
}

func TestParseRouteFileDetectsKML(t *testing.T) {
	name, points, err := ParseRouteFile([]byte(sampleKML))
	if err != nil {
		t.Fatalf("ParseRouteFile(kml): %v", err)
	}
	if name != "Sahil Turu" || len(points) != 3 {
		t.Errorf("got name=%q points=%d, want Sahil Turu / 3", name, len(points))
	}
}

func TestParseRouteFileRejectsUnknown(t *testing.T) {
	if _, _, err := ParseRouteFile([]byte(`{"not":"xml"}`)); err == nil {
		t.Error("expected error for non-GPX/KML content")
	}
	if _, _, err := ParseRouteFile(nil); err == nil {
		t.Error("expected error for empty input")
	}
}
