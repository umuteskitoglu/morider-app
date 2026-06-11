package route

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	"github.com/morider/backend/internal/server"
	authpkg "github.com/morider/backend/pkg/auth"
	"github.com/morider/backend/pkg/httpx"
)

// poiRouteRadiusM is how far (meters) from a route's geometry a POI may sit
// and still count as "on the route".
const poiRouteRadiusM = 1000

// maxPOIsPerQuery caps list responses so a world-spanning bbox can't dump the
// whole table.
const maxPOIsPerQuery = 300

// POI is a community point of interest: a moto-friendly cafe, fuel stop,
// repair shop, viewpoint or rest area.
type POI struct {
	ID          int64   `json:"id"`
	UserID      int64   `json:"user_id"`
	Name        string  `json:"name"`
	Category    string  `json:"category"`
	Description string  `json:"description"`
	Lat         float64 `json:"lat"`
	Lon         float64 `json:"lon"`
	OwnerName   string  `json:"owner_name"`
}

func registerPOIRoutes(d *server.Deps, h *handler) {
	g := d.Engine.Group("/api/pois", d.JWT.Middleware())
	g.POST("", h.createPOI)
	g.GET("", h.listPOIs)
	g.GET("/route/:id", h.routePOIs)
	g.DELETE("/:id", h.deletePOI)
}

type poiCreateReq struct {
	Name        string `json:"name" binding:"required,max=120"`
	Category    string `json:"category" binding:"required,oneof=cafe fuel repair viewpoint rest"`
	Description string `json:"description" binding:"max=500"`
	// No `required` on coordinates: 0 is a legal value and gin's required
	// binding would reject it as missing.
	Lat float64 `json:"lat" binding:"min=-90,max=90"`
	Lon float64 `json:"lon" binding:"min=-180,max=180"`
}

// createPOI adds a community POI at the given coordinate. POIs are visible to
// everyone; only the creator can delete theirs.
func (h *handler) createPOI(c *gin.Context) {
	var req poiCreateReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.BadRequest(c, err.Error())
		return
	}
	me := authpkg.UserID(c)
	var id int64
	err := h.d.DB.QueryRow(c,
		`INSERT INTO pois (user_id, name, category, description, location)
		 VALUES ($1, $2, $3, $4, ST_SetSRID(ST_MakePoint($5, $6), 4326))
		 RETURNING id`,
		me, req.Name, req.Category, req.Description, req.Lon, req.Lat,
	).Scan(&id)
	if err != nil {
		httpx.Internal(c, "could not create poi")
		return
	}
	c.JSON(http.StatusCreated, POI{
		ID: id, UserID: me, Name: req.Name, Category: req.Category,
		Description: req.Description, Lat: req.Lat, Lon: req.Lon,
	})
}

// listPOIs returns POIs inside a bounding box (min_lat, min_lon, max_lat,
// max_lon query params). Used by the live map as the viewport moves.
func (h *handler) listPOIs(c *gin.Context) {
	minLat, err1 := strconv.ParseFloat(c.Query("min_lat"), 64)
	minLon, err2 := strconv.ParseFloat(c.Query("min_lon"), 64)
	maxLat, err3 := strconv.ParseFloat(c.Query("max_lat"), 64)
	maxLon, err4 := strconv.ParseFloat(c.Query("max_lon"), 64)
	if err1 != nil || err2 != nil || err3 != nil || err4 != nil {
		httpx.BadRequest(c, "min_lat, min_lon, max_lat, max_lon are required")
		return
	}
	if minLat > maxLat || minLon > maxLon {
		httpx.BadRequest(c, "invalid bounding box")
		return
	}
	rows, err := h.d.DB.Query(c,
		`SELECT p.id, p.user_id, p.name, p.category, COALESCE(p.description, ''),
		        ST_Y(p.location), ST_X(p.location), u.name
		 FROM pois p JOIN users u ON u.id = p.user_id
		 WHERE p.location && ST_MakeEnvelope($1, $2, $3, $4, 4326)
		 ORDER BY p.created_at DESC
		 LIMIT $5`,
		minLon, minLat, maxLon, maxLat, maxPOIsPerQuery)
	if err != nil {
		httpx.Internal(c, "could not list pois")
		return
	}
	defer rows.Close()
	pois, err := scanPOIs(rows)
	if err != nil {
		httpx.Internal(c, "could not read pois")
		return
	}
	c.JSON(http.StatusOK, gin.H{"pois": pois})
}

// routePOIs returns the POIs within poiRouteRadiusM of a route's geometry.
// Same visibility rules as fetching the route itself.
func (h *handler) routePOIs(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		httpx.BadRequest(c, "invalid route id")
		return
	}
	me := authpkg.UserID(c)

	var visible bool
	err = h.d.DB.QueryRow(c,
		`SELECT EXISTS (
		   SELECT 1 FROM routes r
		   WHERE r.id = $1 AND (
		       r.user_id = $2
		       OR r.visibility = 'public'
		       OR (r.visibility = 'friends'
		           AND EXISTS (SELECT 1 FROM follows a WHERE a.follower_id = $2 AND a.followee_id = r.user_id)
		           AND EXISTS (SELECT 1 FROM follows b WHERE b.follower_id = r.user_id AND b.followee_id = $2))
		   ))`, id, me).Scan(&visible)
	if err != nil {
		httpx.Internal(c, "could not load route")
		return
	}
	if !visible {
		httpx.Error(c, http.StatusNotFound, "route not found")
		return
	}

	rows, err := h.d.DB.Query(c,
		`SELECT p.id, p.user_id, p.name, p.category, COALESCE(p.description, ''),
		        ST_Y(p.location), ST_X(p.location), u.name
		 FROM pois p
		 JOIN users u ON u.id = p.user_id
		 JOIN routes r ON r.id = $1
		 WHERE ST_DWithin(p.location::geography, r.path::geography, $2)
		 ORDER BY p.created_at DESC
		 LIMIT $3`,
		id, poiRouteRadiusM, maxPOIsPerQuery)
	if err != nil {
		httpx.Internal(c, "could not list pois")
		return
	}
	defer rows.Close()
	pois, err := scanPOIs(rows)
	if err != nil {
		httpx.Internal(c, "could not read pois")
		return
	}
	c.JSON(http.StatusOK, gin.H{"pois": pois})
}

// deletePOI removes one of the caller's own POIs.
func (h *handler) deletePOI(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		httpx.BadRequest(c, "invalid poi id")
		return
	}
	tag, err := h.d.DB.Exec(c,
		`DELETE FROM pois WHERE id = $1 AND user_id = $2`, id, authpkg.UserID(c))
	if err != nil {
		httpx.Internal(c, "could not delete poi")
		return
	}
	if tag.RowsAffected() == 0 {
		httpx.Error(c, http.StatusNotFound, "poi not found")
		return
	}
	c.Status(http.StatusNoContent)
}

func scanPOIs(rows pgx.Rows) ([]POI, error) {
	pois := make([]POI, 0)
	for rows.Next() {
		var p POI
		if err := rows.Scan(&p.ID, &p.UserID, &p.Name, &p.Category, &p.Description,
			&p.Lat, &p.Lon, &p.OwnerName); err != nil {
			return nil, err
		}
		pois = append(pois, p)
	}
	return pois, rows.Err()
}
