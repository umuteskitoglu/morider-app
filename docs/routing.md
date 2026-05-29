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

## Sonraki adımlar

- Yükseklik profili (PostGIS/harici DEM ile).
- GPX/KML içe-dışa aktarma.
- Motosiklete özel OSRM profili (otoyol/viraj ağırlıkları).
