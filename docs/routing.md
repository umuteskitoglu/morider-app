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
# Motosiklet profiliyle (manzaralı yollar, otoyol cezası — aşağıya bakın):
#   make osrm-data OSRM_PROFILE=motorcycle
# Küçük bir bölgeyle denemek için:
#   make osrm-data OSRM_REGION=monaco OSRM_PBF_URL=https://download.geofabrik.de/europe/monaco-latest.osm.pbf

# 2) OSRM servisini başlat (port 5000)
make osrm-up

# 3) .env içinde route servisini ona yönelt
ROUTING_URL=http://osrm:5000
```

Veri `infra/osrm/` altına yazılır (gitignore'lu). İşlem adımları: `osrm-extract` (profil) → `osrm-partition` → `osrm-customize` → `osrm-routed --algorithm mld`.

## Motosiklete özel OSRM profili

Hazır `car.lua` profili otomobil gibi düşünür: en hızlı yolu (genelde otoyol) seçer, dar/manzaralı yolları cezalandırır. Motorcu için çoğu zaman tam tersi istenir. `infra/osrm-profiles/motorcycle.lua` bunu düzeltir:

- **Taban:** imajdaki `/opt/car.lua`'yı `loadfile` ile yükler ve `setup()`'ı sarmalar — tüm `car` davranışı korunur, sadece istenen alanlar değiştirilir (OSRM sürümüne dayanıklı; eksik alan varsa atlanır).
- **Hız çarpanları:** `motorway`/`trunk` düşürülür (caydırılır), `tertiary`/`unclassified` yükseltilir (manzaralı yollar öne çıkar). `weight_name = 'routability'` süre temelli olduğundan, hızı düşürmek o yolu "pahalı" yapar.
- **Erişim:** `motorcycle` etiketi erişim hiyerarşisinin başına alınır — `motorcycle=no` yol dışlanır, `motorcycle=yes` açılır.
- **Zemin:** `gravel`/`dirt`/`ground` vb. ek cezalandırılır (kıvrımlı asfalt isteriz, arazi değil).

```bash
make osrm-data OSRM_PROFILE=motorcycle   # car.lua yerine motorcycle.lua ile yeniden işler
make osrm-up
```

`OSRM_PROFILE` (varsayılan `car`) profil dosyasını seçer: `car` → `/opt/car.lua`, diğer adlar → `infra/osrm-profiles/<ad>.lua` (container'a `/profiles` olarak mount edilir). **Kısıtlar:** yalnız self-hosted OSRM'de çalışır (genel demo sunucusu yalnız `driving` sunar); hız tablosu ölçeklendiği için tahmini varış süresi de değişir (amaç "en hızlı" değil "en keyifli" rota); çarpanlar deneme-yanılma ile ince ayar ister. Virajlılık sürgüsünün yerini almaz — profil "hangi yollar güzel", sürgü "ne kadar viraj" der; birlikte çalışırlar.

## Virajlılık (curviness) tercihi

- `POST /api/routes/plan` ve `POST /api/routes` (snap ile) opsiyonel `"curviness": 0..1` alır: OSRM'den **alternatif rotalar** istenir (`alternatives=3`) ve istenen virajlılığa en uygun olan seçilir (0 = en düz, 1 = en virajlı).
- **Skor:** toplam mutlak yön değişimi (derece) / mesafe (km) — saf fonksiyon `curvinessScore` ([`curviness.go`](../backend/internal/route/curviness.go)). Yanıttaki her plan `curviness` alanını taşır (≈ <30 düz, 30–100 kıvrımlı, >100 çok virajlı).
- **Kısıt:** OSRM alternatifleri yalnız **2 nokta** arasında üretir; ara nokta varsa tek rota döner ve tercih etkisizdir. Daha derin kontrol için motosiklete özel OSRM profili gerekir (bkz. "Motosiklete özel OSRM profili").
- **Mobil:** Yeni Rota ekranında sürgü (Düz ↔ Virajlı); önizleme istatistiklerinde virajlılık etiketi.

## Dosya içe/dışa aktarma (GPX + KML)

- **İçe aktarma (birleşik):** `POST /api/routes/import` ham GPX **veya** KML gövdesi alır (maks 10 MB); format **içerikten algılanır** (`ParseRouteFile`, kök elemana bakar — uzantı/Content-Type'a güvenilmez). Kullanıcı format bilmek zorunda değildir: mobilde tek "Dosyadan İçe Aktar" butonu vardır. `/import/gpx` ve `/import/kml` eski istemciler için aynı handler'a takma addır.
- **GPX:** `trkpt` > `rtept` > `wpt` öncelik sırası, 5000 nokta üstü eşit seyreltme, ad `metadata/name` veya `trk/name`'den. Dışa aktarma: `GET /api/routes/:id/gpx` (GPX 1.1 track, `application/gpx+xml`, attachment). Parser/builder: [`gpx.go`](../backend/internal/route/gpx.go).
- **KML:** `Document > Folder > Placemark` önceliğiyle LineString/MultiGeometry aranır; çoklu segmentler birleştirilir (Google Maps çok duraklı rota dışa aktarımı). Dışa aktarma: `GET /api/routes/:id/kml` (KML 2.2, `application/vnd.google-earth.kml+xml`). Parser/builder: [`kml.go`](../backend/internal/route/kml.go).
- İçe aktarılan rota **private** oluşturulur; dışa aktarma görünürlük kuralları `GET /api/routes/:id` ile aynıdır (sahip / public / karşılıklı takip).
- **Mobil UX:** Rotalarım'da tek **"Dosyadan İçe Aktar"**; rota detayında tek **"Dosya Olarak Dışa Aktar"** — dokununca format seçimi çıkar ve her formatın yanında nerede kullanılacağı yazar ("GPX — Strava, Garmin, REVER…", "KML — Google Earth, My Maps…").

## Adım adım navigasyon

- Plan yanıtındaki her `step` artık **manevra noktasını** (`lat`/`lon`) ve OSRM `type`/`modifier` alanlarını taşır; istemci ok ikonunu ve "şuraya dön" mantığını bunlarla kurar.
- **Adım kaynağı:** kayıtlı/yüklenen rota geometrisi en fazla 25 noktaya seyreltilip `POST /api/routes/plan`'a verilir ([`navigation.ts`](../mobile/src/lib/navigation.ts) `fetchRouteSteps`). Bu yüzden GPX'ten gelen veya eski rotalarda da çalışır; yeni uç/migration gerekmez.
- **İlerleme:** sıradaki manevra noktasına ~30 m kala adım tamamlanır; GPS atlaması olduysa bir sonraki adıma açıkça daha yakın olmak da adımı geçirir (`advanceStep`).
- **Mobil UX:** rota takipli solo sürüşte eğimli takip kamerası (pitch 55, zoom 17.5, GPS yönüne dönen kamera) + üstte talimat banner'ı; grup sürüşünde yalnız banner (harita grubu izlemek için serbest kalır). Sesli yönlendirme `expo-speech` (tr-TR) ile 250 m ve 50 m kala; banner'daki hoparlör ikonuyla kapatılır.
- **Re-route:** rotaya uzaklık art arda 2 GPS örneğinde 100 m'yi aşarsa, mevcut konumdan rotaya ~150 m **ileride** katılan yeni bir plan istenir (20 sn soğuma ile). Solo sürüşte kesikli rehber çizgi de yeni geometriyle çizilir; grup sürüşünde ortak rota çizgisi korunur, yalnız sürücünün kendi talimatları yenilenir. Başarıda "Rota yeniden hesaplandı" sesli bildirimi.

## Yükseklik profili

- `GET /api/routes/:id/elevation` rota geometrisini en fazla 100 noktaya seyreltir, **DEM sağlayıcısından** rakımları çeker ve `{points: [{dist, ele}], gain, loss, min, max}` döner (`dist` km, diğerleri metre). Görünürlük kuralları `GET /api/routes/:id` ile aynıdır; sağlayıcı erişilemezse `502`.
- **Sağlayıcı:** OpenTopoData uyumlu HTTP API, `ELEVATION_URL` ile ayarlanır (varsayılan `https://api.opentopodata.org/v1/srtm90m` — hız limitli genel örnek; üretimde self-host önerilir, tek Docker imajı). Yanıt parser'ı ve istatistik fonksiyonları saftır, ağ olmadan test edilir ([`elevation.go`](../backend/internal/route/elevation.go)).
- **Tırmanış/iniş:** SRTM sınıfı DEM'lerde birkaç metrelik gürültü olduğundan toplam tırmanış/iniş **5 m histerezis** ile hesaplanır (`ascentDescent`): referans rakım yalnız eşiği aşan değişimlerde kayar, böylece kademeli okunan uzun bir tırmanış tam yüksekliğiyle sayılır ama gürültü salınımları sayılmaz.
- **Mobil:** Rota detayında istatistik satırı (↗ toplam tırmanış, ↘ iniş, min–max rakım) + `react-native-svg` ile kompakt alan grafiği; uç erişilemezse bölüm gizli kalır.

