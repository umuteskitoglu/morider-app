# Gözlemlenebilirlik (Observability)

Proje takibi iki hazır araçla yapılır; **backend tarafında ek kod gerekmez**.

## Bileşenler

| Araç | Port | Görev |
|------|------|-------|
| **Prometheus** | `:9090` | Her servisin `/metrics` ucundan istek sayısı, gecikme, hata, bellek metriklerini toplar. |
| **Grafana** | `:3000` | Prometheus + Postgres üzerine dashboard'lar. Datasource ve dashboard'lar otomatik provision edilir. |

Metrikler her serviste ortak `pkg/metrics` (Gin middleware) ile üretilir; Prometheus hedefleri [`infra/prometheus.yml`](../infra/prometheus.yml)'de tanımlıdır.

## Başlatma

```bash
docker compose up -d            # tüm yığın (Grafana dahil)
# veya sadece izleme katmanı:
docker compose up -d postgres prometheus grafana
```

Grafana: <http://localhost:3000> — varsayılan giriş `admin / admin`
(`.env` içinde `GRAFANA_ADMIN_USER` / `GRAFANA_ADMIN_PASSWORD` ile değiştirilebilir).

## Dashboard'lar

`Morider` klasörü altında otomatik gelir:

- **Servis Performansı** (Prometheus) — istek hızı (req/s), 5xx hata oranı, p95/p99 gecikme, en çok çağrılan endpoint'ler, servis başına bellek. Servis filtresi mevcut.
- **Kullanıcı Aktivitesi** (Postgres) — toplam kullanıcı/sürüş/paylaşım/takip, günlük yeni kayıt/sürüş/paylaşım grafikleri, en aktif kullanıcılar tablosu ve "kim ne yaptı" son aktivite akışı (sürüş / paylaşım / takip / rozet).

Provisioning dosyaları [`infra/grafana/`](../infra/grafana/) altındadır; dashboard JSON'larını düzenleyip kaydetmek yeterlidir (30 sn'de bir yeniden okunur).

## Notlar

- Prometheus metrikleri **bilinçli olarak kullanıcı bazında değildir** (route şablonuyla etiketlenir, kardinalite patlamasını önlemek için). "Hangi kullanıcı ne yaptı" sorusu Postgres dashboard'undan, mevcut tablolardan yanıtlanır.
- İleride tam-metin log araması istenirse Loki + Grafana eklenebilir; bu, loglara `user_id` alanı eklemek için küçük bir backend dokunuşu gerektirir (henüz dahil değil).
