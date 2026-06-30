package ride

import (
	"errors"
	"net/http"
	"sort"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	authpkg "github.com/morider/backend/pkg/auth"
	"github.com/morider/backend/pkg/httpx"
)

// Fuel log: per-motorcycle refuelling records. Full fills feed the "full-to-full"
// consumption calculation (litres burned between two brim-full tanks over the
// distance covered), which is written back to motorcycles.avg_consumption so the
// app can show real-world L/100km and remaining range.

// FuelLog is the API representation of one refuelling.
type FuelLog struct {
	ID         int64   `json:"id"`
	Liters     float64 `json:"liters"`
	Cost       float64 `json:"cost"`
	OdometerKm int     `json:"odometer_km"`
	IsFullTank bool    `json:"is_full_tank"`
	Lat        float64 `json:"lat"`
	Lon        float64 `json:"lon"`
	FilledAt   string  `json:"filled_at"`
}

// FuelSummary is the derived consumption/cost picture for a motorcycle.
type FuelSummary struct {
	AvgConsumption float64 `json:"avg_consumption"` // L/100km, 0 when not derivable
	TotalLiters    float64 `json:"total_liters"`
	TotalCost      float64 `json:"total_cost"`
	DistanceKm     int     `json:"distance_km"` // span between first and last full fill
	CostPerKm      float64 `json:"cost_per_km"` // 0 when distance unknown
}

func registerFuelRoutes(g *gin.RouterGroup, h *handler) {
	g.POST("/:id/fuel", h.addFuelLog)
	g.GET("/:id/fuel", h.listFuelLogs)
	g.DELETE("/:id/fuel/:fid", h.removeFuelLog)
}

type fuelReq struct {
	Liters     float64 `json:"liters" binding:"required,min=0,max=200"`
	Cost       float64 `json:"cost" binding:"omitempty,min=0"`
	OdometerKm int     `json:"odometer_km" binding:"required,min=0,max=2000000"`
	// IsFullTank defaults to true via the *bool dance below: only full fills feed
	// the consumption math, and a brim-full fill is the common case.
	IsFullTank *bool    `json:"is_full_tank"`
	Lat        *float64 `json:"lat"`
	Lon        *float64 `json:"lon"`
	// FilledAt "YYYY-MM-DD"; empty = today.
	FilledAt string `json:"filled_at"`
}

func (h *handler) addFuelLog(c *gin.Context) {
	motoID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		httpx.BadRequest(c, "invalid motorcycle id")
		return
	}
	var req fuelReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.BadRequest(c, err.Error())
		return
	}
	when, ok := parseDate(req.FilledAt)
	if !ok {
		httpx.BadRequest(c, "filled_at must be YYYY-MM-DD")
		return
	}
	full := true
	if req.IsFullTank != nil {
		full = *req.IsFullTank
	}

	// Ownership check and insert in one statement, mirroring addServiceRecord, so
	// a concurrently deleted motorcycle yields a clean 404 instead of an FK error.
	// when may be nil → COALESCE falls back to the DB default (CURRENT_DATE).
	var id int64
	err = h.d.DB.QueryRow(c,
		`INSERT INTO fuel_logs (motorcycle_id, liters, cost, odometer_km, is_full_tank, lat, lon, filled_at)
		 SELECT m.id, $3, $4, $5, $6, $7, $8, COALESCE($9, CURRENT_DATE) FROM motorcycles m
		 WHERE m.id = $1 AND m.user_id = $2
		 RETURNING id`,
		motoID, authpkg.UserID(c), req.Liters, req.Cost, req.OdometerKm, full, req.Lat, req.Lon, when,
	).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(c, http.StatusNotFound, "motorcycle not found")
		return
	}
	if err != nil {
		httpx.Internal(c, "could not add fuel log")
		return
	}

	// Recompute consumption from the full history and persist it on the bike.
	if err := h.refreshConsumption(c, motoID); err != nil {
		httpx.Internal(c, "could not update consumption")
		return
	}
	c.Status(http.StatusCreated)
}

func (h *handler) listFuelLogs(c *gin.Context) {
	motoID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		httpx.BadRequest(c, "invalid motorcycle id")
		return
	}
	owns, err := h.ownsMoto(c, motoID)
	if err != nil {
		httpx.Internal(c, "could not verify motorcycle")
		return
	}
	if !owns {
		httpx.Error(c, http.StatusNotFound, "motorcycle not found")
		return
	}
	logs, err := h.loadFuelLogs(c, motoID)
	if err != nil {
		httpx.Internal(c, "could not list fuel logs")
		return
	}
	c.JSON(http.StatusOK, gin.H{"logs": logs, "summary": computeFuelSummary(logs)})
}

