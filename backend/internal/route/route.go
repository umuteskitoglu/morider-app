// Package route implements the route planning service (PostGIS backed).
package route

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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
	h := &handler{d: deps, router: NewOSRMRouter(cfg.RoutingURL, cfg.RoutingProfile)}
	registerRoutes(deps, h)
	return deps.Run(config.ResolvePort("ROUTE_PORT", "8084"))
}

func registerRoutes(d *server.Deps, h *handler) {
	g := d.Engine.Group("/api/routes", d.JWT.Middleware())
	g.POST("", h.create)
	g.POST("/plan", h.plan)
	g.GET("", h.list)
	g.GET("/explore", h.explore)
	g.GET("/:id", h.get)
	g.PUT("/:id", h.update)
	g.DELETE("/:id", h.remove)
	g.POST("/:id/rate", h.rate)
}

type handler struct {
	d      *server.Deps
	router Router
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
		plan, err := h.router.Plan(c, req.Points)
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
	Waypoints []Point `json:"waypoints" binding:"required,min=2"`
}

// plan returns a road-snapped route for the given waypoints without persisting
// anything, so the client can preview distance, duration and turn-by-turn steps.
func (h *handler) plan(c *gin.Context) {
	var req planReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.BadRequest(c, err.Error())
		return
	}
	result, err := h.router.Plan(c, req.Waypoints)
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
		        COALESCE(ag.avg, 0), COALESCE(ag.cnt, 0), COALESCE(mine.score, 0)
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
			&r.AvgRating, &r.RatingCount, &r.MyRating); err != nil {
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
		     OR (r.visibility = 'friends' AND EXISTS (
		         SELECT 1 FROM friendships f
		         WHERE f.status = 'accepted'
		           AND ((f.requester_id = $2 AND f.addressee_id = r.user_id)
		             OR (f.requester_id = r.user_id AND f.addressee_id = $2))))
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
