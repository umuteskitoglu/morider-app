package ride

import (
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	authpkg "github.com/morider/backend/pkg/auth"
	"github.com/morider/backend/pkg/httpx"
)

// Maintenance schedules: distance- and/or time-based service intervals per bike.
// The "due in km" is measured against the bike's latest known odometer (the max
// reading across service records and fuel logs); "due in days" against the wall
// clock. Status mirrors the garage document-expiry colour scheme (ok/soon/overdue).

// Thresholds at which an item flips from ok → soon (the yellow warning band).
// Overdue (red) is anything past due.
const (
	maintenanceSoonKm   = 500
	maintenanceSoonDays = 14
)

// MaintenanceItem is the API representation of a schedule with its derived state.
type MaintenanceItem struct {
	ID             int64           `json:"id"`
	Item           string          `json:"item"`
	IntervalKm     int             `json:"interval_km"`
	IntervalMonths int             `json:"interval_months"`
	LastDoneKm     int             `json:"last_done_km"`
	LastDoneAt     string          `json:"last_done_at"`
	// Derived. DueInKm/DueInDays are nil when the matching interval is not set.
	// Negative means overdue by that much.
	DueInKm   *int          `json:"due_in_km,omitempty"`
	DueInDays *int          `json:"due_in_days,omitempty"`
	Status    string        `json:"status"`  // ok | soon | overdue
	Records   []ServiceRecord `json:"records"` // history of completions, newest first
}

func registerMaintenanceRoutes(g *gin.RouterGroup, h *handler) {
	g.POST("/:id/maintenance", h.addMaintenance)
	g.GET("/:id/maintenance", h.listMaintenance)
	g.PUT("/:id/maintenance/:mid", h.updateMaintenance)
	g.DELETE("/:id/maintenance/:mid", h.removeMaintenance)
	g.POST("/:id/maintenance/:mid/done", h.markMaintenanceDone)
}

type maintenanceReq struct {
	Item           string `json:"item" binding:"required,max=80"`
	IntervalKm     int    `json:"interval_km" binding:"omitempty,min=0,max=200000"`
	IntervalMonths int    `json:"interval_months" binding:"omitempty,min=0,max=600"`
	// Optional baseline; when omitted on create they default to "now" (current
	// odometer / today), i.e. the item is treated as freshly serviced.
	LastDoneKm int    `json:"last_done_km" binding:"omitempty,min=0,max=2000000"`
	LastDoneAt string `json:"last_done_at"`
}

