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
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	authpkg "github.com/morider/backend/pkg/auth"
	"github.com/morider/backend/pkg/httpx"
)

// Weather: current conditions for a point and along a stored route, plus a
// rideability assessment (see rideability.go). Backed by an Open-Meteo-compatible
// HTTP API — keyless and free on the public instance, self-host for production.
// Mirrors the elevation provider pattern (external HTTP, batch request, pure parser).

// At most this many samples per route-weather request: Open-Meteo serves all of
// them in one batched call, and it is plenty of resolution for a phone chart.
const maxWeatherSamples = 8

// weatherCacheTTL bounds how long a point's conditions are reused, so a busy
// route service does not hammer the upstream. 15 minutes is well within how fast
// conditions move for ride planning.
const weatherCacheTTL = 15 * time.Minute

// WeatherProvider resolves current conditions for the given points, one
// RideWeather per point in the same order.
type WeatherProvider interface {
	Current(ctx context.Context, points []Point) ([]RideWeather, error)
}

// OpenMeteo talks to an Open-Meteo-compatible forecast endpoint. The base URL is
// the forecast path, e.g. https://api.open-meteo.com/v1/forecast.
type OpenMeteo struct {
	url    string
	client *http.Client

	mu    sync.Mutex
	cache map[string]cachedWeather
}

type cachedWeather struct {
	w  RideWeather
	at time.Time
}

// NewOpenMeteo builds a provider for the given forecast endpoint URL.
func NewOpenMeteo(url string) *OpenMeteo {
	return &OpenMeteo{
		url:    strings.TrimRight(url, "/"),
		client: &http.Client{Timeout: 10 * time.Second},
		cache:  make(map[string]cachedWeather),
	}
}

// cacheKey rounds to ~1 km so nearby points share a cached reading.
func cacheKey(p Point) string {
	return fmt.Sprintf("%.2f,%.2f", p.Lat, p.Lon)
}

// Current returns conditions for every point. Points still fresh in the cache are
// served from memory; the rest are fetched in a single batched Open-Meteo request
// (it accepts comma-joined coordinates and returns one result per location).
func (o *OpenMeteo) Current(ctx context.Context, points []Point) ([]RideWeather, error) {
	if len(points) == 0 {
		return nil, nil
	}
	out := make([]RideWeather, len(points))
	misses := make([]Point, 0, len(points))
	missIdx := make([]int, 0, len(points))

	now := time.Now()
	o.mu.Lock()
	for i, p := range points {
		if c, ok := o.cache[cacheKey(p)]; ok && now.Sub(c.at) < weatherCacheTTL {
			out[i] = c.w
		} else {
			misses = append(misses, p)
			missIdx = append(missIdx, i)
		}
	}
	o.mu.Unlock()

	if len(misses) == 0 {
		return out, nil
	}

	fetched, err := o.fetch(ctx, misses)
	if err != nil {
		return nil, err
	}
	o.mu.Lock()
	for j, w := range fetched {
		out[missIdx[j]] = w
		o.cache[cacheKey(misses[j])] = cachedWeather{w: w, at: now}
	}
	o.mu.Unlock()
	return out, nil
}

// currentVars is the set of Open-Meteo "current" fields we request.
const currentVars = "temperature_2m,apparent_temperature,precipitation,weather_code," +
	"wind_speed_10m,wind_gusts_10m,wind_direction_10m,visibility"

// fetch performs one Open-Meteo request for all points (lat/lon comma-joined).
func (o *OpenMeteo) fetch(ctx context.Context, points []Point) ([]RideWeather, error) {
	lats := make([]string, 0, len(points))
	lons := make([]string, 0, len(points))
	for _, p := range points {
		lats = append(lats, strconv.FormatFloat(p.Lat, 'f', 4, 64))
		lons = append(lons, strconv.FormatFloat(p.Lon, 'f', 4, 64))
	}
	url := fmt.Sprintf("%s?latitude=%s&longitude=%s&current=%s&wind_speed_unit=kmh",
		o.url, strings.Join(lats, ","), strings.Join(lons, ","), currentVars)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
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
		return nil, fmt.Errorf("weather server returned %d", resp.StatusCode)
	}
	return parseOpenMeteo(body, len(points))
}

// omCurrent is the subset of Open-Meteo's "current" block we consume.
type omCurrent struct {
	Temperature   float64 `json:"temperature_2m"`
	Apparent      float64 `json:"apparent_temperature"`
	Precipitation float64 `json:"precipitation"`
	WeatherCode   int     `json:"weather_code"`
	WindSpeed     float64 `json:"wind_speed_10m"`
	WindGusts     float64 `json:"wind_gusts_10m"`
	WindDir       int     `json:"wind_direction_10m"`
	Visibility    float64 `json:"visibility"`
}

