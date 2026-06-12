// Package route implements the route planning service (PostGIS backed).
package route

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	"github.com/morider/backend/internal/server"
	authpkg "github.com/morider/backend/pkg/auth"
	"github.com/morider/backend/pkg/config"
	"github.com/morider/backend/pkg/httpx"
)

// Run boots the route service.
func Run(cfg config.Config) error {
	deps, err := server.New(context.Background(), "route", cfg)
	if err != nil {
		return err
	}
	h := &handler{
		d:      deps,
		router: NewOSRMRouter(cfg.RoutingURL, cfg.RoutingProfile),
		elev:   NewOpenTopoData(cfg.ElevationURL),
	}
	registerRoutes(deps, h)
	registerPOIRoutes(deps, h)
	return deps.Run(config.ResolvePort("ROUTE_PORT", "8084"))
}

func registerRoutes(d *server.Deps, h *handler) {
	g := d.Engine.Group("/api/routes", d.JWT.Middleware())
	g.POST("", h.create)
	g.POST("/plan", h.plan)
	g.GET("", h.list)
	g.GET("/explore", h.explore)
	g.GET("/:id", h.get)
	g.GET("/:id/gpx", h.exportGPX)
	g.GET("/:id/kml", h.exportKML)
	g.GET("/:id/elevation", h.elevation)
	g.PUT("/:id", h.update)
	g.DELETE("/:id", h.remove)
	g.POST("/:id/rate", h.rate)
	g.POST("/import/gpx", h.importGPX)
	g.POST("/import/kml", h.importKML)
}

type handler struct {
	d      *server.Deps
	router Router
	elev   ElevationProvider
}

// Point is a single coordinate (WGS84).
type Point struct {
	Lat float64 `json:"lat"`
	Lon float64 `json:"lon"`
}

// Route is the API representation of a planned route.
type Route struct {
	ID          int64   `json:"id"`
	UserID      int64   `json:"user_id"`
	Name        string  `json:"name"`
	Description string  `json:"description"`
	Distance    float64 `json:"distance"`
	Visibility  string  `json:"visibility"`
	OwnerName   string  `json:"owner_name,omitempty"`
	AvgRating   float64 `json:"avg_rating"`
	RatingCount int64   `json:"rating_count"`
	MyRating    int     `json:"my_rating"`
	IFollow     bool    `json:"i_follow"`
	Points      []Point `json:"points"`
}

type writeReq struct {
	Name        string  `json:"name" binding:"required"`
	Description string  `json:"description"`
	Points      []Point `json:"points" binding:"required,min=2"`
	// Visibility: private (default), public (shows in Explore) or friends.
	Visibility string `json:"visibility" binding:"omitempty,oneof=private public friends"`
	// Snap, when true, runs the waypoints through the routing engine and stores
	// the road-following geometry instead of the raw straight-line waypoints.
	Snap bool `json:"snap"`
	// Curviness in [0,1] (only with snap): prefer straighter (0) or twistier
	// (1) alternatives. Omitted = engine default route.
	Curviness *float64 `json:"curviness" binding:"omitempty,min=0,max=1"`
}

// planOpts converts an optional request curviness into PlanOptions.
func planOpts(curviness *float64) PlanOptions {
	if curviness == nil {
		return PlanOptions{}
	}
	return PlanOptions{UseCurviness: true, Curviness: *curviness}
}

// normalizeVisibility defaults an empty value to private.
func normalizeVisibility(v string) string {
	if v == "" {
		return "private"
	}
	return v
}

