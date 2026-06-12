# API Tasarımı

Tüm uçlar API Gateway (`http://localhost:8080`) üzerinden sunulur. Korumalı uçlar `Authorization: Bearer <token>` başlığı bekler.

## Auth

### POST /api/auth/signup
```json
{ "name": "Umut", "email": "umut@example.com", "password": "secret123", "country": "TR" }
```
Yanıt `201`:
```json
{ "token": "<jwt>", "user": { "id": 1, "name": "Umut", "email": "umut@example.com", "country": "TR" } }
```

### POST /api/auth/login
```json
{ "email": "umut@example.com", "password": "secret123" }
```
Yanıt `200`: signup ile aynı gövde.

### GET /api/auth/me  *(korumalı)*
```json
{ "user_id": 1, "email": "umut@example.com" }
```

## Users

| Method | Path | Açıklama |
|--------|------|----------|
| GET | `/api/users/:id` | Profil getir |
| PUT | `/api/users/:id` | Profil güncelle *(korumalı, sadece kendi profili)* |

Profil alanları: `name`, `username`, `country`, `avatar_url`, **`license_type`** (`A1|A2|A|B`) ve **`bike_type`** (`naked|sport|touring|adventure|chopper|enduro|scooter|custom`). Boş gönderilen alan mevcut değeri korur.

## Rides *(korumalı)*

| Method | Path | Açıklama |
|--------|------|----------|
| POST | `/api/rides` | Yeni sürüş |
| GET | `/api/rides` | Kullanıcının sürüşleri |
| GET | `/api/rides/:id` | Tek sürüş |

POST gövdesi:
```json
{
  "route_id": null,
  "start_time": "2026-05-29T08:00:00Z",
  "end_time": "2026-05-29T12:30:00Z",
  "distance": 250.5,
  "avg_speed": 89.3,
  "elevation_gain": 1200.0
}
```
`avg_speed` verilmezse `start_time`/`end_time` ile hesaplanır.

## Routes *(korumalı)*

