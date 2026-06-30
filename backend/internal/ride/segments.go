package ride

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	authpkg "github.com/morider/backend/pkg/auth"
	"github.com/morider/backend/pkg/events"
	"github.com/morider/backend/pkg/httpx"
)

// Segments: rider-defined stretches of road and the timed efforts riders post on
// them. Efforts are matched from a ride's telemetry track on demand (the client
// calls match once it has finished uploading the track), so matching reads the
// full track and avoids racing the telemetry upload. The matching core is pure
// (matchSegment) and unit-tested; the handler just feeds it candidates from PostGIS.

// segmentMatchToleranceM is how close the track must pass to a segment's start
// and end points to count as a traversal. GPS drift on a bike is a few metres;
// 40 m is forgiving without matching an unrelated parallel road.
const segmentMatchToleranceM = 40.0

// geoPoint is a bare WGS84 coordinate used by the segment geometry helpers.
type geoPoint struct {
	Lat float64 `json:"lat"`
	Lon float64 `json:"lon"`
}

// Segment is the API representation of a segment.
type Segment struct {
	ID         int64      `json:"id"`
	UserID     int64      `json:"user_id"`
	Name       string     `json:"name"`
	Distance   float64    `json:"distance"` // km
	Visibility string     `json:"visibility"`
	Points     []geoPoint `json:"points"`
	// MyBestSeconds is the caller's personal record on this segment (0 = none).
	MyBestSeconds float64 `json:"my_best_seconds"`
}

// Effort is one timed traversal of a segment.
type Effort struct {
	SegmentID      int64   `json:"segment_id"`
	SegmentName    string  `json:"segment_name"`
	RideID         int64   `json:"ride_id"`
	ElapsedSeconds float64 `json:"elapsed_seconds"`
	AvgSpeed       float64 `json:"avg_speed"`
	IsPR           bool    `json:"is_pr"` // a new personal record for the caller
}

// LeaderboardEntry is one rider's best effort on a segment.
type LeaderboardEntry struct {
	UserID         int64   `json:"user_id"`
	Name           string  `json:"name"`
	ElapsedSeconds float64 `json:"elapsed_seconds"`
	AvgSpeed       float64 `json:"avg_speed"`
}

// registerSegmentRoutesOn mounts the segment endpoints on the given group.
func registerSegmentRoutesOn(g *gin.RouterGroup, h *handler) {
	g.POST("", h.createSegment)
	g.GET("", h.listSegments)
	g.GET("/explore", h.exploreSegments)
	g.GET("/:id", h.getSegment)
	g.GET("/:id/leaderboard", h.segmentLeaderboard)
	g.DELETE("/:id", h.removeSegment)
}

type segmentReq struct {
	Name       string     `json:"name" binding:"required,max=120"`
	Points     []geoPoint `json:"points" binding:"required,min=2"`
	Visibility string     `json:"visibility" binding:"omitempty,oneof=private public friends"`
}

func (h *handler) createSegment(c *gin.Context) {
	var req segmentReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.BadRequest(c, err.Error())
		return
	}
	vis := req.Visibility
	if vis == "" {
		vis = "public"
	}
	wkt := lineStringWKT(req.Points)

	var id int64
	var distance float64
	err := h.d.DB.QueryRow(c,
		`INSERT INTO segments (user_id, name, path, distance, visibility)
		 VALUES ($1, $2, ST_GeomFromText($3, 4326),
		         ST_Length(ST_GeomFromText($3, 4326)::geography) / 1000.0, $4)
		 RETURNING id, distance`,
		authpkg.UserID(c), req.Name, wkt, vis,
	).Scan(&id, &distance)
	if err != nil {
		httpx.Internal(c, "could not create segment")
		return
	}
	c.JSON(http.StatusCreated, Segment{
		ID: id, UserID: authpkg.UserID(c), Name: req.Name,
		Distance: distance, Visibility: vis, Points: req.Points,
	})
}

func (h *handler) listSegments(c *gin.Context) {
	rows, err := h.d.DB.Query(c,
		`SELECT id, user_id, name, distance, visibility
		 FROM segments WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`, authpkg.UserID(c))
	if err != nil {
		httpx.Internal(c, "could not list segments")
		return
	}
	c.JSON(http.StatusOK, gin.H{"segments": scanSegmentRows(rows)})
}

