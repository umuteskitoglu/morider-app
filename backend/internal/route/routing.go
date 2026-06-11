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
	// Curviness is the geometry's twistiness: total heading change in degrees
	// per km. Roughly: <30 straight, 30-100 mixed, >100 a proper mountain road.
	Curviness float64 `json:"curviness"`
	Points    []Point `json:"points"`
	Steps     []Step  `json:"steps"`
}

// Step is a single turn-by-turn instruction.
type Step struct {
	Instruction string  `json:"instruction"`
	Name        string  `json:"name"`
	Distance    float64 `json:"distance"` // meters
}

// PlanOptions tunes route planning.
type PlanOptions struct {
	// UseCurviness enables alternative-route selection by twistiness. The zero
	// value (false) means "no preference" — the engine's default route is
	// returned and Curviness is ignored.
	UseCurviness bool
	// Curviness in [0,1] picks among alternative routes by how twisty they are
	// (0 = straightest alternative, 1 = curviest). Only consulted when
	// UseCurviness is true. OSRM only produces alternatives between exactly 2
	// waypoints; with via-points the single route is returned as-is.
	Curviness float64
}

// Router turns an ordered list of waypoints into a road-following RoutePlan.
type Router interface {
	Plan(ctx context.Context, waypoints []Point, opts PlanOptions) (RoutePlan, error)
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

// Plan requests a route through the waypoints (lon,lat order on the wire).
// With a curviness preference and exactly 2 waypoints it asks OSRM for
// alternatives and picks the one matching the requested twistiness.
func (r *OSRMRouter) Plan(ctx context.Context, waypoints []Point, opts PlanOptions) (RoutePlan, error) {
	if len(waypoints) < 2 {
		return RoutePlan{}, fmt.Errorf("routing needs at least 2 waypoints")
	}

	coords := make([]string, 0, len(waypoints))
	for _, p := range waypoints {
		coords = append(coords, fmt.Sprintf("%g,%g", p.Lon, p.Lat))
	}
	url := fmt.Sprintf("%s/route/v1/%s/%s?overview=full&geometries=geojson&steps=true",
		r.baseURL, r.profile, strings.Join(coords, ";"))
	wantCurvy := opts.UseCurviness && len(waypoints) == 2
	if wantCurvy {
		url += "&alternatives=3"
	}

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
	plans, err := parseOSRMRoutes(body)
	if err != nil {
		return RoutePlan{}, err
	}
	if wantCurvy {
		return pickByCurviness(plans, opts.Curviness), nil
	}
	return plans[0], nil
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
				Name     string  `json:"name"`
				Distance float64 `json:"distance"` // meters
				Maneuver struct {
					Type     string `json:"type"`
					Modifier string `json:"modifier"`
				} `json:"maneuver"`
			} `json:"steps"`
		} `json:"legs"`
	} `json:"routes"`
}

// parseOSRMRoute converts an OSRM /route response body into the first
// RoutePlan. Kept for call sites that only ever want one route.
func parseOSRMRoute(body []byte) (RoutePlan, error) {
	plans, err := parseOSRMRoutes(body)
	if err != nil {
		return RoutePlan{}, err
	}
	return plans[0], nil
}

// parseOSRMRoutes converts an OSRM /route response body into all returned
// routes (main + alternatives). It is pure (no I/O) so it can be unit-tested
// against fixtures. Guaranteed non-empty on nil error.
func parseOSRMRoutes(body []byte) ([]RoutePlan, error) {
	var resp osrmResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, fmt.Errorf("invalid routing response: %w", err)
	}
	if resp.Code != "Ok" || len(resp.Routes) == 0 {
		return nil, fmt.Errorf("no route found (code %q)", resp.Code)
	}

	plans := make([]RoutePlan, 0, len(resp.Routes))
	for _, route := range resp.Routes {
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
		plan.Curviness = curvinessScore(plan.Points)
		plans = append(plans, plan)
	}
	return plans, nil
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
