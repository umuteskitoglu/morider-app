# Rota Motoru (Routing Engine)

Bu doküman, route servisinin "yol ağına oturtulmuş" rota planlama yeteneğini açıklar. Karşılaştırmalı motor analizi için [`Morider-app.md`](../Morider-app.md) §7'ye bakın.

## Problem

Şu ana kadar route servisi, kullanıcının haritada seçtiği ham noktaları **düz çizgilerle** birleştiriyordu ([`route.go`](../backend/internal/route/route.go)); mesafe kuş uçuşu hesaplanıyordu. Gerçek bir motosiklet uygulaması için gerekenler:

- Noktalar arasında **gerçek yol güzergâhı** (yola snap).
- Gerçek **mesafe** ve tahmini **süre**.
- **Dönüş-dönüş (turn-by-turn)** tarifler.

## Yaklaşım: takılabilir (pluggable) `Router`

Route servisi bir `Router` arayüzü tanımlar; somut sürücü çalışma anında konfigürasyondan seçilir. Böylece motor değiştirmek (OSRM → GraphHopper/Valhalla → Mapbox) servisin geri kalanını etkilemez.

```go
type Router interface {
    Plan(ctx context.Context, waypoints []Point) (RoutePlan, error)
}
```

İlk sürücü **OSRM** (Open Source Routing Machine): hızlı, basit HTTP API, kendi kendine barındırılabilir.

| Ortam | `ROUTING_URL` | Not |
|-------|---------------|-----|
| Geliştirme | `https://router.project-osrm.org` (genel demo) | Hız limitli, sadece `driving` profili, ToS gereği üretimde kullanılmaz |
| Üretim | Kendi OSRM sunucunuz (ör. `http://osrm:5000`) | Motosiklet profiliyle derlenmiş `.osm.pbf` ile |

Profil `ROUTING_PROFILE` ile ayarlanır (varsayılan `driving`).

### OSRM API kullanımı

```
GET {ROUTING_URL}/route/v1/{profile}/{lon},{lat};{lon},{lat}?overview=full&geometries=geojson&steps=true
```

Yanıttan `routes[0]` alınır: `distance` (m), `duration` (s), `geometry.coordinates` ([lon,lat] dizisi) ve `legs[].steps[].maneuver` (tarif üretimi için). Parser (`parseOSRMRoute`) saf bir fonksiyondur, ağ olmadan birim test edilir.

## API

### POST /api/routes/plan *(korumalı)*

Kaydetmeden önce güzergâhı önizlemek için. DB'ye dokunmaz.

İstek:
```json
{ "waypoints": [ { "lat": 41.0082, "lon": 28.9784 }, { "lat": 41.02, "lon": 29.01 } ] }
```
Yanıt `200`:
```json
{
  "distance": 4.7,
  "duration": 9.3,
  "points": [ { "lat": 41.0082, "lon": 28.9784 }, ... ],
  "steps": [ { "instruction": "Sağa dön", "name": "Atatürk Cd", "distance": 120.0 } ]
}
```
`distance` km, `duration` dakika, `steps[].distance` metredir. Motor erişilemezse `502`.

### POST /api/routes (snap seçeneği)

Rota oluşturma gövdesine opsiyonel `"snap": true` eklenirse, servis önce waypoint'leri motordan geçirip **yola oturtulmuş** geometriyi saklar; `snap` verilmezse mevcut davranış (düz çizgi) korunur — geriye dönük uyumlu.

## Self-hosted OSRM (compose ile)

docker-compose'da `osrm` servisi **opt-in** bir profile (`routing`) arkasındadır; varsayılan `make up` onu başlatmaz. Kullanmak için:

```bash
# 1) Veriyi indir + ön-işle (ağır, tek seferlik). Varsayılan bölge: turkey.
make osrm-data
# Küçük bir bölgeyle denemek için:
#   make osrm-data OSRM_REGION=monaco OSRM_PBF_URL=https://download.geofabrik.de/europe/monaco-latest.osm.pbf

# 2) OSRM servisini başlat (port 5000)
make osrm-up

# 3) .env içinde route servisini ona yönelt
ROUTING_URL=http://osrm:5000
```

Veri `infra/osrm/` altına yazılır (gitignore'lu). İşlem adımları: `osrm-extract` (profil) → `osrm-partition` → `osrm-customize` → `osrm-routed --algorithm mld`. Motosiklet profili için `car.lua` yerine özelleştirilmiş bir profille `osrm-data` çalıştırılır (Makefile'da `OSRM_IMAGE`/profil ayarı genişletilebilir).