func (h *handler) exploreSegments(c *gin.Context) {
	rows, err := h.d.DB.Query(c,
		`SELECT id, user_id, name, distance, visibility
		 FROM segments WHERE visibility = 'public' AND user_id <> $1
		 ORDER BY created_at DESC LIMIT 50`, authpkg.UserID(c))
	if err != nil {
		httpx.Internal(c, "could not load segments")
		return
	}
	c.JSON(http.StatusOK, gin.H{"segments": scanSegmentRows(rows)})
}

// scanSegmentRows reads list rows (without geometry) into Segments. It closes
// the rows. Geometry is omitted from list views to keep payloads light.
func scanSegmentRows(rows pgx.Rows) []Segment {
	defer rows.Close()
	segs := make([]Segment, 0)
	for rows.Next() {
		var s Segment
		if err := rows.Scan(&s.ID, &s.UserID, &s.Name, &s.Distance, &s.Visibility); err != nil {
			return segs
		}
		segs = append(segs, s)
	}
	return segs
}

func (h *handler) getSegment(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		httpx.BadRequest(c, "invalid segment id")
		return
	}
	var s Segment
	var geojson string
	err = h.d.DB.QueryRow(c,
		`SELECT s.id, s.user_id, s.name, s.distance, s.visibility,
		        COALESCE(ST_AsGeoJSON(s.path), ''),
		        COALESCE((SELECT MIN(elapsed_seconds) FROM segment_efforts e
		                  WHERE e.segment_id = s.id AND e.user_id = $2), 0)
		 FROM segments s
		 WHERE s.id = $1 AND (s.visibility = 'public' OR s.user_id = $2)`, id, authpkg.UserID(c),
	).Scan(&s.ID, &s.UserID, &s.Name, &s.Distance, &s.Visibility, &geojson, &s.MyBestSeconds)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(c, http.StatusNotFound, "segment not found")
		return
	}
	if err != nil {
		httpx.Internal(c, "could not load segment")
		return
	}
	s.Points = parseGeoJSONLineRide(geojson)
	c.JSON(http.StatusOK, s)
}

func (h *handler) segmentLeaderboard(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		httpx.BadRequest(c, "invalid segment id")
		return
	}
	// Best (lowest) effort per rider, fastest first.
	rows, err := h.d.DB.Query(c,
		`SELECT DISTINCT ON (e.user_id) e.user_id, u.name, e.elapsed_seconds, e.avg_speed
		 FROM segment_efforts e JOIN users u ON u.id = e.user_id
		 WHERE e.segment_id = $1
		 ORDER BY e.user_id, e.elapsed_seconds ASC`, id)
	if err != nil {
		httpx.Internal(c, "could not load leaderboard")
		return
	}
	defer rows.Close()
	entries := make([]LeaderboardEntry, 0)
	for rows.Next() {
		var e LeaderboardEntry
		if err := rows.Scan(&e.UserID, &e.Name, &e.ElapsedSeconds, &e.AvgSpeed); err != nil {
			httpx.Internal(c, "could not read leaderboard")
			return
		}
		entries = append(entries, e)
	}
	// DISTINCT ON returns rider-best rows but ordered by user_id; sort by time.
	sortLeaderboard(entries)
	c.JSON(http.StatusOK, gin.H{"entries": entries})
}

func (h *handler) removeSegment(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		httpx.BadRequest(c, "invalid segment id")
		return
	}
	tag, err := h.d.DB.Exec(c, `DELETE FROM segments WHERE id = $1 AND user_id = $2`, id, authpkg.UserID(c))
	if err != nil {
		httpx.Internal(c, "could not delete segment")
		return
	}
	if tag.RowsAffected() == 0 {
		httpx.Error(c, http.StatusNotFound, "segment not found")
		return
	}
	c.Status(http.StatusNoContent)
}

