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

## Üretim notları (NAT / TURN)

Self-hosted SFU mobil ağlarda (4G/5G, simetrik NAT) **TURN sunucusu olmadan**
bağlanamayabilir. Üretim dağıtımında:

- LiveKit'in gömülü TURN'ünü etkinleştir (`turn:` bloğu, TLS sertifikası ile) **veya**
  ayrı bir `coturn` çalıştır.
- `rtc.use_external_ip: true` yap ve düğümün public IP'sini yayınla; RTC UDP/TCP
  portlarını (7881/7882) firewall'da aç.
- `LIVEKIT_URL`'i `wss://` (TLS) olarak ver.

## Pil / veri

Sürekli açık ses + GPS + navigasyon ciddi pil/veri tüketir. SDK varsayılanı düşük
bit hızlı Opus kullanır ve yalnızca konuşan taraf veri gönderir (sessizken VAD ile
susar), ama yine de kullanıcılara uzun sürüşlerde powerbank önerilir.
