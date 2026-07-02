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
	// Alternatives holds the other routes the engine offered for the same
	// waypoints (only filled when requested, and only between exactly two
	// waypoints — OSRM does not produce alternatives through via-points).
	// Their own Alternatives fields are always empty.
	Alternatives []RoutePlan `json:"alternatives,omitempty"`
}

// Step is a single turn-by-turn instruction. Lat/Lon is the maneuver point
// (where the turn happens); Type/Modifier mirror OSRM's maneuver fields so the
// client can pick a matching arrow icon.
type Step struct {
	Instruction string  `json:"instruction"`
	Name        string  `json:"name"`
	Distance    float64 `json:"distance"` // meters
	Lat         float64 `json:"lat"`
	Lon         float64 `json:"lon"`
	Type        string  `json:"type"`
	Modifier    string  `json:"modifier"`
	// Exit is the roundabout exit number (1-based); 0 when not applicable.
	Exit int `json:"exit,omitempty"`
	// Ref is the road's signed reference ("D-100", "E-5") when OSM knows it.
	Ref string `json:"ref,omitempty"`
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
	// Alternatives, when true, also returns the engine's other route options in
	// RoutePlan.Alternatives so the client can offer a choice (Google-Maps
	// style). Only effective between exactly two waypoints.
	Alternatives bool
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
// Without a curviness preference it's a single request returning OSRM's default
// route. With a preference it selects by twistiness — see planCurvy.
func (r *OSRMRouter) Plan(ctx context.Context, waypoints []Point, opts PlanOptions) (RoutePlan, error) {
	if len(waypoints) < 2 {
		return RoutePlan{}, fmt.Errorf("routing needs at least 2 waypoints")
	}
	if opts.UseCurviness {
		return r.planCurvy(ctx, waypoints, opts.Curviness, opts.Alternatives)
	}
	wantAlts := opts.Alternatives && len(waypoints) == 2
	plans, err := r.fetchRoutes(ctx, waypoints, wantAlts)
	if err != nil {
		return RoutePlan{}, err
	}
	main := plans[0]
	if wantAlts {
		main.Alternatives = plans[1:]
	}
	return main, nil
}

// planCurvy honours the curviness preference. OSRM only returns alternatives
// between exactly two coordinates, so a multi-waypoint route is planned leg by
// leg — each consecutive pair is requested with alternatives, the leg matching
// the requested twistiness is chosen, and the chosen legs are stitched back
// together. With two waypoints it's a single alternatives request.
func (r *OSRMRouter) planCurvy(ctx context.Context, waypoints []Point, level float64, alternatives bool) (RoutePlan, error) {
	if len(waypoints) == 2 {
		plans, err := r.fetchRoutes(ctx, waypoints, true)
		if err != nil {
			return RoutePlan{}, err
		}
		main := pickByCurviness(plans, level)
		if alternatives {
			for _, p := range plans {
				if p.Curviness != main.Curviness || p.Distance != main.Distance {
					main.Alternatives = append(main.Alternatives, p)
				}
			}
		}
		return main, nil
	}
	var merged RoutePlan
	for i := 0; i+1 < len(waypoints); i++ {
		plans, err := r.fetchRoutes(ctx, waypoints[i:i+2], true)
		if err != nil {
			return RoutePlan{}, err
		}
		mergeLeg(&merged, pickByCurviness(plans, level))
	}
	// Recompute over the stitched geometry rather than summing per-leg scores,
	// so the reported curviness reflects the whole route.
	merged.Curviness = curvinessScore(merged.Points)
	return merged, nil
}

// mergeLeg appends a chosen leg onto the running plan, dropping the leg's first
// point when it duplicates the previous leg's last (the shared junction).
func mergeLeg(dst *RoutePlan, leg RoutePlan) {
	dst.Distance += leg.Distance
	dst.Duration += leg.Duration
	pts := leg.Points
	if len(dst.Points) > 0 && len(pts) > 0 {
		pts = pts[1:]
	}
	dst.Points = append(dst.Points, pts...)
	dst.Steps = append(dst.Steps, leg.Steps...)
}

// fetchRoutes performs one OSRM /route request for the given waypoints and
// returns every route it offers (main + alternatives when requested).
func (r *OSRMRouter) fetchRoutes(ctx context.Context, waypoints []Point, alternatives bool) ([]RoutePlan, error) {
	coords := make([]string, 0, len(waypoints))
	for _, p := range waypoints {
		coords = append(coords, fmt.Sprintf("%g,%g", p.Lon, p.Lat))
	}
	url := fmt.Sprintf("%s/route/v1/%s/%s?overview=full&geometries=geojson&steps=true",
		r.baseURL, r.profile, strings.Join(coords, ";"))
	if alternatives {
		url += "&alternatives=3"
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := r.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("routing server returned %d", resp.StatusCode)
	}
	return parseOSRMRoutes(body)
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
				Name         string  `json:"name"`
				Ref          string  `json:"ref"`          // road number ("D-100")
				Destinations string  `json:"destinations"` // motorway signage ("Ankara, Bolu")
				RotaryName   string  `json:"rotary_name"`
				Distance     float64 `json:"distance"` // meters
				Maneuver     struct {
					Type     string    `json:"type"`
					Modifier string    `json:"modifier"`
					Exit     int       `json:"exit"`     // roundabout exit number
					Location []float64 `json:"location"` // [lon, lat]
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
				// Display label: road name, else its number, else the signage
				// destinations (motorway entries often have no name at all).
				label := s.Name
				if label == "" && s.RotaryName != "" {
					label = s.RotaryName
				}
				if label == "" {
					label = s.Ref
				}
				if label == "" && s.Destinations != "" {
					label = s.Destinations + " yönü"
				}
				step := Step{
					Instruction: maneuverText(s.Maneuver.Type, s.Maneuver.Modifier, label, s.Maneuver.Exit),
					Name:        label,
					Distance:    s.Distance,
					Type:        s.Maneuver.Type,
					Modifier:    s.Maneuver.Modifier,
					Exit:        s.Maneuver.Exit,
					Ref:         s.Ref,
				}
				if len(s.Maneuver.Location) >= 2 {
					step.Lon, step.Lat = s.Maneuver.Location[0], s.Maneuver.Location[1]
				}
				plan.Steps = append(plan.Steps, step)
			}
		}
		plan.Steps = dropNoiseSteps(plan.Steps)
		plan.Curviness = curvinessScore(plan.Points)
		plans = append(plans, plan)
	}
	return plans, nil
}

