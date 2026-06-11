package route

import (
	"strings"
	"testing"
)

const sampleTrackGPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>Sile Yolu</name></metadata>
  <trk>
    <name>Sile track</name>
    <trkseg>
      <trkpt lat="41.0082" lon="28.9784"><ele>30</ele></trkpt>
      <trkpt lat="41.0200" lon="29.0100"></trkpt>
      <trkpt lat="41.0500" lon="29.1000"></trkpt>
    </trkseg>
  </trk>
</gpx>`

func TestParseGPXTrack(t *testing.T) {
	name, points, err := ParseGPX([]byte(sampleTrackGPX))
	if err != nil {
		t.Fatalf("ParseGPX: %v", err)
	}
	if name != "Sile Yolu" {
		t.Fatalf("name = %q, want %q", name, "Sile Yolu")
	}
	if len(points) != 3 {
		t.Fatalf("expected 3 points, got %d", len(points))
	}
	if points[0].Lat != 41.0082 || points[0].Lon != 28.9784 {
		t.Fatalf("unexpected first point: %+v", points[0])
	}
}

func TestParseGPXRoutePoints(t *testing.T) {
	gpx := `<gpx version="1.1"><rte><name>Plan</name>
	  <rtept lat="39.9" lon="32.8"/><rtept lat="40.0" lon="33.0"/></rte></gpx>`
	name, points, err := ParseGPX([]byte(gpx))
	if err != nil {
		t.Fatalf("ParseGPX: %v", err)
	}
	if name != "Plan" || len(points) != 2 {
		t.Fatalf("got name=%q points=%d", name, len(points))
	}
}

func TestParseGPXRejectsBadInput(t *testing.T) {
	if _, _, err := ParseGPX([]byte("not xml at all")); err == nil {
		t.Fatal("expected error for non-XML input")
	}
	onePoint := `<gpx><trk><trkseg><trkpt lat="41" lon="29"/></trkseg></trk></gpx>`
	if _, _, err := ParseGPX([]byte(onePoint)); err == nil {
		t.Fatal("expected error for single-point GPX")
	}
	badCoords := `<gpx><trk><trkseg><trkpt lat="999" lon="29"/><trkpt lat="998" lon="29"/></trkseg></trk></gpx>`
	if _, _, err := ParseGPX([]byte(badCoords)); err == nil {
		t.Fatal("expected error when all coordinates are out of range")
	}
}

func TestBuildGPXRoundTrip(t *testing.T) {
	in := []Point{{Lat: 41.0082, Lon: 28.9784}, {Lat: 41.05, Lon: 29.1}}
	data := BuildGPX("Test & Rota", in)
	if !strings.Contains(string(data), "Test &amp; Rota") {
		t.Fatal("name not XML-escaped in output")
	}
	name, out, err := ParseGPX(data)
	if err != nil {
		t.Fatalf("round-trip parse: %v", err)
	}
	if name != "Test & Rota" {
		t.Fatalf("round-trip name = %q", name)
	}
	if len(out) != len(in) || out[0] != in[0] || out[1] != in[1] {
		t.Fatalf("round-trip points = %+v, want %+v", out, in)
	}
}

func TestDownsampleKeepsEndpoints(t *testing.T) {
	points := make([]Point, 12000)
	for i := range points {
		points[i] = Point{Lat: float64(i), Lon: float64(i)}
	}
	out := downsample(points, maxGPXPoints)
	if len(out) != maxGPXPoints {
		t.Fatalf("len = %d, want %d", len(out), maxGPXPoints)
	}
	if out[0] != points[0] || out[len(out)-1] != points[len(points)-1] {
		t.Fatal("downsample dropped an endpoint")
	}
}

func TestGPXFilename(t *testing.T) {
	cases := map[string]string{
		"Şile Yolu": "ile-Yolu.gpx",
		"":          "route.gpx",
		"abc_123":   "abc_123.gpx",
		"././../x":  "x.gpx",
	}
	for in, want := range cases {
		if got := gpxFilename(in); got != want {
			t.Errorf("gpxFilename(%q) = %q, want %q", in, got, want)
		}
	}
}
