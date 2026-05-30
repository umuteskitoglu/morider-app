# Faz 4 & Faz 5 — Yapılacaklar (Uygulama Planı)

Bu doküman, [`social-features.md`](social-features.md)'deki Faz 4 (Arkadaşlık) ve Faz 5 (Canlı Grup Sürüşü) için **devam edilebilir** bir görev listesidir. Faz 1–3 tamamlandı.

## Mevcut durum & konvansiyonlar (devam etmeden önce oku)

- **Servisler:** tek binary, `-service=<ad>` bayrağı. Eklemek için: `internal/<svc>/`, `cmd/morider/main.go` runners map, `internal/gateway/gateway.go` route, `pkg/config/config.go` URL, `docker-compose.yml` servis + `.env`/`.env.example`.
- **Migration sayacı:** son uygulanan `0007_reward_showcase.sql`. Yeni dosyalar `0008_...`, `0009_...` şeklinde; idempotent yaz (`IF NOT EXISTS`, `DO $$ ... pg_constraint` deseni). `make migrate` hepsini sırayla uygular.
- **Auth:** her serviste `d.JWT.Middleware()`; kullanıcı id = `authpkg.UserID(c)`. WS auth `?token=` ile (bkz. telemetry `ws`).
- **NATS:** opsiyonel; `pkg/events` paylaşılan olay tipleri. Fan-out deseni telemetry'de mevcut.
- **Mobil:** ekranlar `mobile/src/screens`, ortak bileşenler `mobile/src/components`. Navigasyon `RootNavigator.tsx` (tab + stack). Liste ekranlarında `RefreshControl`, `useFocusEffect` deseni. `api` (axios) + `apiBaseURL()`.
- **Görünürlük:** `routes.visibility` zaten `private|public|friends` destekliyor (CHECK + `writeReq` binding). `friends` değeri **henüz enforce edilmiyor** — Faz 4'te yapılacak.

---

## FAZ 4 — Arkadaşlık + "friends" görünürlüğü

> **Güncelleme (Faz 5 hazırlığı):** Karşılıklı istek/kabul "arkadaşlık" modeli, Instagram tarzı
> **tek yönlü takip**le değiştirildi. `friendships` tablosu kaldırıldı (`0009_follows.sql`),
> yerine `follows (follower_id, followee_id)` geldi. Uçlar `/api/follows` altında:
> `PUT/DELETE /:userId`, `GET /following`, `GET /followers`, `GET /status/:userId`
> (`{following, followed_by}`). **`friends` görünürlüğü = karşılıklı takip** (iki yönlü `follows`).
> Faz 5 grup daveti bu modele dayanacak. Aşağıdaki orijinal arkadaşlık planı tarihsel referanstır.

### 4.1 Veri modeli — `migrations/0008_friendships.sql`
- [ ] `friendships (id BIGSERIAL PK, requester_id BIGINT FK users, addressee_id BIGINT FK users, status TEXT CHECK in ('pending','accepted'), created_at TIMESTAMPTZ)`.
- [ ] `UNIQUE(requester_id, addressee_id)`; `CHECK (requester_id <> addressee_id)`.
- [ ] İndeksler: `(addressee_id, status)`, `(requester_id, status)`.
- [ ] Yardımcı görüş (opsiyonel): kabul edilmiş arkadaşlıkları iki yönlü sorgulamak için bir SQL view ya da sorgu deseni belirle (aşağıdaki `are_friends` mantığı).

**Arkadaşlık kontrolü (her yerde kullanılacak):**
```sql
EXISTS (SELECT 1 FROM friendships f
        WHERE f.status = 'accepted'
          AND ((f.requester_id = $A AND f.addressee_id = $B)
            OR (f.requester_id = $B AND f.addressee_id = $A)))
```

### 4.2 Servis — `internal/user`'a ekle (yeni servis gerekmez)
> Gateway zaten `/api/users` → user servisine gidiyor. `friends` uçlarını da user servisine koy; gateway'e `{"/api/friends", cfg.UserURL}` ekle. **Alternatif:** ayrı `social` servisi (daha temiz ama daha çok iş). Öneri: user servisi.

Endpoint'ler (hepsi korumalı):
- [ ] `POST /api/friends/requests` body `{ "email": "..." }` → e-posta ile kullanıcı bul, `pending` istek oluştur. Hatalar: kendine istek (400), zaten arkadaş/istek var (409), kullanıcı yok (404).
- [ ] `GET /api/friends/requests` → bana gelen `pending` istekler (`requester` adı + id).
- [ ] `POST /api/friends/requests/:id/accept` → isteği `accepted` yap (yalnız addressee). 
- [ ] `POST /api/friends/requests/:id/decline` → isteği sil/`declined`.
- [ ] `DELETE /api/friends/:userId` → arkadaşlıktan çıkar.
- [ ] `GET /api/friends` → kabul edilmiş arkadaşlar (id, name, email).
- [ ] (Opsiyonel) `GET /api/friends/status/:userId` → `none|pending_out|pending_in|friends` (profil ekranında buton durumu için).

### 4.3 "friends" görünürlüğü enforce
- [ ] `internal/route/route.go` `get`: WHERE'i genişlet — sahip **veya** public **veya** (`visibility='friends'` AND `are_friends(viewer, owner)`).
- [ ] `explore` feed'i: public + arkadaşların `friends` rotalarını da gösterecek şekilde genişletilebilir (opsiyonel; MVP'de yalnız public kalsın, ayrı bir "Arkadaşlar" feed'i düşün).
- [ ] (Karar) Foto akışı (`feed`) şu an herkese açık. İstenirse "yalnız arkadaşlar" feed'i: `GET /api/feed/friends` → arkadaşların gönderileri. Faz 4 kapsamına alınabilir.