// matchRideSegments serves POST /api/rides/:id/segments/match. It loads the
// ride's track, finds every public-or-owned segment the track passes near, times
// each traversal and records an effort (idempotent per segment+ride). It then
// re-publishes ride.completed so the reward service re-evaluates segment badges.
func (h *handler) matchRideSegments(c *gin.Context) {
	rideID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		httpx.BadRequest(c, "invalid ride id")
		return
	}
	userID := authpkg.UserID(c)
	var owned bool
	if err := h.d.DB.QueryRow(c,
		`SELECT EXISTS(SELECT 1 FROM rides WHERE id = $1 AND user_id = $2)`, rideID, userID,
	).Scan(&owned); err != nil {
		httpx.Internal(c, "could not verify ride")
		return
	}
	if !owned {
		httpx.Error(c, http.StatusNotFound, "ride not found")
		return
	}

	track, err := h.loadTrack(c, rideID)
	if err != nil {
		httpx.Internal(c, "could not load track")
		return
	}
	if len(track) < 2 {
		c.JSON(http.StatusOK, gin.H{"efforts": []Effort{}})
		return
	}

	candidates, err := h.candidateSegments(c, rideID, userID)
	if err != nil {
		httpx.Internal(c, "could not load candidate segments")
		return
	}

	efforts := make([]Effort, 0)
	for _, seg := range candidates {
		elapsed, startedAt, ok := matchSegment(track, seg.Points, segmentMatchToleranceM)
		if !ok {
			continue
		}
		avgSpeed := 0.0
		if elapsed > 0 {
			avgSpeed = seg.Distance / (elapsed / 3600.0)
		}
		// Previous best for the rider on this segment (before recording this one).
		var prevBest float64
		_ = h.d.DB.QueryRow(c,
			`SELECT COALESCE(MIN(elapsed_seconds), 0) FROM segment_efforts WHERE segment_id = $1 AND user_id = $2`,
			seg.ID, userID).Scan(&prevBest)

		if _, err := h.d.DB.Exec(c,
			`INSERT INTO segment_efforts (segment_id, ride_id, user_id, elapsed_seconds, avg_speed, started_at)
			 VALUES ($1, $2, $3, $4, $5, $6)
			 ON CONFLICT (segment_id, ride_id) DO UPDATE
			   SET elapsed_seconds = EXCLUDED.elapsed_seconds, avg_speed = EXCLUDED.avg_speed`,
			seg.ID, rideID, userID, elapsed, avgSpeed, startedAt,
		); err != nil {
			h.d.Log.Error().Err(err).Int64("segment_id", seg.ID).Msg("could not record effort")
			continue
		}
		efforts = append(efforts, Effort{
			SegmentID: seg.ID, SegmentName: seg.Name, RideID: rideID,
			ElapsedSeconds: elapsed, AvgSpeed: avgSpeed,
			IsPR: prevBest == 0 || elapsed < prevBest,
		})
	}

	// Re-evaluate badges now that efforts exist (reward consumes this idempotently).
	if h.nats != nil && len(efforts) > 0 {
		if data, err := json.Marshal(events.RideCompleted{UserID: userID, RideID: rideID}); err == nil {
			_ = h.nats.Publish(events.SubjectRideCompleted, data)
		}
	}
	c.JSON(http.StatusOK, gin.H{"efforts": efforts})
}

// loadTrack returns a ride's telemetry points in chronological order.
func (h *handler) loadTrack(c *gin.Context, rideID int64) ([]TrackPoint, error) {
	rows, err := h.d.DB.Query(c,
		`SELECT lat, lon, COALESCE(altitude, 0), COALESCE(speed, 0), ts
		 FROM telemetry_points WHERE ride_id = $1 ORDER BY ts ASC LIMIT $2`, rideID, maxTrackPoints)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	points := make([]TrackPoint, 0)
	for rows.Next() {
		var p TrackPoint
		if err := rows.Scan(&p.Lat, &p.Lon, &p.Altitude, &p.Speed, &p.Ts); err != nil {
			return nil, err
		}
		points = append(points, p)
	}
	return points, rows.Err()
}

