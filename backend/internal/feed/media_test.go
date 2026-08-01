package feed

import (
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"os"
	"path/filepath"
	"testing"
)

func writeJPEG(t *testing.T, path string, w, h int) {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{R: uint8(x % 256), G: uint8(y % 256), B: 128, A: 255})
		}
	}
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := jpeg.Encode(f, img, nil); err != nil {
		t.Fatal(err)
	}
}

func decodeSize(t *testing.T, path string) (int, int) {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	cfg, _, err := image.DecodeConfig(f)
	if err != nil {
		t.Fatal(err)
	}
	return cfg.Width, cfg.Height
}

func TestDerivativeResizesAndPreservesAspect(t *testing.T) {
	dir := t.TempDir()
	h := &handler{uploadDir: dir}
	writeJPEG(t, filepath.Join(dir, "abc.jpg"), 4032, 3024)

	out, err := h.derivative(filepath.Join(dir, "abc.jpg"), "abc.jpg", 1440)
	if err != nil {
		t.Fatalf("derivative: %v", err)
	}
	w, hgt := decodeSize(t, out)
	if w != 1440 || hgt != 1080 {
		t.Fatalf("got %dx%d, want 1440x1080", w, hgt)
	}

	// A 12MP source must shrink substantially, otherwise the whole exercise is
	// pointless.
	src, _ := os.Stat(filepath.Join(dir, "abc.jpg"))
	got, _ := os.Stat(out)
	if got.Size() >= src.Size() {
		t.Fatalf("derivative %d bytes is not smaller than source %d", got.Size(), src.Size())
	}
}

func TestDerivativeIsCachedOnDisk(t *testing.T) {
	dir := t.TempDir()
	h := &handler{uploadDir: dir}
	writeJPEG(t, filepath.Join(dir, "abc.jpg"), 2000, 1000)

	first, err := h.derivative(filepath.Join(dir, "abc.jpg"), "abc.jpg", 320)
	if err != nil {
		t.Fatal(err)
	}
	// Overwrite the source; a second call must return the cached file untouched.
	writeJPEG(t, filepath.Join(dir, "abc.jpg"), 40, 20)
	second, err := h.derivative(filepath.Join(dir, "abc.jpg"), "abc.jpg", 320)
	if err != nil {
		t.Fatal(err)
	}
	if first != second {
		t.Fatalf("path changed: %q vs %q", first, second)
	}
	if w, _ := decodeSize(t, second); w != 320 {
		t.Fatalf("cached derivative was regenerated: width %d", w)
	}
	// No temp files left behind.
	entries, _ := os.ReadDir(filepath.Join(dir, derivedDirName))
	if len(entries) != 1 {
		t.Fatalf("expected 1 derivative, got %d", len(entries))
	}
}

func TestDerivativeSkipsUpscale(t *testing.T) {
	dir := t.TempDir()
	h := &handler{uploadDir: dir}
	writeJPEG(t, filepath.Join(dir, "small.jpg"), 200, 200)

	if _, err := h.derivative(filepath.Join(dir, "small.jpg"), "small.jpg", 1440); !errors.Is(err, errNoResize) {
		t.Fatalf("want errNoResize, got %v", err)
	}
}

func TestDerivativeRejectsUndecodable(t *testing.T) {
	dir := t.TempDir()
	h := &handler{uploadDir: dir}
	// Stand-in for HEIC: a real file we have no pure-Go decoder for.
	if err := os.WriteFile(filepath.Join(dir, "x.heic"), []byte("not an image"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := h.derivative(filepath.Join(dir, "x.heic"), "x.heic", 1440); err == nil {
		t.Fatal("expected a decode error so the caller falls back to the original")
	}
}