func (h *handler) create(c *gin.Context) {
	var req writeReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.BadRequest(c, err.Error())
		return
	}

	points := req.Points
	if req.Snap {
		plan, err := h.router.Plan(c, req.Points, planOpts(req.Curviness))
		if err != nil {
			httpx.Error(c, http.StatusBadGateway, "could not snap route to roads")
			return
		}
		points = plan.Points
	}
	wkt := LineStringWKT(points)
	vis := normalizeVisibility(req.Visibility)

	var id int64
	var distance float64
	err := h.d.DB.QueryRow(c,
		`INSERT INTO routes (user_id, name, description, path, distance, visibility)
		 VALUES ($1, $2, $3, ST_GeomFromText($4, 4326),
		         ST_Length(ST_GeomFromText($4, 4326)::geography) / 1000.0, $5)
		 RETURNING id, distance`,
		authpkg.UserID(c), req.Name, req.Description, wkt, vis,
	).Scan(&id, &distance)
	if err != nil {
		httpx.Internal(c, "could not create route")
		return
	}
	c.JSON(http.StatusCreated, Route{
		ID:          id,
		UserID:      authpkg.UserID(c),
		Name:        req.Name,
		Description: req.Description,
		Distance:    distance,
		Visibility:  vis,
		Points:      points,
	})
}

type planReq struct {
	Waypoints []Point  `json:"waypoints" binding:"required,min=2"`
	Curviness *float64 `json:"curviness" binding:"omitempty,min=0,max=1"`
}

// plan returns a road-snapped route for the given waypoints without persisting
// anything, so the client can preview distance, duration and turn-by-turn steps.
func (h *handler) plan(c *gin.Context) {
	var req planReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.BadRequest(c, err.Error())
		return
	}
	result, err := h.router.Plan(c, req.Waypoints, planOpts(req.Curviness))
	if err != nil {
		httpx.Error(c, http.StatusBadGateway, "routing failed: "+err.Error())
		return
	}
	c.JSON(http.StatusOK, result)
}