type omResponse struct {
	Current omCurrent `json:"current"`
}

// parseOpenMeteo converts an Open-Meteo forecast response into one RideWeather
// per requested point. A multi-location request returns a JSON array; a single
// location returns a bare object — both are handled. Pure, so it can be unit
// tested against fixtures without the network.
func parseOpenMeteo(body []byte, want int) ([]RideWeather, error) {
	trimmed := bytes.TrimSpace(body)
	var responses []omResponse
	if len(trimmed) > 0 && trimmed[0] == '[' {
		if err := json.Unmarshal(body, &responses); err != nil {
			return nil, fmt.Errorf("invalid weather response: %w", err)
		}
	} else {
		var single omResponse
		if err := json.Unmarshal(body, &single); err != nil {
			return nil, fmt.Errorf("invalid weather response: %w", err)
		}
		responses = []omResponse{single}
	}
	if len(responses) != want {
		return nil, fmt.Errorf("weather lookup returned %d results for %d points", len(responses), want)
	}
	out := make([]RideWeather, len(responses))
	for i, r := range responses {
		out[i] = RideWeather{
			TempC:       r.Current.Temperature,
			FeelsLikeC:  r.Current.Apparent,
			PrecipMM:    r.Current.Precipitation,
			WindKph:     r.Current.WindSpeed,
			GustKph:     r.Current.WindGusts,
			WindDir:     r.Current.WindDir,
			VisibilityM: r.Current.Visibility,
			WeatherCode: r.Current.WeatherCode,
		}
	}
	return out, nil
}

// PointWeather is the conditions at one point with its rideability and, for
// route responses, the cumulative distance from the start.
type PointWeather struct {
	Lat         float64     `json:"lat"`
	Lon         float64     `json:"lon"`
	Dist        float64     `json:"dist"` // cumulative km from start (0 for the single-point endpoint)
	Weather     RideWeather `json:"weather"`
	Rideability Rideability `json:"rideability"`
}

// RouteWeather is the API response for GET /api/routes/:id/weather: conditions at
// each sampled point plus the worst-case rideability along the whole route.
type RouteWeather struct {
	Points  []PointWeather `json:"points"`
	Overall Rideability    `json:"overall"`
}

// weatherNow serves GET /api/weather?lat=&lon=: current conditions and
// rideability at a single point.
func (h *handler) weatherNow(c *gin.Context) {
	lat, err1 := strconv.ParseFloat(c.Query("lat"), 64)
	lon, err2 := strconv.ParseFloat(c.Query("lon"), 64)
	if err1 != nil || err2 != nil {
		httpx.BadRequest(c, "lat and lon are required")
		return
	}
	results, err := h.weather.Current(c, []Point{{Lat: lat, Lon: lon}})
	if err != nil || len(results) == 0 {
		httpx.Error(c, http.StatusBadGateway, "weather lookup failed")
		return
	}
	w := results[0]
	c.JSON(http.StatusOK, PointWeather{
		Lat: lat, Lon: lon, Weather: w, Rideability: scoreRideability(w),
	})
}

// routeWeather serves GET /api/routes/:id/weather. Same visibility rules as
// elevation (owner / public / friends via mutual follow). It samples the route
// geometry, fetches conditions at each sample, and reports the worst-case
// rideability so the rider sees the limiting hazard at a glance.
func (h *handler) routeWeather(c *gin.Context) {
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
	points := downsample(parseGeoJSONLine(geojson), maxWeatherSamples)
	if len(points) < 1 {
		httpx.Error(c, http.StatusUnprocessableEntity, "route has no geometry")
		return
	}
	conditions, err := h.weather.Current(c, points)
	if err != nil {
		httpx.Error(c, http.StatusBadGateway, "weather lookup failed: "+err.Error())
		return
	}
	c.JSON(http.StatusOK, buildRouteWeather(points, conditions))
}

// buildRouteWeather pairs each sampled point with its conditions and cumulative
// distance, and picks the lowest-scoring point as the overall (limiting)
// rideability. Pure so it can be unit tested.
func buildRouteWeather(points []Point, conditions []RideWeather) RouteWeather {
	rw := RouteWeather{Points: make([]PointWeather, 0, len(points))}
	if len(points) == 0 || len(points) != len(conditions) {
		return rw
	}
	dist := 0.0
	worst := -1
	for i := range points {
		if i > 0 {
			dist += haversineKm(points[i-1], points[i])
		}
		r := scoreRideability(conditions[i])
		rw.Points = append(rw.Points, PointWeather{
			Lat: points[i].Lat, Lon: points[i].Lon, Dist: dist,
			Weather: conditions[i], Rideability: r,
		})
		if worst < 0 || r.Score < rw.Points[worst].Rideability.Score {
			worst = i
		}
	}
	rw.Overall = rw.Points[worst].Rideability
	return rw
}