// dropNoiseSteps removes instructions Google-style navigation would not
// announce: the road changing name while going straight, and plain
// "continue straight" through a junction. They add banner/voice churn without
// telling the rider to do anything. The dropped step's length is folded into
// the previous kept step so distances still sum to the route total. The first
// (depart) and last (arrive) steps are always kept.
func dropNoiseSteps(steps []Step) []Step {
	if len(steps) <= 2 {
		return steps
	}
	kept := make([]Step, 0, len(steps))
	kept = append(kept, steps[0])
	for i := 1; i < len(steps)-1; i++ {
		s := steps[i]
		noTurn := s.Modifier == "" || s.Modifier == "straight"
		if (s.Type == "new name" || s.Type == "continue") && noTurn {
			kept[len(kept)-1].Distance += s.Distance
			continue
		}
		kept = append(kept, s)
	}
	return append(kept, steps[len(steps)-1])
}

// side classifies an OSRM modifier as left (-1), right (+1) or neither (0).
func side(modifier string) int {
	switch modifier {
	case "left", "slight left", "sharp left":
		return -1
	case "right", "slight right", "sharp right":
		return 1
	}
	return 0
}

// maneuverText renders an OSRM maneuver as a short Turkish instruction,
// Google-Maps style: roundabouts carry their exit number, forks/ramps/road
// ends get purpose-built phrasing instead of a generic "turn". Unknown types
// fall back to the modifier direction.
func maneuverText(typ, modifier, name string, exit int) string {
	on := ""
	if name != "" {
		on = " - " + name
	}
	switch typ {
	case "depart":
		return "Yola çık" + on
	case "arrive":
		switch side(modifier) {
		case -1:
			return "Varış noktası solda" + on
		case 1:
			return "Varış noktası sağda" + on
		}
		return "Varış noktası" + on
	case "roundabout", "rotary":
		if exit > 0 {
			return fmt.Sprintf("Dönel kavşaktan %d. çıkışa çık", exit) + on
		}
		return "Dönel kavşağa gir" + on
	case "exit roundabout", "exit rotary":
		return "Dönel kavşaktan çık" + on
	case "fork":
		switch side(modifier) {
		case -1:
			return "Çatalda solda kal" + on
		case 1:
			return "Çatalda sağda kal" + on
		}
		return "Çatalda düz devam et" + on
	case "end of road":
		if side(modifier) == -1 {
			return "Yolun sonunda sola dön" + on
		}
		return "Yolun sonunda sağa dön" + on
	case "on ramp":
		switch side(modifier) {
		case -1:
			return "Soldan bağlantı yoluna gir" + on
		case 1:
			return "Sağdan bağlantı yoluna gir" + on
		}
		return "Bağlantı yoluna gir" + on
	case "off ramp":
		switch side(modifier) {
		case -1:
			return "Soldaki çıkışı kullan" + on
		case 1:
			return "Sağdaki çıkışı kullan" + on
		}
		return "Çıkışı kullan" + on
	case "merge":
		switch side(modifier) {
		case -1:
			return "Sola katıl" + on
		case 1:
			return "Sağa katıl" + on
		}
		return "Katıl" + on
	}
	// turn / continue / new name etc. → use the direction modifier.
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
