# Düşük RAM'li Sunucuya Deploy (~2 GB)

Geliştirme `docker-compose.yml`'i her servisi ayrı container'da çalıştırır
(9 Go container + postgres + redis + nats + prometheus + grafana + livekit).
Bu ~2 GB RAM'li bir sunuk için fazla ağırdır.

`docker-compose.prod.yml` bunun yalın (lean) sürümüdür:

| | Dev (`docker-compose.yml`) | Prod (`docker-compose.prod.yml`) |
|---|---|---|
| Go servisleri | 9 ayrı container | tek `app` container (`-service=all`) |
| Redis | var | **yok** (Go kodu kullanmıyor) |
| Prometheus + Grafana | var | **yok** |
| Postgres | varsayılan ayarlar | düşük-RAM tuning |
| Bellek sınırı | yok | her container'da `mem_limit` |
| Açık port | tüm servis portları | yalnız gateway (8080) |
| Voice (LiveKit) | her zaman | opsiyonel (`voice` profili) |

## Neden daha az RAM?

- **Tek Go process:** 9 ayrı Go runtime yerine bir tane. `all` modunda gateway
  diğer servislere `localhost` üzerinden proxy yapar; routing değişmez.
- **Küçük DB pool'u:** Her Postgres backend'i birkaç MB tutar. `DB_MAX_CONNS`
  ile pool başına bağlantı sınırlanır, boşta kalan bağlantılar geri verilir.
- **`GOMEMLIMIT` + `GOGC`:** Go heap'i sınırlanır; GC RSS'i baskılar.
- **Postgres tuning:** `shared_buffers`, `work_mem`, `max_connections` düşük
  tutulur.
- **Monitoring ve Redis çıkarıldı:** Prometheus + Grafana tek başına birkaç yüz
  MB yer; Redis ise Go kodunda hiç kullanılmıyor (LiveKit tek-node'da gerekmez).

## Çalıştırma

```bash
cp .env.example .env          # düzenle: JWT_SECRET, POSTGRES_PASSWORD, LIVEKIT_API_SECRET
# APP_ENV=production yap (prod compose zaten app container'ında set eder)

make prod-up                  # yalın stack (voice'suz)
# veya voice ile:
make prod-up-voice

make prod-ps                  # container durumları
make prod-logs                # logları izle
make prod-down                # durdur
```

Migration'lar Postgres ilk açılışta otomatik uygulanır. Sonradan yeni migration
eklerseniz:

```bash
make prod-migrate
```

## Üretim öncesi kontrol listesi

- `JWT_SECRET` ve `LIVEKIT_API_SECRET` güçlü değerlerle değiştirilmeli
  (`APP_ENV=production` iken varsayılanlarla servis başlamaz).
- `POSTGRES_PASSWORD` değiştirilmeli.
- Mobil için `EXPO_PUBLIC_API_URL` sunucunun public adresine ayarlanmalı.
- Voice kullanılacaksa `LIVEKIT_URL` sunucunun public adresi olmalı
  (`ws://<host>:7880`) ve sıkı NAT arkasındaki mobil ağlar için TURN gerekir —
  bkz. [voice.md](voice.md).
- TLS için gateway'in (8080) önüne bir reverse proxy (Caddy/Nginx) koyun.

## RAM ayarlarını büyütme

Sunucuda daha fazla yer varsa `.env` üzerinden gevşetin:

```bash
GOMEMLIMIT=768MiB
GOGC=75
DB_MAX_CONNS=5
```

`docker-compose.prod.yml` içindeki `mem_limit` değerleri de sunucuya göre
ayarlanabilir.
