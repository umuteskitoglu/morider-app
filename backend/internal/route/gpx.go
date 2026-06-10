package route

import (
	"encoding/xml"
	"errors"
	"fmt"
	"strings"
)

// maxGPXPoints caps the geometry stored from an imported file; longer tracks
// are evenly downsampled so a multi-day recording doesn't bloat the DB row.
const maxGPXPoints = 5000

// gpxFile mirrors the subset of the GPX 1.1 schema we care about: track
// points (recorded rides), route points (planned routes) and waypoints.
type gpxFile struct {
	XMLName  xml.Name `xml:"gpx"`
	Metadata struct {
		Name string `xml:"name"`
	} `xml:"metadata"`
	Tracks []struct {
		Name     string `xml:"name"`
		Segments []struct {
			Points []gpxPoint `xml:"trkpt"`
		} `xml:"trkseg"`
	} `xml:"trk"`
	Routes []struct {
		Name   string     `xml:"name"`
		Points []gpxPoint `xml:"rtept"`
	} `xml:"rte"`
	Waypoints []gpxPoint `xml:"wpt"`
}

type gpxPoint struct {
	Lat float64 `xml:"lat,attr"`
	Lon float64 `xml:"lon,attr"`
}

// ParseGPX extracts a name and an ordered point list from a GPX document.
// Preference order: track points, then route points, then bare waypoints.
func ParseGPX(data []byte) (string, []Point, error) {
	var g gpxFile
	if err := xml.Unmarshal(data, &g); err != nil {
		return "", nil, fmt.Errorf("invalid GPX: %w", err)
	}

	name := strings.TrimSpace(g.Metadata.Name)
	var raw []gpxPoint
	switch {
	case len(g.Tracks) > 0:
		for _, trk := range g.Tracks {
			if name == "" {
				name = strings.TrimSpace(trk.Name)
			}
			for _, seg := range trk.Segments {
				raw = append(raw, seg.Points...)
			}
		}
	case len(g.Routes) > 0:
		for _, rte := range g.Routes {
			if name == "" {
				name = strings.TrimSpace(rte.Name)
			}
			raw = append(raw, rte.Points...)
		}
	default:
		raw = g.Waypoints
	}

	points := make([]Point, 0, len(raw))
	for _, p := range raw {
		if p.Lat < -90 || p.Lat > 90 || p.Lon < -180 || p.Lon > 180 {
			continue
		}
		points = append(points, Point{Lat: p.Lat, Lon: p.Lon})
	}
	if len(points) < 2 {
		return "", nil, errors.New("GPX contains fewer than 2 usable points")
	}
	return name, downsample(points, maxGPXPoints), nil
}

// downsample keeps at most max points, evenly spaced, always retaining the
// first and last point so the route endpoints survive.
func downsample(points []Point, max int) []Point {
	n := len(points)
	if n <= max {
		return points
	}
	out := make([]Point, 0, max)
	step := float64(n-1) / float64(max-1)
	for i := 0; i < max; i++ {
		out = append(out, points[int(float64(i)*step+0.5)])
	}
	out[max-1] = points[n-1]
	return out
}

// BuildGPX renders points as a GPX 1.1 document with a single track segment.
func BuildGPX(name string, points []Point) []byte {
	var b strings.Builder
	b.WriteString(xml.Header)
	b.WriteString(`<gpx version="1.1" creator="Morider" xmlns="http://www.topografix.com/GPX/1/1">` + "\n")
	b.WriteString("  <metadata><name>")
	xml.EscapeText(&b, []byte(name))
	b.WriteString("</name></metadata>\n")
	b.WriteString("  <trk>\n    <name>")
	xml.EscapeText(&b, []byte(name))
	b.WriteString("</name>\n    <trkseg>\n")
	for _, p := range points {
		fmt.Fprintf(&b, "      <trkpt lat=\"%g\" lon=\"%g\"></trkpt>\n", p.Lat, p.Lon)
	}
	b.WriteString("    </trkseg>\n  </trk>\n</gpx>\n")
	return []byte(b.String())
}