// candidateSegments returns the public-or-owned segments whose geometry runs
// near the ride's track, so the (heavier) Go matcher only runs on plausible ones.
func (h *handler) candidateSegments(c *gin.Context, rideID, userID int64) ([]Segment, error) {
	rows, err := h.d.DB.Query(c,
		`WITH track AS (
		     SELECT ST_MakeLine(geom::geometry ORDER BY ts) AS line
		     FROM telemetry_points WHERE ride_id = $1
		 )
		 SELECT s.id, s.name, s.distance, COALESCE(ST_AsGeoJSON(s.path), '')
		 FROM segments s, track
		 WHERE (s.visibility = 'public' OR s.user_id = $2)
		   AND track.line IS NOT NULL
		   AND ST_DWithin(s.path::geography, track.line::geography, $3)`,
		rideID, userID, segmentMatchToleranceM)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	segs := make([]Segment, 0)
	for rows.Next() {
		var s Segment
		var geojson string
		if err := rows.Scan(&s.ID, &s.Name, &s.Distance, &geojson); err != nil {
			return nil, err
		}
		s.Points = parseGeoJSONLineRide(geojson)
		segs = append(segs, s)
	}
	return segs, rows.Err()
}

// matchSegment times a ride's traversal of a segment. It finds the track point
// closest to the segment's start and the one closest to its end; if both are
// within tolM and the start precedes the end, the elapsed time between them is
// the effort. Pure, so it can be unit tested without a DB. v1 keeps it simple:
// it does not detect multiple laps or partial passes.
func matchSegment(track []TrackPoint, seg []geoPoint, tolM float64) (elapsedSeconds float64, startedAt time.Time, ok bool) {
	if len(track) < 2 || len(seg) < 2 {
		return 0, time.Time{}, false
	}
	startIdx, startDist := nearestTrackIdx(track, seg[0])
	endIdx, endDist := nearestTrackIdx(track, seg[len(seg)-1])
	if startDist > tolM || endDist > tolM || startIdx >= endIdx {
		return 0, time.Time{}, false
	}
	elapsed := track[endIdx].Ts.Sub(track[startIdx].Ts).Seconds()
	if elapsed <= 0 {
		return 0, time.Time{}, false
	}
	return elapsed, track[startIdx].Ts, true
}

// nearestTrackIdx returns the index of the track point closest to target and its
// distance in metres.
func nearestTrackIdx(track []TrackPoint, target geoPoint) (idx int, distM float64) {
	best := -1
	bestD := math.MaxFloat64
	for i, p := range track {
		d := haversineMeters(p.Lat, p.Lon, target.Lat, target.Lon)
		if d < bestD {
			bestD = d
			best = i
		}
	}
	return best, bestD
}

// haversineMeters is the great-circle distance between two lat/lon pairs in metres.
func haversineMeters(lat1, lon1, lat2, lon2 float64) float64 {
	const earthRadiusM = 6371000.0
	la1, la2 := lat1*math.Pi/180, lat2*math.Pi/180
	dLat := (lat2 - lat1) * math.Pi / 180
	dLon := (lon2 - lon1) * math.Pi / 180
	h := math.Sin(dLat/2)*math.Sin(dLat/2) + math.Cos(la1)*math.Cos(la2)*math.Sin(dLon/2)*math.Sin(dLon/2)
	return 2 * earthRadiusM * math.Asin(math.Sqrt(h))
}

// lineStringWKT builds an OGC WKT LINESTRING (lon lat order) from points.
func lineStringWKT(points []geoPoint) string {
	parts := make([]string, 0, len(points))
	for _, p := range points {
		parts = append(parts, fmt.Sprintf("%g %g", p.Lon, p.Lat))
	}
	return "LINESTRING(" + strings.Join(parts, ", ") + ")"
}

// parseGeoJSONLineRide converts a PostGIS ST_AsGeoJSON LineString into points.
func parseGeoJSONLineRide(raw string) []geoPoint {
	if raw == "" {
		return []geoPoint{}
	}
	var g struct {
		Coordinates [][]float64 `json:"coordinates"`
	}
	if err := json.Unmarshal([]byte(raw), &g); err != nil {
		return []geoPoint{}
	}
	points := make([]geoPoint, 0, len(g.Coordinates))
	for _, cc := range g.Coordinates {
		if len(cc) >= 2 {
			points = append(points, geoPoint{Lon: cc[0], Lat: cc[1]})
		}
	}
	return points
}

// sortLeaderboard orders entries by elapsed time ascending (fastest first).
func sortLeaderboard(entries []LeaderboardEntry) {
	for i := 1; i < len(entries); i++ {
		for j := i; j > 0 && entries[j].ElapsedSeconds < entries[j-1].ElapsedSeconds; j-- {
			entries[j], entries[j-1] = entries[j-1], entries[j]
		}
	}
}
