package route

import (
	"strings"
	"testing"
)

const sampleKML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>Sahil Turu</name>
  <Placemark>
    <name>Segment 1</name>
    <LineString>
      <coordinates>
        28.9784,41.0082,30
        29.0100,41.0200,25
        29.1000,41.0500,10
      </coordinates>
    </LineString>
  </Placemark>
</Document>
</kml>`

func TestParseKMLBasic(t *testing.T) {
	name, points, err := ParseKML([]byte(sampleKML))
	if err != nil {
		t.Fatalf("ParseKML: %v", err)
	}
	if name != "Sahil Turu" {
		t.Errorf("name = %q, want %q", name, "Sahil Turu")
	}
	if len(points) != 3 {
		t.Fatalf("len(points) = %d, want 3", len(points))
	}
	if points[0].Lat != 41.0082 || points[0].Lon != 28.9784 {
		t.Errorf("first point = %+v, want {41.0082 28.9784}", points[0])
	}
}

func TestParseKMLFolderPlacemark(t *testing.T) {
	kml := `<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Doc</name>
	  <Folder><name>Klasör</name>
	    <Placemark><name>Parça</name>
	      <LineString><coordinates>29.0,41.0,0 29.1,41.1,0 29.2,41.2,0</coordinates></LineString>
	    </Placemark>
	  </Folder>
	</Document></kml>`
	name, points, err := ParseKML([]byte(kml))
	if err != nil {
		t.Fatalf("ParseKML: %v", err)
	}
	if name != "Doc" {
		t.Errorf("name = %q, want %q", name, "Doc")
	}
	if len(points) != 3 {
		t.Fatalf("len(points) = %d, want 3", len(points))
	}
}

func TestParseKMLMultiGeometry(t *testing.T) {
	// Two LineStrings inside a MultiGeometry — stitched together.
	kml := `<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
	  <Placemark>
	    <MultiGeometry>
	      <LineString><coordinates>28.0,41.0,0 28.5,41.5,0</coordinates></LineString>
	      <LineString><coordinates>28.5,41.5,0 29.0,42.0,0</coordinates></LineString>
	    </MultiGeometry>
	  </Placemark>
	</Document></kml>`
	_, points, err := ParseKML([]byte(kml))
	if err != nil {
		t.Fatalf("ParseKML: %v", err)
	}
	if len(points) != 4 {
		t.Errorf("len(points) = %d, want 4", len(points))
	}
}

func TestParseKMLRejectsInvalidInput(t *testing.T) {
	if _, _, err := ParseKML([]byte("not xml")); err == nil {
		t.Fatal("expected error for non-XML")
	}
	noLine := `<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
	  <Placemark><name>P</name><Point><coordinates>29,41,0</coordinates></Point></Placemark>
	</Document></kml>`
	if _, _, err := ParseKML([]byte(noLine)); err == nil {
		t.Fatal("expected error for Point-only KML (no LineString)")
	}
	onePoint := `<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
	  <Placemark><LineString><coordinates>29.0,41.0,0</coordinates></LineString></Placemark>
	</Document></kml>`
	if _, _, err := ParseKML([]byte(onePoint)); err == nil {
		t.Fatal("expected error for single-point KML")
	}
}

func TestBuildKMLRoundTrip(t *testing.T) {
	in := []Point{{Lat: 41.0082, Lon: 28.9784}, {Lat: 41.05, Lon: 29.1}}
	data := BuildKML("Test & Rota", in)
	if !strings.Contains(string(data), "Test &amp; Rota") {
		t.Fatal("name not XML-escaped in output")
	}
	name, out, err := ParseKML(data)
	if err != nil {
		t.Fatalf("round-trip parse: %v", err)
	}
	if name != "Test & Rota" {
		t.Errorf("round-trip name = %q", name)
	}
	if len(out) != 2 || out[0] != in[0] || out[1] != in[1] {
		t.Errorf("round-trip points = %+v, want %+v", out, in)
	}
}

func TestKMLFilename(t *testing.T) {
	cases := map[string]string{
		"Sahil Turu": "Sahil-Turu.kml",
		"":           "route.kml",
		"abc_123":    "abc_123.kml",
	}
	for in, want := range cases {
		if got := kmlFilename(in); got != want {
			t.Errorf("kmlFilename(%q) = %q, want %q", in, got, want)
		}
	}
}
