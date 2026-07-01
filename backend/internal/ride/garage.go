package ride

import (
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	"github.com/morider/backend/internal/server"
	authpkg "github.com/morider/backend/pkg/auth"
	"github.com/morider/backend/pkg/httpx"
)

// Garage: the rider's motorcycles with document expiry dates (insurance,
// kasko, inspection) and a maintenance log per bike. Expiry reminders fire
// on-device; the backend only stores the dates.

const dateLayout = "2006-01-02"

// Motorcycle is the API representation of a bike in the rider's garage.
// Dates travel as "YYYY-MM-DD" strings; empty means not set.
type Motorcycle struct {
	ID               int64  `json:"id"`
	Name             string `json:"name"`
	Plate            string `json:"plate"`
	Year             int    `json:"year"`
	InsuranceExpiry  string `json:"insurance_expiry"`
	KaskoExpiry      string `json:"kasko_expiry"`
	InspectionExpiry string `json:"inspection_expiry"`
	// Fuel & range metadata. TankLiters and FuelType are user-set; AvgConsumption
	// (L/100km) is auto-derived from full fills (see fuel.go) but may be seeded
	// manually. Zero means "not set".
	TankLiters     float64 `json:"tank_liters"`
	AvgConsumption float64 `json:"avg_consumption"`
	FuelType       string  `json:"fuel_type"`
}

// ServiceRecord is one maintenance log entry.
type ServiceRecord struct {
	ID                    int64   `json:"id"`
	Title                 string  `json:"title"`
	Note                  string  `json:"note"`
	OdometerKm            int     `json:"odometer_km"`
	Cost                  float64 `json:"cost"`
	ServiceDate           string  `json:"service_date"`
	MaintenanceScheduleID *int64  `json:"maintenance_schedule_id,omitempty"`
}

func registerGarageRoutes(d *server.Deps, h *handler) {
	g := d.Engine.Group("/api/garage", d.JWT.Middleware())
	g.POST("", h.createMoto)
	g.GET("", h.listMotos)
	g.GET("/user/:id", h.listMotosPublic)
	g.PUT("/:id", h.updateMoto)
	g.DELETE("/:id", h.removeMoto)
	g.POST("/:id/services", h.addServiceRecord)
	g.GET("/:id/services", h.listServiceRecords)
	g.DELETE("/:id/services/:sid", h.removeServiceRecord)
	registerFuelRoutes(g, h)
	registerMaintenanceRoutes(g, h)
}

type motoReq struct {
	Name  string `json:"name" binding:"required,max=80"`
	Plate string `json:"plate" binding:"max=16"`
	Year  int    `json:"year" binding:"omitempty,min=1900,max=2100"`
	// Dates as "YYYY-MM-DD"; empty clears the value (the form always sends the
	// full document set, so a full replace keeps update semantics obvious).
	InsuranceExpiry  string `json:"insurance_expiry"`
	KaskoExpiry      string `json:"kasko_expiry"`
	InspectionExpiry string `json:"inspection_expiry"`

	TankLiters     float64 `json:"tank_liters" binding:"omitempty,min=0,max=200"`
	AvgConsumption float64 `json:"avg_consumption" binding:"omitempty,min=0,max=100"`
	FuelType       string  `json:"fuel_type" binding:"max=20"`
}

// parseDate turns an optional "YYYY-MM-DD" string into a nullable time.
func parseDate(s string) (*time.Time, bool) {
	if s == "" {
		return nil, true
	}
	t, err := time.Parse(dateLayout, s)
	if err != nil {
		return nil, false
	}
	return &t, true
}

// fmtDate renders a nullable DB date back to "YYYY-MM-DD" (empty when null).
func fmtDate(t *time.Time) string {
	if t == nil {
		return ""
	}
	return t.Format(dateLayout)
}