### 4.4 Mobil
- [ ] **Arkadaşlar ekranı** (Profil altında bir stack veya yeni sekme): sekmeler/segment — "Arkadaşlarım", "İstekler". 
  - Profil şu an düz tab; arkadaşlar ekranı için Profil'i bir **ProfileStack**'e sar (ProfileMain + Friends) ya da modal kullan.
- [ ] **Arkadaş ekle:** e-posta ile istek gönderme (TextField + buton → `POST /api/friends/requests`).
- [ ] **Gelen istekler:** kabul/reddet butonları.
- [ ] **UserProfileScreen**'e arkadaşlık aksiyon butonu: durum'a göre "Arkadaş Ekle / İstek Gönderildi / İsteği Kabul Et / Arkadaşsınız". `GET /api/friends/status/:userId` ile.
- [ ] Rota oluşturma görünürlük seçicisine **"Arkadaşlar"** seçeneği ekle (şu an Gizli/Herkese Açık; üçüncü pill).

### 4.5 Doğrulama
- [ ] İki kullanıcı: istek gönder → kabul → `are_friends` true.
- [ ] `friends` görünürlüklü rota: arkadaş görür (200), yabancı görmez (404).
- [ ] Backend `go build/vet/test`; gin route panik kontrolü (yeni `/friends/...` rotaları).

---

## FAZ 5 — Canlı Grup Sürüşü (gerçek-zamanlı)

> En karmaşık faz. **Arkadaşlık (Faz 4) önce bitmeli** (davet/katılım izinleri için). Mevcut telemetry WS + NATS fan-out deseni temel alınır.

### 5.1 Veri modeli — `migrations/0009_ride_sessions.sql`
- [ ] `ride_sessions (id BIGSERIAL PK, code TEXT UNIQUE, host_id BIGINT FK users, route_id BIGINT FK routes NULL, status TEXT in ('active','ended'), created_at, ended_at NULL)`.
- [ ] `session_participants (session_id BIGINT FK, user_id BIGINT FK, joined_at, PRIMARY KEY(session_id, user_id))`.
- [ ] `code`: kısa, paylaşılabilir (ör. 6 haneli base32). 

### 5.2 Servis — `internal/telemetry`'yi genişlet (WS + NATS zaten var)
- [ ] `pkg/events`: `SubjectSessionPositions = "session.%d.positions"` (session id ile) + `LivePosition{ SessionID, UserID, Name, Lat, Lon, Speed, Ts }`.
- [ ] `POST /api/sessions` body `{ "route_id"?: int }` → kod üret, host'u participant ekle, döndür `{ code, session_id }`.
- [ ] `POST /api/sessions/:code/join` → katılımcı ekle (status active olmalı). (Opsiyonel: yalnız davet edilen arkadaşlar.)
- [ ] `POST /api/sessions/:code/leave` / `POST /api/sessions/:code/end` (host).
- [ ] `GET /api/sessions/:code` → katılımcılar + route geometrisi (varsa).
- [ ] **WS** `GET /api/sessions/:code/ws?token=` :
  - Token doğrula, kullanıcı oturumun katılımcısı mı kontrol et.
  - NATS subject `session.<id>.positions`'a **subscribe** ol; gelen diğer katılımcı konumlarını WS'e yaz.
  - İstemciden gelen her konumu DB'ye (opsiyonel) yaz + NATS'a **publish** et (kendi user_id'siyle).
  - Bağlantı kapanınca aboneliği temizle. NATS yoksa tek-replika fallback (in-memory hub) düşün.

**Ölçeklenme notu:** NATS üzerinden fan-out sayesinde servis yatay çoğaltılabilir; her WS bağlantısı kendi replikasındaki subject aboneliğinden beslenir.

### 5.3 Mobil
- [ ] **Oturum oluştur:** rota detayından veya sürüş ekranından "Grup sürüşü başlat" → kod üret → paylaş (arkadaş davet / kodu kopyala).
- [ ] **Katıl:** kod ile katılma ekranı.
- [ ] **Canlı harita:** `MapScreen` benzeri; her katılımcı için renkli **canlı marker** (ad etiketi). Kendi GPS'ini WS'e gönder (mevcut `watchPositionAsync` + `expo-location`), gelenleri haritada güncelle.
- [ ] Hedef rota varsa onu amber rehber çizgisiyle göster (Faz 2 `followRouteId` deseni).
- [ ] Bağlantı kopması/yeniden bağlanma; oturumdan ayrılma.

### 5.4 Riskler / kararlar
- [ ] **Gizlilik:** konum yalnız aktif oturum süresince paylaşılır; oturum bitince dur.
- [ ] **Pil / arka plan:** sürekli GPS pil yer; arka plan konumu (Expo'da ek kurulum) gerekebilir — MVP'de ön plan yeterli.
- [ ] **Kimlik & yetki:** WS token doğrulaması + katılımcı kontrolü şart.
- [ ] **Throttle:** konum gönderimini ~2–3 sn'de bir sınırla (telemetry deseni: `timeInterval: 3000`).
- [ ] **Test:** iki istemciyle WS fan-out (bir konum gönder → diğerinde gör). Yerel: postgres+nats + iki token.

---

## Önerilen sıra
1. Faz 4.1–4.3 (backend: arkadaşlık + friends görünürlüğü) → doğrula.
2. Faz 4.4 (mobil arkadaşlık ekranları).
3. Faz 5.1–5.2 (backend: oturum + WS fan-out) → iki istemci ile doğrula.
4. Faz 5.3 (mobil canlı harita).

Her adımda mevcut akış: `go build/vet/test` + gin panik kontrolü + `make migrate` + `docker compose up -d --build <svc>` + canlı curl/WS testi; mobil `tsc --noEmit` + headless `expo export` + Metro reload.