| Method | Path | Açıklama |
|--------|------|----------|
| POST | `/api/routes` | Rota oluştur (opsiyonel `snap`) |
| POST | `/api/routes/plan` | Yola oturtulmuş güzergâh önizle (kayıt yok) |
| GET | `/api/routes` | Rotaları listele |
| GET | `/api/routes/:id` | Rota + noktalar (GeoJSON'dan) |
| GET | `/api/routes/:id/gpx` | Rotayı GPX 1.1 dosyası olarak indir |
| GET | `/api/routes/:id/elevation` | Yükseklik profili (örneklenmiş, DEM'den) |
| POST | `/api/routes/import/gpx` | Ham GPX gövdesinden rota oluştur (gizli) |
| PUT | `/api/routes/:id` | Güncelle |
| DELETE | `/api/routes/:id` | Sil |

POST gövdesi (mesafe sunucuda PostGIS ile hesaplanır):
```json
{
  "name": "Sahil turu",
  "description": "İstanbul - Ankara",
  "points": [
    { "lat": 41.0082, "lon": 28.9784 },
    { "lat": 39.9334, "lon": 32.8597 }
  ],
  "snap": true
}
```
`snap: true` verilirse noktalar rota motorundan geçirilip **yola oturtulmuş** geometri saklanır (varsayılan `false` → düz çizgi). Rota motoru ayrıntıları: [`routing.md`](routing.md).

### POST /api/routes/plan
Kaydetmeden güzergâh önizleme:
```json
{ "waypoints": [ { "lat": 40.9907, "lon": 29.0289 }, { "lat": 41.0235, "lon": 29.0152 } ] }
```
Yanıt `200` (`distance` km, `duration` dk, `steps[].distance` m):
```json
{
  "distance": 4.99,
  "duration": 6.23,
  "points": [ { "lat": 40.9907, "lon": 29.0289 }, ... ],
  "steps": [ { "instruction": "Sağa dön - Rıhtım Caddesi", "name": "Rıhtım Caddesi", "distance": 320.0 } ]
}
```

## Garaj *(korumalı)*

Sürücünün motosikletleri, belge bitiş tarihleri ve servis defteri. Ride servisi sunar; hatırlatmalar cihaz üzerinde planlanır (backend yalnız tarihleri saklar).

| Method | Path | Açıklama |
|--------|------|----------|
| POST | `/api/garage` | Motor ekle (`name` zorunlu; `plate`, `year`, 3 tarih opsiyonel) |
| GET | `/api/garage` | Motorlarımı listele |
| PUT | `/api/garage/:id` | Güncelle (tam değiştirme; boş tarih = temizle) |
| DELETE | `/api/garage/:id` | Sil (servis kayıtları cascade) |
| POST | `/api/garage/:id/services` | Servis kaydı ekle (`title` zorunlu; `note`, `odometer_km`, `cost`, `service_date`) |
| GET | `/api/garage/:id/services` | Servis kayıtlarını listele (tarihe göre azalan) |
| DELETE | `/api/garage/:id/services/:sid` | Servis kaydını sil |

Tarih alanları `YYYY-MM-DD` string'tir: `insurance_expiry` (trafik sigortası), `inspection_expiry` (muayene), `kasko_expiry`. `service_date` boş gönderilirse bugünün tarihi kullanılır.

## POI / Mola Noktaları *(korumalı)*

Topluluk katkılı noktalar: motorcu dostu kafe, yakıt, tamirci, manzara, mola. Route servisi sunar (PostGIS point + GIST index).

| Method | Path | Açıklama |
|--------|------|----------|
| POST | `/api/pois` | Nokta ekle (`name`, `category`, `lat`, `lon`, ops. `description`) |
| GET | `/api/pois?min_lat&min_lon&max_lat&max_lon` | Sınır kutusundaki noktalar (maks 300) |
| GET | `/api/pois/route/:id` | Rotanın 1 km çevresindeki noktalar (rota görünürlük kuralları geçerli) |
| DELETE | `/api/pois/:id` | Sil (yalnız ekleyen) |

`category`: `cafe | fuel | repair | viewpoint | rest`. Noktalar herkese görünür; silme yalnız sahibine açıktır.

## Rewards & Leaderboard *(korumalı)*

| Method | Path | Açıklama |
|--------|------|----------|
| GET | `/api/rewards` | Kullanıcının rozetleri |
| POST | `/api/rewards` | Rozet ver (sistem/manuel) |
| GET | `/api/leaderboard/top` | Toplam mesafeye göre ilk 20 |

POST gövdesi:
```json
{ "type": "bronze_badge", "description": "1000 km club" }
```

Her rozet kullanıcı başına en fazla bir kez verilir; aynı `type` ikinci kez gönderilirse `409 Conflict` döner.

### Otomatik rozet motoru (kural tabanlı)

Bir sürüş kaydedildiğinde ride servisi NATS'a `ride.completed` olayı yayınlar; reward servisi bunu tüketip kullanıcının tüm geçmişini yeniden değerlendirir ve hak edilen rozetleri **otomatik** ekler (idempotent — olay tekrar gelse de duplicate oluşmaz). NATS yoksa REST uçları çalışmaya devam eder, yalnız otomatik rozetlendirme durur.

Mevcut kurallar ([`backend/internal/reward/rules.go`](../backend/internal/reward/rules.go)):

| Tip | Koşul |
|-----|-------|
| `first_ride` | ≥ 1 sürüş |
| `rider_10` | ≥ 10 sürüş |
| `rider_50` | ≥ 50 sürüş |
| `century_ride` | tek sürüşte ≥ 100 km |
| `long_hauler` | tek sürüşte ≥ 300 km |
| `club_1000` | toplam ≥ 1000 km |
| `club_10000` | toplam ≥ 10.000 km |
| `week_300` | bir ISO haftasında ≥ 300 km |
| `week_700` | bir ISO haftasında ≥ 700 km |
| `month_1000` | bir takvim ayında ≥ 1000 km |
| `month_3000` | bir takvim ayında ≥ 3000 km |
| `streak_7` | 7 gün aralıksız sürüş |
| `streak_30` | 30 gün aralıksız sürüş |
| `speedster_100` | tek sürüşte ort. hız ≥ 100 km/s |
| `speedster_140` | tek sürüşte ort. hız ≥ 140 km/s |

> Hız rozetleri, sahte GPS sıçramalarını elemek için ort. hızı 0–300 km/s aralığıyla sınırlar (hafif anti-cheat; kapsamlı doğrulama ileride).

## Telemetry *(korumalı)*

### POST /api/telemetry
Toplu GPS noktası gönderimi:
```json
{
  "points": [
    { "ride_id": 456, "lat": 40.12345, "lon": 29.98765, "altitude": 150.2, "speed": 72.5, "ts": "2026-05-29T08:15:23Z" }
  ]
}
```

### GET /api/telemetry/ws?token=&lt;jwt&gt;
WebSocket. İstemci her mesajda bir GPS noktası (POST gövdesindeki tek eleman formatında) gönderir; sunucu `{ "status": "ok", "ride_id": 456 }` ile yanıt verir ve noktayı `telemetry.points` NATS konusuna yayınlar.
