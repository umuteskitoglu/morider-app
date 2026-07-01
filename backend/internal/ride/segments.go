package ride

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"sort"
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

// Explore-tab de-duplication. Many riders can create near-identical kapışmalar
// on the same road; the Keşfet list folds overlapping ones behind a single
// representative (the liveliest). Two segments count as the same stretch only
// when they cover EACH OTHER by at least segmentOverlapMinCoverage within
// segmentOverlapToleranceM (see segmentsOverlap), i.e. roughly co-extensive — a
// short segment inside a longer one is a distinct kapışma, not a duplicate. This
// is purely a display concern: every segment and its leaderboard stay intact.
const (
	segmentOverlapToleranceM  = 35.0
	segmentOverlapMinCoverage = 0.8
	exploreCandidatePool      = 300 // rows scanned before clustering
	exploreLimit              = 50  // representatives returned
)

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
	// RiderCount / EffortCount surface a segment's liveliness in list views (how
	// many distinct riders have posted efforts, and how many efforts in total).
	RiderCount  int64 `json:"rider_count"`
	EffortCount int64 `json:"effort_count"`
	// VariantCount is how many overlapping kapışmalar were folded behind this one
	// in the Keşfet list (0 = it stands alone). Display-only.
	VariantCount int64 `json:"variant_count"`
}