func (h *handler) list(c *gin.Context) {
	rows, err := h.d.DB.Query(c,
		`SELECT id, user_id, name, COALESCE(description, ''), distance, visibility
		 FROM routes WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
		authpkg.UserID(c))
	if err != nil {
		httpx.Internal(c, "could not list routes")
		return
	}
	defer rows.Close()

	routes := make([]Route, 0)
	for rows.Next() {
		var r Route
		if err := rows.Scan(&r.ID, &r.UserID, &r.Name, &r.Description, &r.Distance, &r.Visibility); err != nil {
			httpx.Internal(c, "could not read routes")
			return
		}
		routes = append(routes, r)
	}
	c.JSON(http.StatusOK, gin.H{"routes": routes})
}

// explore lists other users' public routes for the community feed.
func (h *handler) explore(c *gin.Context) {
	rows, err := h.d.DB.Query(c,
		`SELECT r.id, r.user_id, r.name, COALESCE(r.description, ''), r.distance, r.visibility, u.name,
		        COALESCE(ag.avg, 0), COALESCE(ag.cnt, 0), COALESCE(mine.score, 0),
		        EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.followee_id = r.user_id)
		 FROM routes r
		 JOIN users u ON u.id = r.user_id
		 LEFT JOIN (SELECT route_id, AVG(score)::float8 AS avg, COUNT(*) AS cnt
		            FROM route_ratings GROUP BY route_id) ag ON ag.route_id = r.id
		 LEFT JOIN route_ratings mine ON mine.route_id = r.id AND mine.user_id = $1
		 WHERE r.visibility = 'public' AND r.user_id <> $1
		 ORDER BY r.created_at DESC LIMIT 50`,
		authpkg.UserID(c))
	if err != nil {
		httpx.Internal(c, "could not load explore feed")
		return
	}
	defer rows.Close()

	routes := make([]Route, 0)
	for rows.Next() {
		var r Route
		if err := rows.Scan(&r.ID, &r.UserID, &r.Name, &r.Description, &r.Distance, &r.Visibility, &r.OwnerName,
			&r.AvgRating, &r.RatingCount, &r.MyRating, &r.IFollow); err != nil {
			httpx.Internal(c, "could not read explore feed")
			return
		}
		routes = append(routes, r)
	}
	c.JSON(http.StatusOK, gin.H{"routes": routes})
}

type rateReq struct {
	Score int `json:"score" binding:"required,min=1,max=5"`
}

// rate upserts the caller's 1..5 rating for a route they can see (public or own)
// and returns the updated aggregate.
func (h *handler) rate(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		httpx.BadRequest(c, "invalid route id")
		return
	}
	var req rateReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.BadRequest(c, err.Error())
		return
	}

	uid := authpkg.UserID(c)
	var visibility string
	var ownerID int64
	err = h.d.DB.QueryRow(c, `SELECT visibility, user_id FROM routes WHERE id = $1`, id).Scan(&visibility, &ownerID)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(c, http.StatusNotFound, "route not found")
		return
	}
	if err != nil {
		httpx.Internal(c, "could not load route")
		return
	}
	if visibility != "public" && ownerID != uid {
		httpx.Error(c, http.StatusForbidden, "route is not public")
		return
	}

	if _, err := h.d.DB.Exec(c,
		`INSERT INTO route_ratings (route_id, user_id, score)
		 VALUES ($1, $2, $3)
		 ON CONFLICT (route_id, user_id) DO UPDATE SET score = EXCLUDED.score, created_at = now()`,
		id, uid, req.Score,
	); err != nil {
		httpx.Internal(c, "could not save rating")
		return
	}

	var avg float64
	var cnt int64
	if err := h.d.DB.QueryRow(c,
		`SELECT COALESCE(AVG(score)::float8, 0), COUNT(*) FROM route_ratings WHERE route_id = $1`, id,
	).Scan(&avg, &cnt); err != nil {
		httpx.Internal(c, "could not load rating")
		return
	}
	c.JSON(http.StatusOK, gin.H{"avg_rating": avg, "rating_count": cnt, "my_rating": req.Score})
}

func (h *handler) get(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		httpx.BadRequest(c, "invalid route id")
		return
	}
	var (
		r       Route
		geojson string
	)
	// Visible to the owner, or to anyone if the route is public.
	err = h.d.DB.QueryRow(c,
		`SELECT r.id, r.user_id, r.name, COALESCE(r.description, ''), r.distance, r.visibility, u.name,
		        COALESCE(ag.avg, 0), COALESCE(ag.cnt, 0), COALESCE(mine.score, 0),
		        COALESCE(ST_AsGeoJSON(r.path), '')
		 FROM routes r
		 JOIN users u ON u.id = r.user_id
		 LEFT JOIN (SELECT route_id, AVG(score)::float8 AS avg, COUNT(*) AS cnt
		            FROM route_ratings GROUP BY route_id) ag ON ag.route_id = r.id
		 LEFT JOIN route_ratings mine ON mine.route_id = r.id AND mine.user_id = $2
		 WHERE r.id = $1 AND (
		     r.user_id = $2
		     OR r.visibility = 'public'
		     OR (r.visibility = 'friends'
		         AND EXISTS (SELECT 1 FROM follows a WHERE a.follower_id = $2 AND a.followee_id = r.user_id)
		         AND EXISTS (SELECT 1 FROM follows b WHERE b.follower_id = r.user_id AND b.followee_id = $2))
		 )`, id, authpkg.UserID(c),
	).Scan(&r.ID, &r.UserID, &r.Name, &r.Description, &r.Distance, &r.Visibility, &r.OwnerName,
		&r.AvgRating, &r.RatingCount, &r.MyRating, &geojson)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(c, http.StatusNotFound, "route not found")
		return
	}
	if err != nil {
		httpx.Internal(c, "could not load route")
		return
	}
	r.Points = parseGeoJSONLine(geojson)
	c.JSON(http.StatusOK, r)
}

func (h *handler) update(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		httpx.BadRequest(c, "invalid route id")
		return
	}
	var req writeReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.BadRequest(c, err.Error())
		return
	}
	wkt := LineStringWKT(req.Points)
	vis := normalizeVisibility(req.Visibility)
	var distance float64
	err = h.d.DB.QueryRow(c,
		`UPDATE routes
		 SET name = $3, description = $4,
		     path = ST_GeomFromText($5, 4326),
		     distance = ST_Length(ST_GeomFromText($5, 4326)::geography) / 1000.0,
		     visibility = $6
		 WHERE id = $1 AND user_id = $2
		 RETURNING distance`,
		id, authpkg.UserID(c), req.Name, req.Description, wkt, vis,
	).Scan(&distance)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(c, http.StatusNotFound, "route not found")
		return
	}
	if err != nil {
		httpx.Internal(c, "could not update route")
		return
	}
	c.JSON(http.StatusOK, Route{
		ID:          id,
		UserID:      authpkg.UserID(c),
		Name:        req.Name,
		Description: req.Description,
		Distance:    distance,
		Visibility:  vis,
		Points:      req.Points,
	})
}

func (h *handler) remove(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		httpx.BadRequest(c, "invalid route id")
		return
	}
	tag, err := h.d.DB.Exec(c, `DELETE FROM routes WHERE id = $1 AND user_id = $2`, id, authpkg.UserID(c))
	if err != nil {
		httpx.Internal(c, "could not delete route")
		return
	}
	if tag.RowsAffected() == 0 {
		httpx.Error(c, http.StatusNotFound, "route not found")
		return
	}
	c.Status(http.StatusNoContent)
}

// exportGPX streams the route geometry as a GPX 1.1 file. Same visibility
// rules as get: owner, public, or friends via mutual follow.
func (h *handler) exportGPX(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		httpx.BadRequest(c, "invalid route id")
		return
	}
	var (
		name    string
		geojson string
	)
	err = h.d.DB.QueryRow(c,
		`SELECT r.name, COALESCE(ST_AsGeoJSON(r.path), '')
		 FROM routes r
		 WHERE r.id = $1 AND (
		     r.user_id = $2
		     OR r.visibility = 'public'
		     OR (r.visibility = 'friends'
		         AND EXISTS (SELECT 1 FROM follows a WHERE a.follower_id = $2 AND a.followee_id = r.user_id)
		         AND EXISTS (SELECT 1 FROM follows b WHERE b.follower_id = r.user_id AND b.followee_id = $2))
		 )`, id, authpkg.UserID(c),
	).Scan(&name, &geojson)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(c, http.StatusNotFound, "route not found")
		return
	}
	if err != nil {
		httpx.Internal(c, "could not load route")
		return
	}
	points := parseGeoJSONLine(geojson)
	if len(points) < 2 {
		httpx.Error(c, http.StatusUnprocessableEntity, "route has no geometry")
		return
	}
	c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=%q", gpxFilename(name)))
	c.Data(http.StatusOK, "application/gpx+xml", BuildGPX(name, points))
}

// importGPX creates a private route from a GPX document posted as the raw
// request body. The route name comes from the file (metadata/track name).
func (h *handler) importGPX(c *gin.Context) {
	body, err := io.ReadAll(io.LimitReader(c.Request.Body, 10<<20))
	if err != nil || len(body) == 0 {
		httpx.BadRequest(c, "empty or unreadable GPX body")
		return
	}
	name, points, err := ParseGPX(body)
	if err != nil {
		httpx.BadRequest(c, err.Error())
		return
	}
	if name == "" {
		name = "GPX Rotası"
	}
	wkt := LineStringWKT(points)

	var id int64
	var distance float64
	err = h.d.DB.QueryRow(c,
		`INSERT INTO routes (user_id, name, description, path, distance, visibility)
		 VALUES ($1, $2, '', ST_GeomFromText($3, 4326),
		         ST_Length(ST_GeomFromText($3, 4326)::geography) / 1000.0, 'private')
		 RETURNING id, distance`,
		authpkg.UserID(c), name, wkt,
	).Scan(&id, &distance)
	if err != nil {
		httpx.Internal(c, "could not import route")
		return
	}
	c.JSON(http.StatusCreated, Route{
		ID:         id,
		UserID:     authpkg.UserID(c),
		Name:       name,
		Distance:   distance,
		Visibility: "private",
		Points:     points,
	})
}

// exportKML streams the route geometry as a KML 2.2 file. Same visibility
// rules as exportGPX (owner / public / friends via mutual follow).
func (h *handler) exportKML(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		httpx.BadRequest(c, "invalid route id")
		return
	}
	var (
		name    string
		geojson string
	)
	err = h.d.DB.QueryRow(c,
		`SELECT r.name, COALESCE(ST_AsGeoJSON(r.path), '')
		 FROM routes r
		 WHERE r.id = $1 AND (
		     r.user_id = $2
		     OR r.visibility = 'public'
		     OR (r.visibility = 'friends'
		         AND EXISTS (SELECT 1 FROM follows a WHERE a.follower_id = $2 AND a.followee_id = r.user_id)
		         AND EXISTS (SELECT 1 FROM follows b WHERE b.follower_id = r.user_id AND b.followee_id = $2))
		 )`, id, authpkg.UserID(c),
	).Scan(&name, &geojson)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(c, http.StatusNotFound, "route not found")
		return
	}
	if err != nil {
		httpx.Internal(c, "could not load route")
		return
	}
	points := parseGeoJSONLine(geojson)
	if len(points) < 2 {
		httpx.Error(c, http.StatusUnprocessableEntity, "route has no geometry")
		return
	}
	c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=%q", kmlFilename(name)))
	c.Data(http.StatusOK, "application/vnd.google-earth.kml+xml", BuildKML(name, points))
}

// importKML creates a private route from a KML 2.2 document posted as the
// raw request body. Name comes from the Document or first Placemark.
func (h *handler) importKML(c *gin.Context) {
	body, err := io.ReadAll(io.LimitReader(c.Request.Body, 10<<20))
	if err != nil || len(body) == 0 {
		httpx.BadRequest(c, "empty or unreadable KML body")
		return
	}
	name, points, err := ParseKML(body)
	if err != nil {
		httpx.BadRequest(c, err.Error())
		return
	}
	if name == "" {
		name = "KML Rotası"
	}
	wkt := LineStringWKT(points)
	var id int64
	var distance float64
	err = h.d.DB.QueryRow(c,
		`INSERT INTO routes (user_id, name, description, path, distance, visibility)
		 VALUES ($1, $2, '', ST_GeomFromText($3, 4326),
		         ST_Length(ST_GeomFromText($3, 4326)::geography) / 1000.0, 'private')
		 RETURNING id, distance`,
		authpkg.UserID(c), name, wkt,
	).Scan(&id, &distance)
	if err != nil {
		httpx.Internal(c, "could not import route")
		return
	}
	c.JSON(http.StatusCreated, Route{
		ID:         id,
		UserID:     authpkg.UserID(c),
		Name:       name,
		Distance:   distance,
		Visibility: "private",
		Points:     points,
	})
}

// gpxFilenameBase sanitises a route name to safe ASCII (no extension).
func gpxFilenameBase(name string) string {
	var b strings.Builder
	for _, r := range strings.TrimSpace(name) {
		switch {
		case (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_':
			b.WriteRune(r)
		case r == ' ':
			b.WriteByte('-')
		}
	}
	if b.Len() == 0 {
		return "route"
	}
	return b.String()
}

// gpxFilename turns a route name into a safe ASCII .gpx attachment filename.
func gpxFilename(name string) string { return gpxFilenameBase(name) + ".gpx" }

// parseGeoJSONLine converts a PostGIS ST_AsGeoJSON LineString into points.
func parseGeoJSONLine(raw string) []Point {
	if raw == "" {
		return []Point{}
	}
	var g struct {
		Coordinates [][]float64 `json:"coordinates"`
	}
	if err := json.Unmarshal([]byte(raw), &g); err != nil {
		return []Point{}
	}
	points := make([]Point, 0, len(g.Coordinates))
	for _, c := range g.Coordinates {
		if len(c) >= 2 {
			points = append(points, Point{Lon: c[0], Lat: c[1]})
		}
	}
	return points
}

// LineStringWKT builds an OGC WKT LINESTRING (lon lat order) from points.
func LineStringWKT(points []Point) string {
	parts := make([]string, 0, len(points))
	for _, p := range points {
		parts = append(parts, fmt.Sprintf("%g %g", p.Lon, p.Lat))
	}
	return "LINESTRING(" + strings.Join(parts, ", ") + ")"
}