## Virajlılık (curviness) tercihi

- `POST /api/routes/plan` ve `POST /api/routes` (snap ile) opsiyonel `"curviness": 0..1` alır: OSRM'den **alternatif rotalar** istenir (`alternatives=3`) ve istenen virajlılığa en uygun olan seçilir (0 = en düz, 1 = en virajlı).
- **Skor:** toplam mutlak yön değişimi (derece) / mesafe (km) — saf fonksiyon `curvinessScore` ([`curviness.go`](../backend/internal/route/curviness.go)). Yanıttaki her plan `curviness` alanını taşır (≈ <30 düz, 30–100 kıvrımlı, >100 çok virajlı).
- **Kısıt:** OSRM alternatifleri yalnız **2 nokta** arasında üretir; ara nokta varsa tek rota döner ve tercih etkisizdir. Daha derin kontrol için motosiklete özel OSRM profili gerekir (bkz. sonraki adımlar).
- **Mobil:** Yeni Rota ekranında sürgü (Düz ↔ Virajlı); önizleme istatistiklerinde virajlılık etiketi.

## GPX içe/dışa aktarma

- **Dışa aktarma:** `GET /api/routes/:id/gpx` rota geometrisini GPX 1.1 track olarak döndürür (`application/gpx+xml`, `Content-Disposition: attachment`). Görünürlük kuralları `GET /api/routes/:id` ile aynıdır (sahip / public / karşılıklı takip).
- **İçe aktarma:** `POST /api/routes/import/gpx` ham GPX gövdesi alır (maks 10 MB). `trkpt` > `rtept` > `wpt` öncelik sırasıyla noktalar çıkarılır, 5000 noktayı aşan izler eşit aralıklarla seyreltilir. Rota adı dosyadaki `metadata/name` veya `trk/name`'den gelir; rota **private** oluşturulur. Yanıt, `POST /api/routes` ile aynı `Route` JSON'udur.
- **Mobil:** Rota detayında "GPX Dışa Aktar" (paylaşım menüsü), Rotalarım'da "GPX İçe Aktar" (dosya seçici).
- Parser/builder saf fonksiyonlardır: [`gpx.go`](../backend/internal/route/gpx.go), testler `gpx_test.go`.

## Adım adım navigasyon

- Plan yanıtındaki her `step` artık **manevra noktasını** (`lat`/`lon`) ve OSRM `type`/`modifier` alanlarını taşır; istemci ok ikonunu ve "şuraya dön" mantığını bunlarla kurar.
- **Adım kaynağı:** kayıtlı/yüklenen rota geometrisi en fazla 25 noktaya seyreltilip `POST /api/routes/plan`'a verilir ([`navigation.ts`](../mobile/src/lib/navigation.ts) `fetchRouteSteps`). Bu yüzden GPX'ten gelen veya eski rotalarda da çalışır; yeni uç/migration gerekmez.
- **İlerleme:** sıradaki manevra noktasına ~30 m kala adım tamamlanır; GPS atlaması olduysa bir sonraki adıma açıkça daha yakın olmak da adımı geçirir (`advanceStep`).
- **Mobil UX:** rota takipli solo sürüşte eğimli takip kamerası (pitch 55, zoom 17.5, GPS yönüne dönen kamera) + üstte talimat banner'ı; grup sürüşünde yalnız banner (harita grubu izlemek için serbest kalır). Sesli yönlendirme `expo-speech` (tr-TR) ile 250 m ve 50 m kala; banner'daki hoparlör ikonuyla kapatılır.
- **Re-route:** rotaya uzaklık art arda 2 GPS örneğinde 100 m'yi aşarsa, mevcut konumdan rotaya ~150 m **ileride** katılan yeni bir plan istenir (20 sn soğuma ile). Solo sürüşte kesikli rehber çizgi de yeni geometriyle çizilir; grup sürüşünde ortak rota çizgisi korunur, yalnız sürücünün kendi talimatları yenilenir. Başarıda "Rota yeniden hesaplandı" sesli bildirimi.

## Sonraki adımlar

- Yükseklik profili (PostGIS/harici DEM ile).
- KML içe-dışa aktarma (GPX tamamlandı).
- Motosiklete özel OSRM profili (otoyol/viraj ağırlıkları).
