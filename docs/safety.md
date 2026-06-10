# Güvenlik: Kaza Algılama ve Acil Durum Protokolü (MVP)

## Algılama (cihaz üzerinde)

- `mobile/src/lib/crashDetection.ts`: ivmeölçer 10 Hz örneklenir; toplam ivme büyüklüğü **4g** eşiğini aşarsa şüpheli kaza sayılır (sürüşte ~1g, kasiste ~2g). Tetik sonrası 60 sn yeniden-tetikleme susturması vardır.
- **Gizlilik tasarımı:** sensör örnekleri yalnız bellekte işlenir, hiçbir yere kaydedilmez/gönderilmez. SOS çerçevesi de **hız içermez** — yalnız sürücüyü bulmaya yetecek konum taşınır.
- Aktiflik: solo sürüşte kayıt sırasında (`MapScreen`), grup sürüşünde oturum boyunca (`GroupRideScreen`).

## 30 sn geri sayım

`CrashCountdown` tam ekran açılır, sürekli titreşir; tek etkileşim **"İYİYİM, İPTAL ET"** butonudur. Süre dolarsa protokol kullanıcı etkileşimi olmadan ilerler.

## Süre dolunca

| Bağlam | Eylem |
|--------|-------|
| Grup sürüşü | WS üzerinden `{"type":"sos", lat, lon}` gönderilir; telemetry servisi bunu kontrol çerçevesi olarak **tüm katılımcılara** yayar. Diğer sürücülerde titreşim + "ACİL DURUM" uyarısı + konuma gitme kısayolu. |
| Her ikisi | Kayıtlı **acil durum kişisi** varsa konum linkli SMS taslağı açılır. (Mobil işletim sistemleri sessiz SMS göndermeye izin vermez; son dokunuş kullanıcıda/çevredekinde kalır.) |
| Solo | Kişi yoksa veya SMS açılamazsa **112'yi arama** seçeneği sunulur. |

## Acil durum kişisi

Profil > Güvenlik > Acil Durum Kişisi. Numara **yalnız cihazda** (AsyncStorage) saklanır, backend'e gönderilmez.

## Sonraki adımlar

- Eşik yerine pencere-tabanlı model (darbe + sonrası hareketsizlik) ve on-device ML (TensorFlow Lite — development build gerektirir).
- Arka plan algılama (ekran kapalıyken) — `expo-task-manager` + development build.
- Otomatik SMS/arama için native modül (Expo managed dışına çıkmayı gerektirir).
