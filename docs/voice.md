# Grup Sürüşü Sesli Sohbet (LiveKit)

Canlı grup sürüşlerinde sürücüler arası **sürekli açık (always-on) sesli sohbet**.
Push-to-talk yok: sürücü sesli sohbete katıldığında mikrofonu canlı kalır ve
gruptaki herkesi otomatik dinler — eller serbest bir telsiz/intercom.

## Mimari

Her grup sürüşü oturumu (session) bir **LiveKit room**'una eşlenir: `ride-<session_id>`.
Canlı konum paylaşımıyla (WebSocket + NATS) aynı oturum kodunu paylaşır ama ondan
bağımsız çalışır.

```
Mobil (LiveKit SDK) ──token iste──▶ telemetry servisi ──üyelik doğrula──▶ Postgres
       │                                   │
       │            ◀──signed JWT──────────┘  (room=ride-<id>, publish+subscribe)
       ▼
   LiveKit SFU  ◀── ses akışı (Opus/WebRTC) ──▶  diğer sürücüler
```

- **Token üretimi:** `POST /api/sessions/:code/voice-token`
  ([backend/internal/telemetry/voice.go](../backend/internal/telemetry/voice.go)).
  Yalnızca oturumun **aktif katılımcılarına** verilir; token `RoomJoin + CanPublish +
  CanSubscribe` haklarıyla 6 saat geçerlidir. Identity = `user-<id>`.
- **SFU:** kendi sunucumuzda (`livekit/livekit-server`), `docker-compose.yml`'de
  `livekit` servisi. Room durumu projedeki Redis üzerinden paylaşılır (çok-replica).
- **Mobil:** [mobile/src/lib/voice.ts](../mobile/src/lib/voice.ts) `useGroupVoice` hook'u
  room yaşam döngüsünü yönetir; [GroupRideScreen](../mobile/src/screens/GroupRideScreen.tsx)
  katıl/ayrıl + mute butonlarını ve konuşan kişi göstergesini sunar.

## Kurulum

### Backend / Infra

`.env` içinde LiveKit kimlik bilgilerini ayarla (telemetry servisinin imzaladığı
token'lar bu değerlerle eşleşmeli):

```bash
LIVEKIT_URL=ws://localhost:7880        # cihazdan test ederken LAN IP: ws://192.168.1.20:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=devsecret_change_me_in_production_32b
```

```bash
docker compose up -d livekit telemetry
```

Üretimde **mutlaka** güçlü bir `LIVEKIT_API_SECRET` üret (`APP_ENV=production` iken
varsayılan secret reddedilir).

### Mobil — custom dev build gerekir

LiveKit native WebRTC modülü içerir, bu yüzden **Expo Go ile çalışmaz**. Bir kez
custom dev client derlemen gerekir:

```bash
cd mobile
npx expo install   # bağımlılıklar zaten package.json'da
eas build --profile development --platform ios     # veya android
# derlenen dev client'ı cihaza kur, sonra:
npx expo start --dev-client
```

Gerekli izinler/arka plan modları [app.json](../mobile/app.json)'da tanımlı:
iOS `NSMicrophoneUsageDescription` + `UIBackgroundModes: [audio, voip]`, Android
`RECORD_AUDIO` / `MODIFY_AUDIO_SETTINGS`.

## Üretim dağıtımı (lean stack)

> **En sık hata:** prod stack'i voice **profili olmadan** başlatmak. O zaman
> LiveKit container'ı hiç ayağa kalkmaz (7880 kapalı) ve uygulama "Bağlanamadı"
> der. Sesli sohbet için **mutlaka** voice profili ile başlat:

```bash
make prod-up-voice        # = docker compose -f docker-compose.prod.yml --profile voice up -d --build
make prod-ps              # livekit container "Up" görünmeli
```

Firewall'da şu portları aç (DigitalOcean cloud firewall dahil):

| Port | Protokol | Ne için |
|------|----------|---------|
| 7880 | TCP | LiveKit signalling (WebSocket) |
| 7881 | TCP | WebRTC over TCP (NAT fallback) |
| 7882 | UDP | WebRTC medya |

`LIVEKIT_URL` hakkında: artık `.env`'de `localhost` kalsa bile token endpoint'i,
client'ın API'ye ulaştığı public host'tan otomatik türetir (tek-kutu deploy'da
LiveKit aynı host'ta, `ws://<public-host>:7880`). Yine de en temizi `.env`'de
açıkça vermek:

```bash
LIVEKIT_URL=ws://138.197.178.107:7880   # TLS varsa wss://voice.morider.app
```

### NAT / TURN

Self-hosted SFU mobil ağlarda (4G/5G, simetrik NAT) **TURN sunucusu olmadan**
bağlanamayabilir. Sıkı mobil NAT için:

- LiveKit'in gömülü TURN'ünü etkinleştir (`turn:` bloğu, TLS sertifikası ile) **veya**
  ayrı bir `coturn` çalıştır.
- `rtc.use_external_ip: true` (zaten `livekit.prod.yaml`'de açık) ve düğümün public
  IP'sini yayınlar; RTC UDP/TCP portlarını (7881/7882) firewall'da aç.
- TLS arkasındaysan `LIVEKIT_URL`'i `wss://` olarak ver.

## Pil / veri

Sürekli açık ses + GPS + navigasyon ciddi pil/veri tüketir. SDK varsayılanı düşük
bit hızlı Opus kullanır ve yalnızca konuşan taraf veri gönderir (sessizken VAD ile
susar), ama yine de kullanıcılara uzun sürüşlerde powerbank önerilir.
