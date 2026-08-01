package feed

import (
	"errors"
	"fmt"
	"image"
	_ "image/gif" // decode support only
	"image/jpeg"
	_ "image/png" // decode support only
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp" // decode support only
)

// Widths a client may ask for via ?w=. A whitelist keeps a hostile caller from
// filling the disk with one derivative per pixel value.
//
// 320 covers the 3-column profile grids; 1440 covers the full-bleed feed on the
// densest phones we support, including a pinch-zoom.
var derivativeWidths = map[int]bool{320: true, 1440: true}

const (
	derivativeQuality = 82
	derivedDirName    = "derived"
)

// errNoResize means the source is already at or below the requested width, so
// the caller should just serve the original.
var errNoResize = errors.New("source already small enough")

// Resizing a 12MP photo costs a CPU core for a noticeable fraction of a second.
// The cache makes that a once-per-photo cost, but the first scroll through an
// old feed after a deploy would otherwise fire dozens of them at once and stall
// every other request on the box.
var resizeSlots = make(chan struct{}, 2)

func (h *handler) media(c *gin.Context) {
	file := c.Param("file")
	// Reject path traversal; filenames are plain hex + extension.
	if strings.ContainsAny(file, "/\\") || strings.Contains(file, "..") {
		c.Status(http.StatusBadRequest)
		return
	}
	src := filepath.Join(h.uploadDir, file)

	// Names are random hex and a stored file is never rewritten, so both the
	// client cache and any CDN in front of us can hold these forever.
	c.Header("Cache-Control", "public, max-age=31536000, immutable")

	// A resized variant is best-effort: HEIC and corrupt files can't be decoded
	// in pure Go, and there we'd rather serve the original than fail.
	if w, err := strconv.Atoi(c.Query("w")); err == nil && derivativeWidths[w] {
		if path, err := h.derivative(src, file, w); err == nil {
			c.File(path)
			return
		} else if !errors.Is(err, errNoResize) {
			h.d.Log.Warn().Err(err).Str("file", file).Int("width", w).Msg("could not build media derivative")
		}
	}
	c.File(src)
}

// derivative returns the path to a width-capped JPEG copy of src, generating it
// on first request. Doing this lazily rather than at upload time means photos
// already in the library get the same treatment as new ones.
func (h *handler) derivative(src, name string, width int) (string, error) {
	dir := filepath.Join(h.uploadDir, derivedDirName)
	out := filepath.Join(dir, fmt.Sprintf("%s_w%d.jpg", strings.TrimSuffix(name, filepath.Ext(name)), width))
	if st, err := os.Stat(out); err == nil && st.Size() > 0 {
		return out, nil
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}

	resizeSlots <- struct{}{}
	defer func() { <-resizeSlots }()
	// Another request may have generated it while we queued.
	if st, err := os.Stat(out); err == nil && st.Size() > 0 {
		return out, nil
	}

	f, err := os.Open(src)
	if err != nil {
		return "", err
	}
	defer f.Close()
	img, _, err := image.Decode(f)
	if err != nil {
		return "", err
	}

	b := img.Bounds()
	if b.Dx() <= width {
		return "", errNoResize
	}
	height := b.Dy() * width / b.Dx()
	if height < 1 {
		height = 1
	}
	dst := image.NewRGBA(image.Rect(0, 0, width, height))
	draw.CatmullRom.Scale(dst, dst.Bounds(), img, b, draw.Src, nil)

	// Write to a temp file and rename, so a concurrent request either sees no
	// file or a complete one — never a half-encoded JPEG.
	tmp, err := os.CreateTemp(dir, "tmp-*.jpg")
	if err != nil {
		return "", err
	}
	defer os.Remove(tmp.Name())
	if err := jpeg.Encode(tmp, dst, &jpeg.Options{Quality: derivativeQuality}); err != nil {
		tmp.Close()
		return "", err
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}
	if err := os.Rename(tmp.Name(), out); err != nil {
		return "", err
	}
	return out, nil
}
