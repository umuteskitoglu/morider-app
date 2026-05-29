# Sosyal & Topluluk Özellikleri — Plan

Bu doküman 5 talebi uygulanabilir fazlara böler. Sıra, bağımlılık ve riske göredir: önce veri modeli temeli ve düşük riskli kazanımlar, en sona gerçek-zamanlı (en karmaşık) grup sürüşü.

| Faz | Özellik | Karmaşıklık | Bağımlılık |
|-----|---------|-------------|------------|
| 1 | Rota görünürlüğü (private/public/friends) + Keşfet | Orta | — |
| 2 | Kaydedilen rotada sürme (haritadan takip) | Düşük | — |
| 3 | Public rotaları puanlama | Orta | Faz 1 |
| 4 | Arkadaş ekleme + friends görünürlüğü | Orta-Yüksek | Faz 1 |
| 5 | Birlikte sürme + canlı konum paylaşımı | Yüksek | Faz 4 |

---

## Faz 1 — Rota görünürlüğü + Keşfet (Community)

**Veri modeli** (`migrations/0003_route_visibility.sql`):
- `routes.visibility TEXT NOT NULL DEFAULT 'private'` — değerler: `private`, `public`, `friends`.
- `idx_routes_visibility` (public listeleme için).

**API:**
- `POST/PUT /api/routes` gövdesine `visibility` (varsayılan `private`).
- `GET /api/routes` — yalnız kendi rotaları (değişmez), `visibility` döner.
- `GET /api/routes/explore` — **başkalarının public rotaları**, sahip adıyla (users join), `LIMIT 50`.
- `GET /api/routes/:id` — yetki: sahip **veya** `public`. (friends → Faz 4.)

**Mobil:**
- RouteCreate: görünürlük seçici (Gizli / Herkese açık).
- RouteDetail: sahip adı + görünürlik rozeti; sil yalnız sahibe.
- Yeni **Keşfet** ekranı (Rotalar stack'i içinde): public rotalar listesi → detay.

## Faz 2 — Kaydedilen rotada sürme

Backend değişikliği yok (mevcut `GET /api/routes/:id` geometriyi döner).

**Mobil:**
- RouteDetail → **"Bu Rotada Sür"** butonu → Sürüş (harita) sekmesine `followRouteId` ile geçer.
- MapScreen rotayı ikincil bir polyline (amber) olarak gösterir; kullanıcı normal kaydını yapar, ekranda hedef güzergâhı görür.

## Faz 3 — Public rotaları puanlama + Foto paylaşımı (akış)

### 3a. Rota puanlama
**Veri modeli** (`migrations/0004_route_ratings.sql`):
- `route_ratings (id, route_id FK, user_id FK, score SMALLINT 1..5, created_at)`, `UNIQUE(route_id, user_id)` (kullanıcı başına tek oy, idempotent).

**API:**
- `POST /api/routes/:id/rate` `{ "score": 1..5 }` — upsert (ON CONFLICT güncelle).
- `GET /api/routes/:id` ve `explore` yanıtına `avg_rating`, `rating_count`, `my_rating` eklenir.

**Mobil:** RouteDetail'de 5 yıldız; explore kartlarında ortalama yıldız.

### 3b. Foto paylaşımı — Instagram tarzı akış
**Yeni servis:** `feed` (port 8087). Foto dosyaları diske (mount'lu volume) kaydedilir, statik servis edilir; meta veriler Postgres'te.

**Veri modeli** (`migrations/0005_posts.sql`):
- `posts (id, user_id FK, caption, location_name, lat, lon, created_at)`.
- `post_photos (id, post_id FK, url, position)` — bir gönderide çoklu foto.

**API (feed servisi):**
- `POST /api/posts` — multipart: `photos[]` (1+), `caption`, ops. `location_name`/`lat`/`lon`. Dosyaları uuid adıyla kaydeder.
- `GET /api/feed` — gönderiler (yeni→eski), her biri fotolar + yazar adı + konum.
- `GET /api/feed/media/:file` — **public** (auth yok; uuid isimli) foto servis eder. `<Image>` token gönderemediği için public.

**Gateway:** `/api/feed` ve `/api/posts` → feed servisi.

**Mobil:**
- Yeni **Akış** sekmesi: dikey kaydırılan tam ekran gönderiler (FlatList paging); her gönderi yatay kaydırmalı **çoklu foto carousel**, açıklama, yazar, konum.
- Gönderi oluştur: `expo-image-picker` ile çoklu foto seç, açıklama, ops. konum (mevcut konum).

> Not: Üretimde dosya depolama S3/MinyO'ya taşınmalı; MVP'de yerel volume.

## Faz 4 — Arkadaşlık + friends görünürlüğü

**Veri modeli** (`migrations/0005_friendships.sql`):
- `friendships (id, requester_id FK, addressee_id FK, status TEXT[pending|accepted], created_at)`, `UNIQUE(requester_id, addressee_id)`.

**API (yeni user/friends servisi veya user servisine ek):**
- `POST /api/friends/requests` `{ "email" }` — istek gönder.
- `POST /api/friends/requests/:id/accept` — kabul.
- `GET /api/friends` — kabul edilmiş arkadaşlar.
- `GET /api/friends/requests` — gelen istekler.
- Görünürlük `friends` olan rotalar: `GET /api/routes/:id` ve explore, istekte bulunanın arkadaşlarına da görünür (EXISTS friendships accepted).

**Mobil:** Arkadaşlar ekranı (profil altında): istek gönder (e-posta), gelen istekler, arkadaş listesi.

## Faz 5 — Birlikte sürme + canlı konum

En karmaşık kısım; mevcut telemetri WS + NATS altyapısı üzerine kurulur.

**Veri modeli** (`migrations/0006_ride_sessions.sql`):
- `ride_sessions (id, route_id FK?, host_id FK, code TEXT unique, status, created_at)`.
- `session_participants (session_id FK, user_id FK, joined_at)`.

**Backend (telemetry servisi genişler):**
- `POST /api/sessions` — oturum oluştur (kod üret), arkadaş davet.
- `POST /api/sessions/:code/join` — katıl.
- `GET /api/sessions/:code/ws?token=` — WS: katılımcı kendi GPS'ini gönderir; sunucu **oturumdaki diğerlerinin** konumlarını fan-out eder.
  - Fan-out: NATS subject `session.<id>.positions`; her WS bağlantısı bu subject'e abone olur ve gelenleri istemciye iletir. Böylece yatay ölçeklenir (servis replikaları NATS üzerinden haberleşir).

**Mobil:** Oturum oluştur/katıl; harita üzerinde her katılımcı için canlı marker (ad + renk); aynı hedef rota gösterilir.

**Riskler/notlar:** Pil (arka plan GPS), konum gizliliği (yalnız oturum süresince paylaşılır), bağlantı kopması/yeniden bağlanma, kimlik (WS token doğrulaması — mevcut desen var).

---

## Uygulama sırası (bu teslim)

Bu turda **Faz 1 + Faz 2** yapılır (community temeli + rotada sürme). Faz 3-5 sonraki turlarda; özellikle Faz 5 ayrı ve dikkatli ele alınmalı.
