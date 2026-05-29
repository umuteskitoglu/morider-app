# Kurulum

## Gereksinimler

- Docker + Docker Compose (backend)
- Go 1.25+ (yerel backend testleri için, opsiyonel)
- Node.js 18+ ve Expo (mobil)
- Fiziksel cihazda test için Expo Go uygulaması

## Backend

```bash
cp .env.example .env
make up          # postgis + redis + nats + tüm servisleri build edip çalıştırır
make ps          # container durumları
make logs        # logları izle
```

Migration'lar Postgres ilk açılışta otomatik uygulanır (`backend/migrations` -> `/docker-entrypoint-initdb.d`). Volume'u sıfırlayıp tekrar uygulamak için:

```bash
make down
docker volume rm morider_pgdata
make up
```

Sağlık kontrolü ve örnek akış için kök [README](../README.md).

## Mobil

```bash
cd mobile
cp .env.example .env       # EXPO_PUBLIC_API_URL'i LAN IP'nizle güncelleyin
npm install
npx expo start
```

> Harita için `react-native-maps` Android'de Google Maps API anahtarı isteyebilir. Geliştirme/Expo Go ile temel kullanım çalışır; production build öncesi `app.json` içine `ios.config.googleMapsApiKey` / `android.config.googleMaps.apiKey` ekleyin.

> Arka plan GPS ve `react-native-maps` native modüller içerdiğinden, tam özellik için bir **Expo Dev Build** (`npx expo run:android` / `run:ios`) önerilir.

## Testler

```bash
make backend-test         # Go birim testleri
cd mobile && npx tsc --noEmit   # mobil tip kontrolü
```

## Portlar

| Servis | Port |
|--------|------|
| gateway | 8080 |
| auth | 8081 |
| user | 8082 |
| ride | 8083 |
| route | 8084 |
| reward | 8085 |
| telemetry | 8086 |
| postgres | 5432 |
| redis | 6379 |
| nats | 4222 (monitoring 8222) |
