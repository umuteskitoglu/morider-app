// Package metrics exposes Prometheus instrumentation shared by every service:
// an HTTP middleware that records request counts and latencies, and a /metrics
// endpoint for Prometheus to scrape (see infra/prometheus.yml).
package metrics

import (
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Metrics bundles a service's collectors and their dedicated registry. A private
// registry (instead of the global default) keeps each service self-contained and
// avoids duplicate-registration panics if more than one is built in a process.
type Metrics struct {
	reg      *prometheus.Registry
	requests *prometheus.CounterVec
	latency  *prometheus.HistogramVec
}

// New builds the collectors for a named service, including Go runtime/process
// metrics.
func New(service string) *Metrics {
	reg := prometheus.NewRegistry()
	reg.MustRegister(
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
	)
	factory := promauto.With(reg)
	labels := prometheus.Labels{"service": service}
	return &Metrics{
		reg: reg,
		requests: factory.NewCounterVec(prometheus.CounterOpts{
			Name:        "http_requests_total",
			Help:        "Total HTTP requests processed, labelled by route, method and status.",
			ConstLabels: labels,
		}, []string{"method", "path", "status"}),
		latency: factory.NewHistogramVec(prometheus.HistogramOpts{
			Name:        "http_request_duration_seconds",
			Help:        "HTTP request latency in seconds.",
			Buckets:     prometheus.DefBuckets,
			ConstLabels: labels,
		}, []string{"method", "path"}),
	}
}

// Middleware records the count and latency of each request. It labels by the
// matched route template (c.FullPath), not the raw URL, so path parameters like
// /api/rides/:id do not explode label cardinality.
func (m *Metrics) Middleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		c.Next()
		path := c.FullPath()
		if path == "" {
			path = "unmatched"
		}
		m.requests.WithLabelValues(c.Request.Method, path, strconv.Itoa(c.Writer.Status())).Inc()
		m.latency.WithLabelValues(c.Request.Method, path).Observe(time.Since(start).Seconds())
	}
}

// Expose registers the GET /metrics scrape endpoint on the engine.
func (m *Metrics) Expose(r gin.IRoutes) {
	r.GET("/metrics", gin.WrapH(promhttp.HandlerFor(m.reg, promhttp.HandlerOpts{})))
}