// Effort is one timed traversal of a segment.
type Effort struct {
	SegmentID      int64   `json:"segment_id"`
	SegmentName    string  `json:"segment_name"`
	RideID         int64   `json:"ride_id"`
	ElapsedSeconds float64 `json:"elapsed_seconds"`
	AvgSpeed       float64 `json:"avg_speed"`
	IsPR           bool    `json:"is_pr"` // a new personal record for the caller
	// Rank is the caller's position on this segment's leaderboard after this
	// effort (1 = fastest); RiderCount is how many riders have an effort here.
	// The client uses these to decide whether a passive traversal is worth a
	// notification (only PR or podium), so 100 segments on one road don't spam.
	Rank       int64 `json:"rank"`
	RiderCount int64 `json:"rider_count"`
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
	// Force skips the duplicate-overlap check (the rider chose "yine de oluştur").
	Force bool `json:"force"`
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

	// Keep the data clean at the source: unless the rider insists, refuse to
	// create a kapışma that overlaps one they can already race (public or their
	// own). The client turns the 409 into a "bu yolda zaten X var" prompt.
	if !req.Force {
		if existing := h.overlappingSegment(c, authpkg.UserID(c), req.Points); existing != nil {
			c.JSON(http.StatusConflict, gin.H{"error": "overlap", "existing": existing})
			return
		}
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

// overlappingSegment returns the liveliest segment the rider can already race
// (public or their own) that covers essentially the same road as points, or nil
// if none. PostGIS prefilters by proximity; the exact test is segmentsOverlap.
// Best-effort: any DB error is treated as "no overlap" so creation still works.
func (h *handler) overlappingSegment(c *gin.Context, userID int64, points []geoPoint) *Segment {
	if len(points) < 2 {
		return nil
	}
	wkt := lineStringWKT(points)
	rows, err := h.d.DB.Query(c,
		`SELECT s.id, s.user_id, s.name, s.distance, s.visibility,
		        (SELECT COUNT(DISTINCT e.user_id) FROM segment_efforts e WHERE e.segment_id = s.id),
		        COALESCE(ST_AsGeoJSON(s.path), '')
		 FROM segments s
		 WHERE (s.visibility = 'public' OR s.user_id = $1)
		   AND ST_DWithin(s.path::geography, ST_GeomFromText($2, 4326)::geography, $3)
		 ORDER BY (SELECT COUNT(DISTINCT e.user_id) FROM segment_efforts e WHERE e.segment_id = s.id) DESC
		 LIMIT 50`, userID, wkt, segmentOverlapToleranceM)
	if err != nil {
		return nil
	}
	defer rows.Close()
	for rows.Next() {
		var s Segment
		var geojson string
		if err := rows.Scan(&s.ID, &s.UserID, &s.Name, &s.Distance, &s.Visibility, &s.RiderCount, &geojson); err != nil {
			return nil
		}
		if segmentsOverlap(parseGeoJSONLineRide(geojson), points, segmentOverlapToleranceM, segmentOverlapMinCoverage) {
			return &s // rows are popularity-ordered, so this is the liveliest match
		}
	}
	return nil
}

func (h *handler) listSegments(c *gin.Context) {
	rows, err := h.d.DB.Query(c,
		`SELECT s.id, s.user_id, s.name, s.distance, s.visibility,
		        (SELECT COUNT(DISTINCT e.user_id) FROM segment_efforts e WHERE e.segment_id = s.id),
		        (SELECT COUNT(*) FROM segment_efforts e WHERE e.segment_id = s.id)
		 FROM segments s WHERE s.user_id = $1 ORDER BY s.created_at DESC LIMIT 100`, authpkg.UserID(c))
	if err != nil {
		httpx.Internal(c, "could not list segments")
		return
	}
	c.JSON(http.StatusOK, gin.H{"segments": scanSegmentRows(rows)})
}

// exploreSegments powers the "Keşfet" tab: public segments other riders can
// join. It pulls a candidate pool ordered liveliest-first (so the most popular
// kapışma of any cluster wins), folds overlapping duplicates behind one
// representative (dedupeSegments), then presents them nearest-first when the
// client sent its position (?lat=&lon=), else liveliest-first. Each row carries
// rider/effort counts and how many duplicates it absorbed.
func (h *handler) exploreSegments(c *gin.Context) {
	lat, lon, hasLoc := parseLatLon(c)

	// Pool ordered by liveliness (distinct riders), oldest breaking ties so the
	// original of a cluster becomes its representative. Geometry is fetched here
	// because clustering needs it; it is stripped from the response below.
	rows, err := h.d.DB.Query(c,
		`SELECT s.id, s.user_id, s.name, s.distance, s.visibility,
		        (SELECT COUNT(DISTINCT e.user_id) FROM segment_efforts e WHERE e.segment_id = s.id),
		        (SELECT COUNT(*) FROM segment_efforts e WHERE e.segment_id = s.id),
		        COALESCE(ST_AsGeoJSON(s.path), '')
		 FROM segments s
		 WHERE s.visibility = 'public' AND s.user_id <> $1
		 ORDER BY (SELECT COUNT(DISTINCT e.user_id) FROM segment_efforts e WHERE e.segment_id = s.id) DESC,
		          s.created_at ASC
		 LIMIT $2`, authpkg.UserID(c), exploreCandidatePool)
	if err != nil {
		httpx.Internal(c, "could not load segments")
		return
	}
	defer rows.Close()

	pool := make([]Segment, 0)
	for rows.Next() {
		var s Segment
		var geojson string
		if err := rows.Scan(&s.ID, &s.UserID, &s.Name, &s.Distance, &s.Visibility,
			&s.RiderCount, &s.EffortCount, &geojson); err != nil {
			httpx.Internal(c, "could not read segments")
			return
		}
		s.Points = parseGeoJSONLineRide(geojson)
		pool = append(pool, s)
	}

	reps := dedupeSegments(pool)
	if hasLoc {
		// Nearest first, by the representative's start point.
		sort.SliceStable(reps, func(i, j int) bool {
			return startDistM(reps[i], lat, lon) < startDistM(reps[j], lat, lon)
		})
	}
	if len(reps) > exploreLimit {
		reps = reps[:exploreLimit]
	}
	// List views are light: drop the geometry we only needed for clustering.
	for i := range reps {
		reps[i].Points = nil
	}
	c.JSON(http.StatusOK, gin.H{"segments": reps})
}

// startDistM is the distance in metres from a segment's start to (lat, lon); a
// segment with no geometry sorts last.
func startDistM(s Segment, lat, lon float64) float64 {
	if len(s.Points) == 0 {
		return math.MaxFloat64
	}
	return haversineMeters(s.Points[0].Lat, s.Points[0].Lon, lat, lon)
}

// dedupeSegments folds overlapping kapışmalar behind one representative. The
// pool must be ordered so the preferred representative of each cluster comes
// first (liveliest, then oldest); each later segment either merges into the
// first representative it overlaps (bumping its VariantCount) or starts a new
// one. Greedy against representatives only, so clusters can't chain-merge.
func dedupeSegments(pool []Segment) []Segment {
	reps := make([]Segment, 0, len(pool))
	for _, s := range pool {
		merged := false
		for i := range reps {
			// Cheap reject first: if the starts are farther apart than both
			// lengths combined they cannot share road within tolerance.
			gap := haversineMeters(reps[i].Points[0].Lat, reps[i].Points[0].Lon, s.Points[0].Lat, s.Points[0].Lon)
			if gap > (reps[i].Distance+s.Distance)*1000+segmentOverlapToleranceM {
				continue
			}
			if segmentsOverlap(reps[i].Points, s.Points, segmentOverlapToleranceM, segmentOverlapMinCoverage) {
				reps[i].VariantCount++
				merged = true
				break
			}
		}
		if !merged {
			reps = append(reps, s)
		}
	}
	return reps
}

// segmentsOverlap reports whether a and b are essentially the SAME kapışma:
// each polyline must cover the other (≥ minCoverage of its vertices within tolM),
// so the two are roughly co-extensive. This deliberately uses the *lesser* of
// the two directional coverages: a short segment that merely sits inside a longer
// one covers the long one only fractionally, so it stays a distinct kapışma — a
// short technical stretch is a valid race in its own right, not a duplicate of
// the long run it lives on. Pure and direction-agnostic; unit-tested without a DB.
func segmentsOverlap(a, b []geoPoint, tolM, minCoverage float64) bool {
	if len(a) < 2 || len(b) < 2 {
		return false
	}
	return coverage(a, b, tolM) >= minCoverage && coverage(b, a, tolM) >= minCoverage
}

// coverage is the fraction of a's vertices lying within tolM of polyline b.
func coverage(a, b []geoPoint, tolM float64) float64 {
	hit := 0
	for _, p := range a {
		if pointToPolylineM(p, b) <= tolM {
			hit++
		}
	}
	return float64(hit) / float64(len(a))
}

// pointToPolylineM is the shortest distance in metres from p to any edge of the
// polyline line (point-to-edge, not just to vertices, so sparse polylines match).
func pointToPolylineM(p geoPoint, line []geoPoint) float64 {
	best := math.MaxFloat64
	for i := 0; i+1 < len(line); i++ {
		if d := distPointToSegmentM(p, line[i], line[i+1]); d < best {
			best = d
		}
	}
	return best
}

// distPointToSegmentM is the distance in metres from p to the edge a→b, using a
// local equirectangular projection (accurate at street scale) and the standard
// point-to-line-segment projection.
func distPointToSegmentM(p, a, b geoPoint) float64 {
	const R = 6371000.0
	lat0 := (a.Lat + b.Lat + p.Lat) / 3 * math.Pi / 180
	proj := func(g geoPoint) (x, y float64) {
		return (g.Lon * math.Pi / 180) * math.Cos(lat0) * R, (g.Lat * math.Pi / 180) * R
	}
	px, py := proj(p)
	ax, ay := proj(a)
	bx, by := proj(b)
	dx, dy := bx-ax, by-ay
	if dx == 0 && dy == 0 {
		return math.Hypot(px-ax, py-ay)
	}
	t := ((px-ax)*dx + (py-ay)*dy) / (dx*dx + dy*dy)
	if t < 0 {
		t = 0
	} else if t > 1 {
		t = 1
	}
	return math.Hypot(px-(ax+t*dx), py-(ay+t*dy))
}

// parseLatLon reads optional ?lat=&lon= query params. hasLoc is false unless
// both parse to valid coordinates.
func parseLatLon(c *gin.Context) (lat, lon float64, hasLoc bool) {
	ls, os := c.Query("lat"), c.Query("lon")
	if ls == "" || os == "" {
		return 0, 0, false
	}
	la, err1 := strconv.ParseFloat(ls, 64)
	lo, err2 := strconv.ParseFloat(os, 64)
	if err1 != nil || err2 != nil || la < -90 || la > 90 || lo < -180 || lo > 180 {
		return 0, 0, false
	}
	return la, lo, true
}

// scanSegmentRows reads list rows (without geometry) into Segments. It closes
// the rows. Geometry is omitted from list views to keep payloads light.
func scanSegmentRows(rows pgx.Rows) []Segment {
	defer rows.Close()
	segs := make([]Segment, 0)
	for rows.Next() {
		var s Segment
		if err := rows.Scan(&s.ID, &s.UserID, &s.Name, &s.Distance, &s.Visibility, &s.RiderCount, &s.EffortCount); err != nil {
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
		// Rank the caller among all riders' best times on this segment (ties share
		// a rank). Best-effort: a failure just leaves rank/count at 0.
		var rank, riderCount int64
		_ = h.d.DB.QueryRow(c,
			`WITH bests AS (
			     SELECT user_id, MIN(elapsed_seconds) AS best
			     FROM segment_efforts WHERE segment_id = $1 GROUP BY user_id
			 )
			 SELECT (SELECT COUNT(*) FROM bests),
			        (SELECT COUNT(*) FROM bests WHERE best < me.best) + 1
			 FROM bests me WHERE me.user_id = $2`,
			seg.ID, userID).Scan(&riderCount, &rank)

		efforts = append(efforts, Effort{
			SegmentID: seg.ID, SegmentName: seg.Name, RideID: rideID,
			ElapsedSeconds: elapsed, AvgSpeed: avgSpeed,
			IsPR:       prevBest == 0 || elapsed < prevBest,
			Rank:       rank,
			RiderCount: riderCount,
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
