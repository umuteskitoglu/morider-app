package route

import (
	"bytes"
	"errors"
)

// ParseRouteFile sniffs an uploaded route file and dispatches to the matching
// parser, so the client needs a single "import file" action and no format
// knowledge. Detection looks for the root element tag rather than trusting
// extensions or Content-Type (share sheets routinely mangle both).
func ParseRouteFile(data []byte) (string, []Point, error) {
	head := bytes.ToLower(data[:min(len(data), 1024)])
	switch {
	case bytes.Contains(head, []byte("<gpx")):
		return ParseGPX(data)
	case bytes.Contains(head, []byte("<kml")):
		return ParseKML(data)
	default:
		return "", nil, errors.New("file is neither GPX nor KML")
	}
}
