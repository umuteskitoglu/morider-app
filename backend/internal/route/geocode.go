package route

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/morider/backend/pkg/httpx"
)

// Forward geocoding (address text → coordinates) for the in-app place search.
// Mirrors the OSRM/OpenTopoData pluggable-provider pattern: a Geocoder interface
// with a Nominatim (OpenStreetMap) driver selected from config. See docs/routing.md.

// Place is a single geocoding result: a short human label plus coordinates.
type Place struct {
	Name string  `json:"name"`
	Lat  float64 `json:"lat"`
	Lon  float64 `json:"lon"`
}

// Geocoder turns a free-text query into ranked place candidates. `near`, when
// set, is the rider's position; results around it are preferred.
type Geocoder interface {
	Search(ctx context.Context, query string, near *Point) ([]Place, error)
}

// NominatimGeocoder talks to a Nominatim-compatible search API (the public
// nominatim.openstreetmap.org instance or a self-hosted one).
type NominatimGeocoder struct {
	baseURL string
	client  *http.Client
}

// NewNominatimGeocoder builds a geocoder for the given Nominatim base URL.
func NewNominatimGeocoder(baseURL string) *NominatimGeocoder {
	return &NominatimGeocoder{
		baseURL: strings.TrimRight(baseURL, "/"),
		client:  &http.Client{Timeout: 10 * time.Second},
	}
}

// Search queries Nominatim's /search endpoint. When `near` is set a viewbox is
// added (unbounded) so nearby matches rank first without excluding far ones.
func (g *NominatimGeocoder) Search(ctx context.Context, query string, near *Point) ([]Place, error) {
	q := url.Values{}
	q.Set("q", query)
	q.Set("format", "jsonv2")
	q.Set("addressdetails", "1")
	q.Set("limit", "8")
	q.Set("accept-language", "tr")
	if near != nil {
		// viewbox is x1,y1,x2,y2 (lon,lat of two opposite corners); ~0.7° box.
		q.Set("viewbox", fmt.Sprintf("%g,%g,%g,%g", near.Lon-0.7, near.Lat-0.7, near.Lon+0.7, near.Lat+0.7))
		q.Set("bounded", "0")
	}
	reqURL := g.baseURL + "/search?" + q.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return nil, err
	}
	// Nominatim's usage policy requires an identifying User-Agent.
	req.Header.Set("User-Agent", "morider/1.0 (https://morider.app)")

	resp, err := g.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("geocoding server returned %d", resp.StatusCode)
	}
	return parseNominatimSearch(body)
}

// nominatimResult is the subset of a Nominatim /search jsonv2 item we consume.
type nominatimResult struct {
	Lat         string `json:"lat"`
	Lon         string `json:"lon"`
	Name        string `json:"name"`
	DisplayName string `json:"display_name"`
	Address     struct {
		Road     string `json:"road"`
		Suburb   string `json:"suburb"`
		Village  string `json:"village"`
		Town     string `json:"town"`
		City     string `json:"city"`
		District string `json:"district"`
		County   string `json:"county"`
		State    string `json:"state"`
	} `json:"address"`
}

// parseNominatimSearch converts a Nominatim /search response body into Places.
// Pure (no I/O) so it can be unit tested against fixtures, like parseOSRMRoutes.
func parseNominatimSearch(body []byte) ([]Place, error) {
	var results []nominatimResult
	if err := json.Unmarshal(body, &results); err != nil {
		return nil, fmt.Errorf("invalid geocoding response: %w", err)
	}
	places := make([]Place, 0, len(results))
	for _, r := range results {
		lat, err1 := strconv.ParseFloat(r.Lat, 64)
		lon, err2 := strconv.ParseFloat(r.Lon, 64)
		if err1 != nil || err2 != nil {
			continue // skip entries without usable coordinates
		}
		places = append(places, Place{Name: placeLabel(r), Lat: lat, Lon: lon})
	}
	return places, nil
}

// placeLabel builds a concise "<place>, <locality>, <state>" label from a
// result, falling back to the full display_name when no parts are available.
func placeLabel(r nominatimResult) string {
	locality := firstNonEmpty(r.Address.City, r.Address.Town, r.Address.Village, r.Address.County, r.Address.District)
	parts := make([]string, 0, 3)
	for _, p := range []string{firstNonEmpty(r.Name, r.Address.Road, r.Address.Suburb), locality, r.Address.State} {
		if p != "" && !contains(parts, p) {
			parts = append(parts, p)
		}
	}
	if len(parts) == 0 {
		return r.DisplayName
	}
	return strings.Join(parts, ", ")
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func contains(s []string, v string) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}

// geocode serves GET /api/routes/geocode?q=...&lat=&lon=. The optional lat/lon
// is the rider's position, used to rank nearby results first.
func (h *handler) geocode(c *gin.Context) {
	q := strings.TrimSpace(c.Query("q"))
	if q == "" {
		httpx.BadRequest(c, "missing search query")
		return
	}
	var near *Point
	if latStr, lonStr := c.Query("lat"), c.Query("lon"); latStr != "" && lonStr != "" {
		lat, err1 := strconv.ParseFloat(latStr, 64)
		lon, err2 := strconv.ParseFloat(lonStr, 64)
		if err1 == nil && err2 == nil {
			near = &Point{Lat: lat, Lon: lon}
		}
	}
	places, err := h.geo.Search(c, q, near)
	if err != nil {
		httpx.Error(c, http.StatusBadGateway, "geocoding failed: "+err.Error())
		return
	}
	c.JSON(http.StatusOK, gin.H{"places": places})
}