// parseMotoDates validates the three expiry dates of a request at once.
func parseMotoDates(req motoReq) (ins, kasko, insp *time.Time, ok bool) {
	ins, ok1 := parseDate(req.InsuranceExpiry)
	kasko, ok2 := parseDate(req.KaskoExpiry)
	insp, ok3 := parseDate(req.InspectionExpiry)
	return ins, kasko, insp, ok1 && ok2 && ok3
}

func (h *handler) createMoto(c *gin.Context) {
	var req motoReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.BadRequest(c, err.Error())
		return
	}
	ins, kasko, insp, ok := parseMotoDates(req)
	if !ok {
		httpx.BadRequest(c, "dates must be YYYY-MM-DD")
		return
	}
	var id int64
	err := h.d.DB.QueryRow(c,
		`INSERT INTO motorcycles (user_id, name, plate, year, insurance_expiry, kasko_expiry, inspection_expiry,
		                          tank_liters, avg_consumption, fuel_type)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
		authpkg.UserID(c), req.Name, req.Plate, req.Year, ins, kasko, insp,
		nullableFloat(req.TankLiters), nullableFloat(req.AvgConsumption), req.FuelType,
	).Scan(&id)
	if err != nil {
		httpx.Internal(c, "could not create motorcycle")
		return
	}
	c.JSON(http.StatusCreated, Motorcycle{
		ID: id, Name: req.Name, Plate: req.Plate, Year: req.Year,
		InsuranceExpiry: req.InsuranceExpiry, KaskoExpiry: req.KaskoExpiry,
		InspectionExpiry: req.InspectionExpiry,
		TankLiters:       req.TankLiters, AvgConsumption: req.AvgConsumption, FuelType: req.FuelType,
	})
}

// nullableFloat maps a zero value to SQL NULL so "not set" stays distinct from
// a real zero in numeric columns.
func nullableFloat(v float64) *float64 {
	if v == 0 {
		return nil
	}
	return &v
}

func (h *handler) listMotos(c *gin.Context) {
	rows, err := h.d.DB.Query(c,
		`SELECT id, name, COALESCE(plate, ''), COALESCE(year, 0),
		        insurance_expiry, kasko_expiry, inspection_expiry,
		        COALESCE(tank_liters, 0), COALESCE(avg_consumption, 0), COALESCE(fuel_type, '')
		 FROM motorcycles WHERE user_id = $1 ORDER BY created_at`, authpkg.UserID(c))
	if err != nil {
		httpx.Internal(c, "could not list motorcycles")
		return
	}
	defer rows.Close()
	motos := make([]Motorcycle, 0)
	for rows.Next() {
		var m Motorcycle
		var ins, kasko, insp *time.Time
		if err := rows.Scan(&m.ID, &m.Name, &m.Plate, &m.Year, &ins, &kasko, &insp,
			&m.TankLiters, &m.AvgConsumption, &m.FuelType); err != nil {
			httpx.Internal(c, "could not read motorcycles")
			return
		}
		m.InsuranceExpiry, m.KaskoExpiry, m.InspectionExpiry = fmtDate(ins), fmtDate(kasko), fmtDate(insp)
		motos = append(motos, m)
	}
	if rows.Err() != nil {
		httpx.Internal(c, "could not read motorcycles")
		return
	}
	c.JSON(http.StatusOK, gin.H{"motorcycles": motos})
}

// PublicMotorcycle is the sanitized view of a bike shown on another rider's
// profile: name and year only. Plates and document expiry dates stay private.
type PublicMotorcycle struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
	Year int    `json:"year"`
}

// listMotosPublic returns a target user's garage for their public profile.
// The list is sanitized and only served when that user has show_garage on;
// otherwise it responds with visible=false and an empty list.
func (h *handler) listMotosPublic(c *gin.Context) {
	uid, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		httpx.BadRequest(c, "invalid user id")
		return
	}
	var show bool
	err = h.d.DB.QueryRow(c, `SELECT show_garage FROM users WHERE id = $1`, uid).Scan(&show)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(c, http.StatusNotFound, "user not found")
		return
	}
	if err != nil {
		httpx.Internal(c, "could not load garage")
		return
	}
	if !show {
		c.JSON(http.StatusOK, gin.H{"visible": false, "motorcycles": []PublicMotorcycle{}})
		return
	}
	rows, err := h.d.DB.Query(c,
		`SELECT id, name, COALESCE(year, 0)
		 FROM motorcycles WHERE user_id = $1 ORDER BY created_at`, uid)
	if err != nil {
		httpx.Internal(c, "could not list motorcycles")
		return
	}
	defer rows.Close()
	motos := make([]PublicMotorcycle, 0)
	for rows.Next() {
		var m PublicMotorcycle
		if err := rows.Scan(&m.ID, &m.Name, &m.Year); err != nil {
			httpx.Internal(c, "could not read motorcycles")
			return
		}
		motos = append(motos, m)
	}
	if rows.Err() != nil {
		httpx.Internal(c, "could not read motorcycles")
		return
	}
	c.JSON(http.StatusOK, gin.H{"visible": true, "motorcycles": motos})
}

func (h *handler) updateMoto(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		httpx.BadRequest(c, "invalid motorcycle id")
		return
	}
	var req motoReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.BadRequest(c, err.Error())
		return
	}
	ins, kasko, insp, ok := parseMotoDates(req)
	if !ok {
		httpx.BadRequest(c, "dates must be YYYY-MM-DD")
		return
	}
	var avgConsumption float64
	err = h.d.DB.QueryRow(c,
		`UPDATE motorcycles
		 SET name = $3, plate = $4, year = $5,
		     insurance_expiry = $6, kasko_expiry = $7, inspection_expiry = $8,
		     tank_liters = $9,
		     -- avg_consumption is auto-derived from fuel logs; only overwrite it
		     -- when the form sends an explicit (non-null) manual estimate.
		     avg_consumption = COALESCE($10, avg_consumption), fuel_type = $11
		 WHERE id = $1 AND user_id = $2
		 RETURNING COALESCE(avg_consumption, 0)`,
		id, authpkg.UserID(c), req.Name, req.Plate, req.Year, ins, kasko, insp,
		nullableFloat(req.TankLiters), nullableFloat(req.AvgConsumption), req.FuelType,
	).Scan(&avgConsumption)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(c, http.StatusNotFound, "motorcycle not found")
		return
	}
	if err != nil {
		httpx.Internal(c, "could not update motorcycle")
		return
	}
	c.JSON(http.StatusOK, Motorcycle{
		ID: id, Name: req.Name, Plate: req.Plate, Year: req.Year,
		InsuranceExpiry: req.InsuranceExpiry, KaskoExpiry: req.KaskoExpiry,
		InspectionExpiry: req.InspectionExpiry,
		TankLiters:       req.TankLiters, AvgConsumption: avgConsumption, FuelType: req.FuelType,
	})
}

func (h *handler) removeMoto(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		httpx.BadRequest(c, "invalid motorcycle id")
		return
	}
	tag, err := h.d.DB.Exec(c,
		`DELETE FROM motorcycles WHERE id = $1 AND user_id = $2`, id, authpkg.UserID(c))
	if err != nil {
		httpx.Internal(c, "could not delete motorcycle")
		return
	}
	if tag.RowsAffected() == 0 {
		httpx.Error(c, http.StatusNotFound, "motorcycle not found")
		return
	}
	c.Status(http.StatusNoContent)
}

// ownsMoto reports whether the motorcycle exists and belongs to the caller.
func (h *handler) ownsMoto(c *gin.Context, motoID int64) (bool, error) {
	var owns bool
	err := h.d.DB.QueryRow(c,
		`SELECT EXISTS(SELECT 1 FROM motorcycles WHERE id = $1 AND user_id = $2)`,
		motoID, authpkg.UserID(c)).Scan(&owns)
	return owns, err
}

type serviceReq struct {
	Title      string  `json:"title" binding:"required,max=120"`
	Note       string  `json:"note" binding:"max=500"`
	OdometerKm int     `json:"odometer_km" binding:"omitempty,min=0,max=2000000"`
	Cost       float64 `json:"cost" binding:"omitempty,min=0"`
	// ServiceDate "YYYY-MM-DD"; empty = today.
	ServiceDate string `json:"service_date"`
}

func (h *handler) addServiceRecord(c *gin.Context) {
	motoID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		httpx.BadRequest(c, "invalid motorcycle id")
		return
	}
	var req serviceReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.BadRequest(c, err.Error())
		return
	}
	when, ok := parseDate(req.ServiceDate)
	if !ok {
		httpx.BadRequest(c, "service_date must be YYYY-MM-DD")
		return
	}
	if when == nil {
		now := time.Now()
		when = &now
	}
	// Ownership check and insert in one statement, so a concurrently deleted
	// motorcycle yields a clean 404 instead of an FK violation.
	var id int64
	err = h.d.DB.QueryRow(c,
		`INSERT INTO service_records (motorcycle_id, title, note, odometer_km, cost, service_date)
		 SELECT m.id, $3, $4, $5, $6, $7 FROM motorcycles m
		 WHERE m.id = $1 AND m.user_id = $2
		 RETURNING id`,
		motoID, authpkg.UserID(c), req.Title, req.Note, req.OdometerKm, req.Cost, when,
	).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(c, http.StatusNotFound, "motorcycle not found")
		return
	}
	if err != nil {
		httpx.Internal(c, "could not add service record")
		return
	}
	c.JSON(http.StatusCreated, ServiceRecord{
		ID: id, Title: req.Title, Note: req.Note,
		OdometerKm: req.OdometerKm, Cost: req.Cost,
		ServiceDate: when.Format(dateLayout),
	})
}

func (h *handler) listServiceRecords(c *gin.Context) {
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
	rows, err := h.d.DB.Query(c,
		`SELECT id, title, COALESCE(note, ''), COALESCE(odometer_km, 0), COALESCE(cost, 0), service_date,
		        maintenance_schedule_id
		 FROM service_records WHERE motorcycle_id = $1
		 ORDER BY service_date DESC, id DESC`, motoID)
	if err != nil {
		httpx.Internal(c, "could not list service records")
		return
	}
	defer rows.Close()
	records := make([]ServiceRecord, 0)
	for rows.Next() {
		var r ServiceRecord
		var when time.Time
		if err := rows.Scan(&r.ID, &r.Title, &r.Note, &r.OdometerKm, &r.Cost, &when, &r.MaintenanceScheduleID); err != nil {
			httpx.Internal(c, "could not read service records")
			return
		}
		r.ServiceDate = when.Format(dateLayout)
		records = append(records, r)
	}
	if rows.Err() != nil {
		httpx.Internal(c, "could not read service records")
		return
	}
	c.JSON(http.StatusOK, gin.H{"records": records})
}

func (h *handler) removeServiceRecord(c *gin.Context) {
	motoID, err1 := strconv.ParseInt(c.Param("id"), 10, 64)
	sid, err2 := strconv.ParseInt(c.Param("sid"), 10, 64)
	if err1 != nil || err2 != nil {
		httpx.BadRequest(c, "invalid id")
		return
	}
	// Ownership travels through the motorcycle join, so a record can only be
	// deleted by the bike's owner.
	tag, err := h.d.DB.Exec(c,
		`DELETE FROM service_records sr
		 USING motorcycles m
		 WHERE sr.id = $1 AND sr.motorcycle_id = $2 AND m.id = sr.motorcycle_id AND m.user_id = $3`,
		sid, motoID, authpkg.UserID(c))
	if err != nil {
		httpx.Internal(c, "could not delete service record")
		return
	}
	if tag.RowsAffected() == 0 {
		httpx.Error(c, http.StatusNotFound, "service record not found")
		return
	}
	c.Status(http.StatusNoContent)
}
