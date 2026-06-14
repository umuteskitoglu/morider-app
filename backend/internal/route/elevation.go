package route

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	authpkg "github.com/morider/backend/pkg/auth"
	"github.com/morider/backend/pkg/httpx"
)

// Elevation profile for a stored route: the geometry is downsampled, looked up
// against a DEM provider (OpenTopoData-compatible HTTP API) and returned as
// (cumulative km, meters) samples plus ascent/descent stats. See docs/routing.md.

// Max samples per profile — one provider request (OpenTopoData caps a request
// at 100 locations) and plenty of resolution for a phone-width chart.
const maxElevationSamples = 100

// SRTM-class DEMs carry a few meters of noise; climbs smaller than this are
// ignored when summing ascent/descent so the totals stay believable.
const elevationHysteresisM = 5.0

// ElevPoint is one sample of the profile.
type ElevPoint struct {
	Dist float64 `json:"dist"` // cumulative km from the start
	Ele  float64 `json:"ele"`  // meters above sea level
}

// ElevationProfile is the API response for GET /api/routes/:id/elevation.
type ElevationProfile struct {
	Points []ElevPoint `json:"points"`
	Gain   float64     `json:"gain"` // total ascent, meters
	Loss   float64     `json:"loss"` // total descent, meters
	Min    float64     `json:"min"`
	Max    float64     `json:"max"`
}

// ElevationProvider resolves elevations (meters) for the given points,
// returning one value per point in the same order.
type ElevationProvider interface {
	Elevations(ctx context.Context, points []Point) ([]float64, error)
}

// OpenTopoData talks to an OpenTopoData-compatible endpoint (the public
// api.opentopodata.org instance or a self-hosted one). The URL includes the
// dataset, e.g. https://api.opentopodata.org/v1/srtm90m.
type OpenTopoData struct {
	url    string
	client *http.Client
}

// NewOpenTopoData builds a provider for the given dataset endpoint URL.
func NewOpenTopoData(url string) *OpenTopoData {
	return &OpenTopoData{
		url:    strings.TrimRight(url, "/"),
		client: &http.Client{Timeout: 10 * time.Second},
	}
}

// Elevations posts all points in a single batch request.
func (o *OpenTopoData) Elevations(ctx context.Context, points []Point) ([]float64, error) {
	if len(points) == 0 {
		return nil, nil
	}
	locs := make([]string, 0, len(points))
	for _, p := range points {
		locs = append(locs, fmt.Sprintf("%g,%g", p.Lat, p.Lon))
	}
	payload, err := json.Marshal(map[string]string{"locations": strings.Join(locs, "|")})
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, o.url, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := o.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("elevation server returned %d", resp.StatusCode)
	}
	return parseElevations(body, len(points))
}

// parseElevations extracts the elevation list from an OpenTopoData response.
// Pure so it can be unit tested without the network.
func parseElevations(body []byte, want int) ([]float64, error) {
	var parsed struct {
		Status  string `json:"status"`
		Results []struct {
			Elevation *float64 `json:"elevation"`
		} `json:"results"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, fmt.Errorf("invalid elevation response: %w", err)
	}
	if parsed.Status != "OK" {
		return nil, fmt.Errorf("elevation lookup failed: %s", parsed.Status)
	}
	if len(parsed.Results) != want {
		return nil, fmt.Errorf("elevation lookup returned %d results for %d points", len(parsed.Results), want)
	}
	out := make([]float64, len(parsed.Results))
	for i, r := range parsed.Results {
		// Ocean / no-data cells come back null; treat them as sea level.
		if r.Elevation != nil {
			out[i] = *r.Elevation
		}
	}
	return out, nil
}

// buildElevationProfile pairs each sampled point with its cumulative distance
// along the (sampled) geometry and computes the summary stats.
func buildElevationProfile(points []Point, elevs []float64) ElevationProfile {
	prof := ElevationProfile{Points: make([]ElevPoint, 0, len(points))}
	if len(points) == 0 || len(points) != len(elevs) {
		return prof
	}
	dist := 0.0
	prof.Min, prof.Max = elevs[0], elevs[0]
	for i := range points {
		if i > 0 {
			dist += haversineKm(points[i-1], points[i])
		}
		prof.Points = append(prof.Points, ElevPoint{Dist: dist, Ele: elevs[i]})
		if elevs[i] < prof.Min {
			prof.Min = elevs[i]
		}
		if elevs[i] > prof.Max {
			prof.Max = elevs[i]
		}
	}
	prof.Gain, prof.Loss = ascentDescent(elevs, elevationHysteresisM)
	return prof
}

// elevation serves GET /api/routes/:id/elevation. Same visibility rules as
// GET /api/routes/:id (owner / public / friends via mutual follow).
func (h *handler) elevation(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		httpx.BadRequest(c, "invalid route id")
		return
	}
	var geojson string
	err = h.d.DB.QueryRow(c,
		`SELECT COALESCE(ST_AsGeoJSON(r.path), '')
		 FROM routes r
		 WHERE r.id = $1 AND (
		     r.user_id = $2
		     OR r.visibility = 'public'
		     OR (r.visibility = 'friends'
		         AND EXISTS (SELECT 1 FROM follows a WHERE a.follower_id = $2 AND a.followee_id = r.user_id)
		         AND EXISTS (SELECT 1 FROM follows b WHERE b.follower_id = r.user_id AND b.followee_id = $2))
		 )`, id, authpkg.UserID(c),
	).Scan(&geojson)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(c, http.StatusNotFound, "route not found")
		return
	}
	if err != nil {
		httpx.Internal(c, "could not load route")
		return
	}
	points := downsample(parseGeoJSONLine(geojson), maxElevationSamples)
	if len(points) < 2 {
		httpx.Error(c, http.StatusUnprocessableEntity, "route has no geometry")
		return
	}
	elevs, err := h.elev.Elevations(c, points)
	if err != nil {
		httpx.Error(c, http.StatusBadGateway, "elevation lookup failed: "+err.Error())
		return
	}
	c.JSON(http.StatusOK, buildElevationProfile(points, elevs))
}

// ascentDescent sums climbs and descents, ignoring oscillations smaller than
// the hysteresis threshold (DEM noise). It tracks a reference elevation that
// only moves once the change exceeds the threshold, then accumulates the full
// move — so a steady 200 m climb counts as 200 m even when read 5 m at a time.
func ascentDescent(elevs []float64, hysteresisM float64) (gain, loss float64) {
	if len(elevs) == 0 {
		return 0, 0
	}
	ref := elevs[0]
	for _, e := range elevs[1:] {
		diff := e - ref
		if diff >= hysteresisM {
			gain += diff
			ref = e
		} else if diff <= -hysteresisM {
			loss += -diff
			ref = e
		}
	}
	return gain, loss
}