func (h *handler) removeFuelLog(c *gin.Context) {
	motoID, err1 := strconv.ParseInt(c.Param("id"), 10, 64)
	fid, err2 := strconv.ParseInt(c.Param("fid"), 10, 64)
	if err1 != nil || err2 != nil {
		httpx.BadRequest(c, "invalid id")
		return
	}
	// Ownership travels through the motorcycle join (same shape as removeServiceRecord).
	tag, err := h.d.DB.Exec(c,
		`DELETE FROM fuel_logs fl
		 USING motorcycles m
		 WHERE fl.id = $1 AND fl.motorcycle_id = $2 AND m.id = fl.motorcycle_id AND m.user_id = $3`,
		fid, motoID, authpkg.UserID(c))
	if err != nil {
		httpx.Internal(c, "could not delete fuel log")
		return
	}
	if tag.RowsAffected() == 0 {
		httpx.Error(c, http.StatusNotFound, "fuel log not found")
		return
	}
	if err := h.refreshConsumption(c, motoID); err != nil {
		httpx.Internal(c, "could not update consumption")
		return
	}
	c.Status(http.StatusNoContent)
}

// loadFuelLogs returns a motorcycle's fuel logs newest-first. Caller must have
// already verified ownership.
func (h *handler) loadFuelLogs(c *gin.Context, motoID int64) ([]FuelLog, error) {
	rows, err := h.d.DB.Query(c,
		`SELECT id, liters, COALESCE(cost, 0), odometer_km, is_full_tank,
		        COALESCE(lat, 0), COALESCE(lon, 0), filled_at
		 FROM fuel_logs WHERE motorcycle_id = $1
		 ORDER BY odometer_km DESC, id DESC`, motoID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	logs := make([]FuelLog, 0)
	for rows.Next() {
		var l FuelLog
		var filled time.Time
		if err := rows.Scan(&l.ID, &l.Liters, &l.Cost, &l.OdometerKm, &l.IsFullTank,
			&l.Lat, &l.Lon, &filled); err != nil {
			return nil, err
		}
		l.FilledAt = filled.Format(dateLayout)
		logs = append(logs, l)
	}
	return logs, rows.Err()
}

// refreshConsumption recomputes the full-to-full consumption from a bike's logs
// and writes it back to motorcycles.avg_consumption (NULL when not derivable, so
// a manual estimate is not clobbered by an empty result is handled by the caller).
func (h *handler) refreshConsumption(c *gin.Context, motoID int64) error {
	logs, err := h.loadFuelLogs(c, motoID)
	if err != nil {
		return err
	}
	summary := computeFuelSummary(logs)
	if summary.AvgConsumption <= 0 {
		return nil // not enough full fills yet; leave any manual estimate intact
	}
	_, err = h.d.DB.Exec(c,
		`UPDATE motorcycles SET avg_consumption = $2 WHERE id = $1`, motoID, summary.AvgConsumption)
	return err
}

// computeFuelSummary derives consumption and cost metrics from a motorcycle's
// fuel logs. Consumption uses the full-to-full method: between two brim-full
// fills the litres added at the *later* fills equal the fuel burned over the
// distance covered, so summing those litres over the spanned distance gives a
// robust L/100km. Pure, so it can be unit tested without a DB.
func computeFuelSummary(logs []FuelLog) FuelSummary {
	var s FuelSummary
	for _, l := range logs {
		s.TotalLiters += l.Liters
		s.TotalCost += l.Cost
	}

	// Consumption needs at least two full fills with increasing odometer.
	full := make([]FuelLog, 0, len(logs))
	for _, l := range logs {
		if l.IsFullTank {
			full = append(full, l)
		}
	}
	sort.Slice(full, func(i, j int) bool { return full[i].OdometerKm < full[j].OdometerKm })
	if len(full) < 2 {
		return s
	}
	distance := full[len(full)-1].OdometerKm - full[0].OdometerKm
	if distance <= 0 {
		return s
	}
	var burned float64
	for _, l := range full[1:] {
		burned += l.Liters
	}
	s.DistanceKm = distance
	s.AvgConsumption = burned / float64(distance) * 100.0
	if s.TotalCost > 0 {
		s.CostPerKm = s.TotalCost / float64(distance)
	}
	return s
}