## Geocoding (adres arama)

Kullanıcı haritaya dokunmadan, bir yer/adres adı **yazarak** nokta buldurabilir
(etkinlik başlangıç/bitiş, rota noktası, gönderi konumu, sürüş hedefi). İleri geocoding
(metin → koordinat) OSRM/elevation ile aynı takılabilir-sağlayıcı desenini izler.

### GET /api/routes/geocode *(korumalı)*

Sorgu parametreleri: `q` (zorunlu, aranan metin), opsiyonel `lat`/`lon` (sürücünün
konumu — yakın sonuçlar öne alınır).

```
GET /api/routes/geocode?q=Taksim&lat=41.01&lon=28.97
```
Yanıt `200`:
```json
{ "places": [ { "name": "Taksim Meydanı, İstanbul, Marmara Bölgesi", "lat": 41.0369, "lon": 28.985 } ] }
```
Sağlayıcı erişilemezse `502`, boş `q` ise `400`.

### Sağlayıcı

İlk sürücü **Nominatim** (OpenStreetMap): `GEOCODE_URL` ile ayarlanır
(varsayılan `https://nominatim.openstreetmap.org`). Parser (`parseNominatimSearch`)
saf bir fonksiyondur, ağ olmadan birim test edilir ([`geocode.go`](../backend/internal/route/geocode.go)).

| Ortam | `GEOCODE_URL` | Not |
|-------|---------------|-----|
| Geliştirme | `https://nominatim.openstreetmap.org` (genel) | Katı kullanım politikası (saniyede 1 istek, zorunlu `User-Agent`), üretimde kullanılmaz |
| Üretim | Kendi Nominatim sunucunuz | Türkiye/bölge extract'ı ile self-host önerilir |

İstemci sonuçları kullanıcı konumuna göre önceliklendirmek için `viewbox` (≈0.7°,
`bounded=0`) ekler; uzak eşleşmeler dışlanmaz, yalnız yakınlar üste çıkar.

## Sonraki adımlar

- Motosiklete özel profilin çarpanlarını gerçek rotalarla ince ayarı; arazi (adventure) için ayrı profil.
- Yön değişimini doğrudan ağırlığa katan `process_segment` tabanlı viraj tercihi (mevcut alternatif-seçme yönteminin ötesinde).
