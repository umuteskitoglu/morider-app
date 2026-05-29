# Morider App

Motosiklet tutkunları için **Strava benzeri** bir mobil uygulama: GPS ile sürüş takibi, rota planlama, topluluk paylaşımı ve ödül/rozet sistemi.

Bu repo bir **monorepo**'dur:

| Klasör | İçerik |
|--------|--------|
| [`backend/`](backend/) | Go (Gin) mikroservis backend — auth, user, ride, route, reward, telemetry + api-gateway |
| [`mobile/`](mobile/) | Expo (managed) React Native uygulaması |
| [`docs/`](docs/) | Mimari, API tasarımı ve ER diyagram dokümanları |
| [`infra/`](infra/) | Monitoring / yardımcı altyapı konfigürasyonları |

## Mimari (özet)

```mermaid
flowchart TB
    MobileApp[Expo React Native App] -->|HTTPS| Gateway[API Gateway :8080]
    Gateway --> Auth[auth :8081]
    Gateway --> User[user :8082]
    Gateway --> Ride[ride :8083]
    Gateway --> Route[route :8084]
    Gateway --> Reward[reward :8085]
    Gateway --> Telemetry[telemetry :8086]
    Auth --> PG[(PostgreSQL + PostGIS)]
    User --> PG
    Ride --> PG
    Route --> PG
    Reward --> PG
    Telemetry --> PG
    Ride --> Redis[(Redis)]
    Telemetry --> NATS[(NATS)]
```

Detaylar için [`docs/architecture.md`](docs/architecture.md).

## Hızlı Başlangıç

### 1. Backend (Docker Compose)

Gereksinim: Docker + Docker Compose.

```bash
cp .env.example .env
make up          # postgis, redis, nats + tüm servisler ayağa kalkar
```

Sağlık kontrolü:

```bash
curl http://localhost:8080/health
```

Örnek auth akışı:

```bash
# Kayıt
curl -X POST http://localhost:8080/api/auth/signup \
  -H 'Content-Type: application/json' \
  -d '{"name":"Umut","email":"umut@example.com","password":"secret123"}'

# Giriş -> token döner
curl -X POST http://localhost:8080/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"umut@example.com","password":"secret123"}'

# Token ile sürüş oluştur
curl -X POST http://localhost:8080/api/rides \
  -H 'Authorization: Bearer <TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"distance":120.5,"avg_speed":85.0,"elevation_gain":600}'
```

Durdurmak için: `make down`. Komut listesi için: `make help`.

### 2. Mobil (Expo)

Gereksinim: Node.js 18+, Expo Go uygulaması (telefonda) veya bir emülatör.

```bash
cd mobile
npm install
npx expo start
```

> Telefondan test ederken `mobile/.env` içindeki `EXPO_PUBLIC_API_URL` değerini bilgisayarınızın LAN IP'si ile değiştirin (örn. `http://192.168.1.20:8080`).

## Testler

```bash
make backend-test
```

CI (GitHub Actions) her push/PR'da backend testlerini (`go vet` + `go test -race`) ve mobil tip kontrolünü (`tsc --noEmit`) çalıştırır — bkz. [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

## İzleme (Monitoring)

Her servis Prometheus formatında `/metrics` ucu sunar (HTTP istek sayısı, gecikme + Go runtime metrikleri). Compose ile gelen Prometheus arayüzü `http://localhost:9090` üzerindedir; scrape hedefleri [`infra/prometheus.yml`](infra/prometheus.yml) içinde tanımlıdır.

## Lisans

MIT — bkz. [`LICENSE`](LICENSE).
