package route

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// RoutePlan is a road-snapped route returned by a Router: geometry plus real
// distance (km), duration (minutes) and turn-by-turn steps.
type RoutePlan struct {
	Distance float64 `json:"distance"` // km
	Duration float64 `json:"duration"` // minutes
	Points   []Point `json:"points"`
	Steps    []Step  `json:"steps"`
}

// Step is a single turn-by-turn instruction.
type Step struct {
	Instruction string  `json:"instruction"`
	Name        string  `json:"name"`
	Distance    float64 `json:"distance"` // meters
}

// Router turns an ordered list of waypoints into a road-following RoutePlan.
type Router interface {
	Plan(ctx context.Context, waypoints []Point) (RoutePlan, error)
}

// OSRMRouter talks to an OSRM-compatible HTTP routing server. See docs/routing.md.
type OSRMRouter struct {
	baseURL string
	profile string
	client  *http.Client
}

// NewOSRMRouter builds a router for the given OSRM base URL and profile.
func NewOSRMRouter(baseURL, profile string) *OSRMRouter {
	return &OSRMRouter{
		baseURL: strings.TrimRight(baseURL, "/"),
		profile: profile,
		client:  &http.Client{Timeout: 10 * time.Second},
	}
}

// Plan requests a route through the waypoints (lon,lat order on the wire) and
// parses the first returned route.
func (r *OSRMRouter) Plan(ctx context.Context, waypoints []Point) (RoutePlan, error) {
	if len(waypoints) < 2 {
		return RoutePlan{}, fmt.Errorf("routing needs at least 2 waypoints")
	}

	coords := make([]string, 0, len(waypoints))
	for _, p := range waypoints {
		coords = append(coords, fmt.Sprintf("%g,%g", p.Lon, p.Lat))
	}
	url := fmt.Sprintf("%s/route/v1/%s/%s?overview=full&geometries=geojson&steps=true",
		r.baseURL, r.profile, strings.Join(coords, ";"))

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return RoutePlan{}, err
	}
	resp, err := r.client.Do(req)
	if err != nil {
		return RoutePlan{}, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return RoutePlan{}, err
	}
	if resp.StatusCode != http.StatusOK {
		return RoutePlan{}, fmt.Errorf("routing server returned %d", resp.StatusCode)
	}
	return parseOSRMRoute(body)
}

// osrmResponse is the subset of the OSRM /route response we consume.
type osrmResponse struct {
	Code   string `json:"code"`
	Routes []struct {
		Distance float64 `json:"distance"` // meters
		Duration float64 `json:"duration"` // seconds
		Geometry struct {
			Coordinates [][]float64 `json:"coordinates"` // [lon, lat]
		} `json:"geometry"`
		Legs []struct {
			Steps []struct {
				Name     string `json:"name"`
				Distance float64 `json:"distance"` // meters
				Maneuver struct {
					Type     string `json:"type"`
					Modifier string `json:"modifier"`
				} `json:"maneuver"`
			} `json:"steps"`
		} `json:"legs"`
	} `json:"routes"`
}

// parseOSRMRoute converts an OSRM /route response body into a RoutePlan. It is
// pure (no I/O) so it can be unit-tested against fixtures.
func parseOSRMRoute(body []byte) (RoutePlan, error) {
	var resp osrmResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		return RoutePlan{}, fmt.Errorf("invalid routing response: %w", err)
	}
	if resp.Code != "Ok" || len(resp.Routes) == 0 {
		return RoutePlan{}, fmt.Errorf("no route found (code %q)", resp.Code)
	}
	route := resp.Routes[0]

	plan := RoutePlan{
		Distance: route.Distance / 1000.0,
		Duration: route.Duration / 60.0,
		Points:   make([]Point, 0, len(route.Geometry.Coordinates)),
		Steps:    []Step{},
	}
	for _, c := range route.Geometry.Coordinates {
		if len(c) >= 2 {
			plan.Points = append(plan.Points, Point{Lon: c[0], Lat: c[1]})
		}
	}
	for _, leg := range route.Legs {
		for _, s := range leg.Steps {
			plan.Steps = append(plan.Steps, Step{
				Instruction: maneuverText(s.Maneuver.Type, s.Maneuver.Modifier, s.Name),
				Name:        s.Name,
				Distance:    s.Distance,
			})
		}
	}
	return plan, nil
}

// maneuverText renders an OSRM maneuver (type + modifier) as a short Turkish
// instruction. Unknown types fall back to the modifier direction.
func maneuverText(typ, modifier, name string) string {
	on := ""
	if name != "" {
		on = " - " + name
	}
	switch typ {
	case "depart":
		return "Yola çık" + on
	case "arrive":
		return "Varış noktası" + on
	case "roundabout", "rotary":
		return "Dönel kavşağa gir" + on
	case "merge":
		return "Katıl" + on
	}
	// turn / continue / new name / fork etc. → use the direction modifier.
	switch modifier {
	case "left":
		return "Sola dön" + on
	case "right":
		return "Sağa dön" + on
	case "slight left":
		return "Hafif sola" + on
	case "slight right":
		return "Hafif sağa" + on
	case "sharp left":
		return "Keskin sola" + on
	case "sharp right":
		return "Keskin sağa" + on
	case "uturn":
		return "U dönüşü yap" + on
	case "straight":
		return "Düz devam et" + on
	default:
		return "Devam et" + on
	}
}