func (h *handler) addMaintenance(c *gin.Context) {
	motoID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		httpx.BadRequest(c, "invalid motorcycle id")
		return
	}
	var req maintenanceReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.BadRequest(c, err.Error())
		return
	}
	if req.IntervalKm == 0 && req.IntervalMonths == 0 {
		httpx.BadRequest(c, "set interval_km and/or interval_months")
		return
	}
	doneAt, ok := parseDate(req.LastDoneAt)
	if !ok {
		httpx.BadRequest(c, "last_done_at must be YYYY-MM-DD")
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

	// Default the baseline to "freshly serviced now" when not supplied.
	lastKm := req.LastDoneKm
	if lastKm == 0 {
		if odo, err := h.currentOdometer(c, motoID); err == nil {
			lastKm = odo
		}
	}
	if doneAt == nil {
		now := time.Now()
		doneAt = &now
	}

	var id int64
	err = h.d.DB.QueryRow(c,
		`INSERT INTO maintenance_schedules (motorcycle_id, item, interval_km, interval_months, last_done_km, last_done_at)
		 VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
		motoID, req.Item, nullableInt(req.IntervalKm), nullableInt(req.IntervalMonths), lastKm, doneAt,
	).Scan(&id)
	if err != nil {
		httpx.Internal(c, "could not create maintenance schedule")
		return
	}
	c.Status(http.StatusCreated)
}

func (h *handler) listMaintenance(c *gin.Context) {
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
	odo, err := h.currentOdometer(c, motoID)
	if err != nil {
		httpx.Internal(c, "could not read odometer")
		return
	}
	rows, err := h.d.DB.Query(c,
		`SELECT id, item, COALESCE(interval_km, 0), COALESCE(interval_months, 0),
		        COALESCE(last_done_km, 0), last_done_at
		 FROM maintenance_schedules WHERE motorcycle_id = $1 ORDER BY created_at`, motoID)
	if err != nil {
		httpx.Internal(c, "could not list maintenance schedules")
		return
	}
	defer rows.Close()

	now := time.Now()
	items := make([]MaintenanceItem, 0)
	idxByID := map[int64]int{} // maintenance_schedule id → index in items slice
	for rows.Next() {
		var m MaintenanceItem
		var doneAt *time.Time
		if err := rows.Scan(&m.ID, &m.Item, &m.IntervalKm, &m.IntervalMonths, &m.LastDoneKm, &doneAt); err != nil {
			httpx.Internal(c, "could not read maintenance schedules")
			return
		}
		m.LastDoneAt = fmtDate(doneAt)
		m.DueInKm, m.DueInDays, m.Status = maintenanceStatus(m.IntervalKm, m.LastDoneKm, odo, m.IntervalMonths, doneAt, now)
		m.Records = make([]ServiceRecord, 0)
		idxByID[m.ID] = len(items)
		items = append(items, m)
	}
	if rows.Err() != nil {
		httpx.Internal(c, "could not read maintenance schedules")
		return
	}

	// Embed service record history for each item (newest first, capped at 20).
	if len(items) > 0 {
		rrows, err := h.d.DB.Query(c,
			`SELECT id, COALESCE(title,''), COALESCE(note,''), COALESCE(odometer_km,0),
			        COALESCE(cost,0), service_date, maintenance_schedule_id
			 FROM service_records
			 WHERE motorcycle_id = $1 AND maintenance_schedule_id IS NOT NULL
			 ORDER BY service_date DESC, id DESC
			 LIMIT 200`, motoID)
		if err == nil {
			defer rrows.Close()
			counts := map[int64]int{}
			for rrows.Next() {
				var r ServiceRecord
				var when time.Time
				if err := rrows.Scan(&r.ID, &r.Title, &r.Note, &r.OdometerKm, &r.Cost, &when, &r.MaintenanceScheduleID); err != nil {
					break
				}
				r.ServiceDate = when.Format(dateLayout)
				if r.MaintenanceScheduleID == nil {
					continue
				}
				mid := *r.MaintenanceScheduleID
				if idx, ok := idxByID[mid]; ok && counts[mid] < 20 {
					items[idx].Records = append(items[idx].Records, r)
					counts[mid]++
				}
			}
		}
	}

	c.JSON(http.StatusOK, gin.H{"items": items, "odometer_km": odo})
}

func (h *handler) updateMaintenance(c *gin.Context) {
	motoID, mid, ok := h.maintenanceIDs(c)
	if !ok {
		return
	}
	var req maintenanceReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.BadRequest(c, err.Error())
		return
	}
	if req.IntervalKm == 0 && req.IntervalMonths == 0 {
		httpx.BadRequest(c, "set interval_km and/or interval_months")
		return
	}
	doneAt, valid := parseDate(req.LastDoneAt)
	if !valid {
		httpx.BadRequest(c, "last_done_at must be YYYY-MM-DD")
		return
	}
	// Ownership through the motorcycle join, like removeServiceRecord.
	tag, err := h.d.DB.Exec(c,
		`UPDATE maintenance_schedules ms
		 SET item = $4, interval_km = $5, interval_months = $6, last_done_km = $7, last_done_at = $8
		 FROM motorcycles m
		 WHERE ms.id = $1 AND ms.motorcycle_id = $2 AND m.id = ms.motorcycle_id AND m.user_id = $3`,
		mid, motoID, authpkg.UserID(c), req.Item,
		nullableInt(req.IntervalKm), nullableInt(req.IntervalMonths), nullableInt(req.LastDoneKm), doneAt)
	if err != nil {
		httpx.Internal(c, "could not update maintenance schedule")
		return
	}
	if tag.RowsAffected() == 0 {
		httpx.Error(c, http.StatusNotFound, "maintenance schedule not found")
		return
	}
	c.Status(http.StatusNoContent)
}

func (h *handler) removeMaintenance(c *gin.Context) {
	motoID, mid, ok := h.maintenanceIDs(c)
	if !ok {
		return
	}
	tag, err := h.d.DB.Exec(c,
		`DELETE FROM maintenance_schedules ms
		 USING motorcycles m
		 WHERE ms.id = $1 AND ms.motorcycle_id = $2 AND m.id = ms.motorcycle_id AND m.user_id = $3`,
		mid, motoID, authpkg.UserID(c))
	if err != nil {
		httpx.Internal(c, "could not delete maintenance schedule")
		return
	}
	if tag.RowsAffected() == 0 {
		httpx.Error(c, http.StatusNotFound, "maintenance schedule not found")
		return
	}
	c.Status(http.StatusNoContent)
}

type doneReq struct {
	OdometerKm int     `json:"odometer_km"`
	Cost       float64 `json:"cost"`
	Note       string  `json:"note" binding:"max=500"`
}

// markMaintenanceDone advances the schedule baseline and atomically appends a
// linked service record so the history is captured in one request.
func (h *handler) markMaintenanceDone(c *gin.Context) {
	motoID, mid, ok := h.maintenanceIDs(c)
	if !ok {
		return
	}
	var req doneReq
	_ = c.ShouldBindJSON(&req) // body is optional — all fields default to zero

	// Use caller-supplied odometer or fall back to the bike's current reading.
	odo := req.OdometerKm
	if odo == 0 {
		var err error
		odo, err = h.currentOdometer(c, motoID)
		if err != nil {
			httpx.Internal(c, "could not read odometer")
			return
		}
	}

	// Fetch item name (also verifies ownership).
	var item string
	err := h.d.DB.QueryRow(c,
		`SELECT ms.item FROM maintenance_schedules ms
		 JOIN motorcycles m ON m.id = ms.motorcycle_id
		 WHERE ms.id = $1 AND ms.motorcycle_id = $2 AND m.user_id = $3`,
		mid, motoID, authpkg.UserID(c),
	).Scan(&item)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(c, http.StatusNotFound, "maintenance schedule not found")
		return
	}
	if err != nil {
		httpx.Internal(c, "could not load maintenance item")
		return
	}

	tx, err := h.d.DB.Begin(c)
	if err != nil {
		httpx.Internal(c, "could not begin transaction")
		return
	}
	defer tx.Rollback(c)

	if _, err = tx.Exec(c,
		`UPDATE maintenance_schedules SET last_done_km = $3, last_done_at = CURRENT_DATE
		 WHERE id = $1 AND motorcycle_id = $2`,
		mid, motoID, odo); err != nil {
		httpx.Internal(c, "could not update maintenance schedule")
		return
	}

	if _, err = tx.Exec(c,
		`INSERT INTO service_records
		   (motorcycle_id, title, note, odometer_km, cost, service_date, maintenance_schedule_id)
		 VALUES ($1, $2, $3, $4, $5, CURRENT_DATE, $6)`,
		motoID, item, req.Note, odo, nullableFloat(req.Cost), mid); err != nil {
		httpx.Internal(c, "could not create service record")
		return
	}

	if err = tx.Commit(c); err != nil {
		httpx.Internal(c, "could not commit")
		return
	}
	c.Status(http.StatusNoContent)
}

// maintenanceIDs parses and validates the :id/:mid path params. It writes the
// error response itself and reports ok=false on failure.
func (h *handler) maintenanceIDs(c *gin.Context) (motoID, mid int64, ok bool) {
	var err1, err2 error
	motoID, err1 = strconv.ParseInt(c.Param("id"), 10, 64)
	mid, err2 = strconv.ParseInt(c.Param("mid"), 10, 64)
	if err1 != nil || err2 != nil {
		httpx.BadRequest(c, "invalid id")
		return 0, 0, false
	}
	return motoID, mid, true
}

// currentOdometer returns the bike's latest known odometer reading: the greatest
// value across its service records and fuel logs (0 when nothing recorded yet).
func (h *handler) currentOdometer(c *gin.Context, motoID int64) (int, error) {
	var odo int
	err := h.d.DB.QueryRow(c,
		`SELECT GREATEST(
		     COALESCE((SELECT MAX(odometer_km) FROM service_records WHERE motorcycle_id = $1), 0),
		     COALESCE((SELECT MAX(odometer_km) FROM fuel_logs WHERE motorcycle_id = $1), 0)
		 )`, motoID).Scan(&odo)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	return odo, err
}

// nullableInt maps zero to SQL NULL so "not set" stays distinct from a real 0.
func nullableInt(v int) *int {
	if v == 0 {
		return nil
	}
	return &v
}

// maintenanceStatus derives the remaining distance/time and a coarse status for
// a schedule. DueInKm/DueInDays are nil when the matching interval is unset;
// negative values mean overdue. Status is the worse of the two dimensions. Pure,
// so it can be unit tested without a DB.
func maintenanceStatus(intervalKm, lastDoneKm, currentOdo, intervalMonths int, lastDoneAt *time.Time, now time.Time) (dueKm, dueDays *int, status string) {
	worst := "ok" // ok < soon < overdue
	escalate := func(s string) {
		if rank(s) > rank(worst) {
			worst = s
		}
	}

	if intervalKm > 0 {
		remaining := (lastDoneKm + intervalKm) - currentOdo
		dueKm = &remaining
		switch {
		case remaining <= 0:
			escalate("overdue")
		case remaining <= maintenanceSoonKm:
			escalate("soon")
		}
	}
	if intervalMonths > 0 && lastDoneAt != nil {
		next := lastDoneAt.AddDate(0, intervalMonths, 0)
		days := daysBetween(now, next)
		dueDays = &days
		switch {
		case days <= 0:
			escalate("overdue")
		case days <= maintenanceSoonDays:
			escalate("soon")
		}
	}
	return dueKm, dueDays, worst
}

func rank(status string) int {
	switch status {
	case "overdue":
		return 2
	case "soon":
		return 1
	default:
		return 0
	}
}

// daysBetween returns whole calendar days from a to b (b-a), truncating each to
// its date so partial days do not skew the count.
func daysBetween(a, b time.Time) int {
	da := time.Date(a.Year(), a.Month(), a.Day(), 0, 0, 0, 0, time.UTC)
	db := time.Date(b.Year(), b.Month(), b.Day(), 0, 0, 0, 0, time.UTC)
	return int(db.Sub(da).Hours() / 24)
}
