package route

import (
	"encoding/xml"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// KML 2.2 import/export. Google Maps and Google Earth both export KML, making
// it the easiest way for riders to share routes from those apps.
//
// Import priority: Folder > Document > first Placemark with a LineString or
// MultiGeometry. Name comes from the Document, Folder or Placemark that
// contains the chosen geometry.

// kmlDoc is the minimal KML 2.2 schema subset needed for route import.
type kmlDoc struct {
	XMLName  xml.Name    `xml:"kml"`
	Document kmlDocument `xml:"Document"`
}

type kmlDocument struct {
	Name    string      `xml:"name"`
	Folders []kmlFolder `xml:"Folder"`
	Marks   []kmlMark   `xml:"Placemark"`
}

type kmlFolder struct {
	Name  string    `xml:"name"`
	Marks []kmlMark `xml:"Placemark"`
}

type kmlMark struct {
	Name          string            `xml:"name"`
	LineString    *kmlLineString    `xml:"LineString"`
	MultiGeometry *kmlMultiGeometry `xml:"MultiGeometry"`
}

type kmlMultiGeometry struct {
	Lines []kmlLineString `xml:"LineString"`
}

type kmlLineString struct {
	Coords string `xml:"coordinates"`
}

// ParseKML extracts a name and ordered point list from a KML document.
// Coordinates are lon,lat[,ele] tuples; elevation is ignored.
func ParseKML(data []byte) (string, []Point, error) {
	var doc kmlDoc
	if err := xml.Unmarshal(data, &doc); err != nil {
		return "", nil, fmt.Errorf("invalid KML: %w", err)
	}

	type candidate struct {
		name   string
		coords string
	}
	var candidates []candidate

	// Folders come first; within each folder take all Placemarks in order.
	for _, folder := range doc.Document.Folders {
		fname := strings.TrimSpace(folder.Name)
		for _, m := range folder.Marks {
			coords, ok := markCoords(m)
			if !ok {
				continue
			}
			name := strings.TrimSpace(m.Name)
			if name == "" {
				name = fname
			}
			candidates = append(candidates, candidate{name, coords})
		}
	}
	// Then top-level Placemarks.
	for _, m := range doc.Document.Marks {
		coords, ok := markCoords(m)
		if !ok {
			continue
		}
		candidates = append(candidates, candidate{strings.TrimSpace(m.Name), coords})
	}

	if len(candidates) == 0 {
		return "", nil, errors.New("KML contains no LineString geometry")
	}

	// Use the first candidate; merge all when there are multiple (connected
	// segments from Google Maps multi-destination routes).
	name := strings.TrimSpace(doc.Document.Name)
	var allCoords []string
	for _, c := range candidates {
		allCoords = append(allCoords, c.coords)
		if name == "" && c.name != "" {
			name = c.name
		}
	}
	combined := strings.Join(allCoords, " ")

	points, err := parseKMLCoords(combined)
	if err != nil {
		return "", nil, err
	}
	if len(points) < 2 {
		return "", nil, errors.New("KML contains fewer than 2 usable coordinates")
	}
	return name, downsample(points, maxGPXPoints), nil
}

// markCoords returns the raw coordinate string from a Placemark's LineString
// or the first LineString in a MultiGeometry.
func markCoords(m kmlMark) (string, bool) {
	if m.LineString != nil {
		return m.LineString.Coords, true
	}
	if m.MultiGeometry != nil && len(m.MultiGeometry.Lines) > 0 {
		// Stitch all segments together — multi-stop Google Maps routes export
		// each leg as its own LineString inside one MultiGeometry.
		parts := make([]string, 0, len(m.MultiGeometry.Lines))
		for _, ls := range m.MultiGeometry.Lines {
			parts = append(parts, ls.Coords)
		}
		return strings.Join(parts, " "), true
	}
	return "", false
}

// parseKMLCoords converts "lon,lat[,ele] lon,lat[,ele] ..." into Points.
func parseKMLCoords(raw string) ([]Point, error) {
	fields := strings.Fields(raw)
	var out []Point
	for _, f := range fields {
		parts := strings.Split(f, ",")
		if len(parts) < 2 {
			continue
		}
		lon, err1 := strconv.ParseFloat(parts[0], 64)
		lat, err2 := strconv.ParseFloat(parts[1], 64)
		if err1 != nil || err2 != nil {
			continue
		}
		if lat < -90 || lat > 90 || lon < -180 || lon > 180 {
			continue
		}
		out = append(out, Point{Lat: lat, Lon: lon})
	}
	return out, nil
}

// BuildKML renders points as a KML 2.2 document with a single LineString.
func BuildKML(name string, points []Point) []byte {
	var b strings.Builder
	b.WriteString(xml.Header)
	b.WriteString(`<kml xmlns="http://www.opengis.net/kml/2.2">` + "\n")
	b.WriteString("<Document>\n  <name>")
	xml.EscapeText(&b, []byte(name))
	b.WriteString("</name>\n  <Placemark>\n    <name>")
	xml.EscapeText(&b, []byte(name))
	b.WriteString("</name>\n    <LineString>\n      <tessellate>1</tessellate>\n      <coordinates>")
	for i, p := range points {
		if i > 0 {
			b.WriteByte(' ')
		}
		fmt.Fprintf(&b, "%g,%g,0", p.Lon, p.Lat)
	}
	b.WriteString("</coordinates>\n    </LineString>\n  </Placemark>\n</Document>\n</kml>\n")
	return []byte(b.String())
}

// kmlFilename sanitises a route name for use as a KML download filename.
func kmlFilename(name string) string {
	base := gpxFilenameBase(name)
	return base + ".kml"
}
