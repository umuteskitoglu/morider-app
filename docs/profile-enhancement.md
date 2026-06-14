# Profil Geliştirme Planı (Instagram-esinli)

## Bağlam ve Amaç

Profil sekmesi şu an temel düzeyde: avatar değişimi, sadece @username düzenleme
(modal), isim/e-posta **salt görünür**, rozetler, liderlik tablosu, gönderi
ızgarası ve hızlı erişim kutucukları (Sürüşlerim/Rotalarım/Takip). Hedef: profili
**tam düzenlenebilir** ve Instagram benzeri yönetilebilir hale getirmek —
isim/kullanıcı adı/bio düzenleme, gönderileri **arşivleme/silme**, takipçi
sayıları vb.

Referans: Instagram profil ekranı (üst bilgi + istatistikler + "Profili Düzenle"
+ ızgara + arşiv).

---

## Mevcut Durum (kod tabanı)

**Backend**
- `users`: `id, name, email, password_hash, country, avatar_url, username,
  created_at, updated_at`. **Yok:** `bio`, gizlilik, isim/soyisim ayrımı.
- `PUT /api/users/:id` (`internal/user/user.go`): `name, username, country,
  avatar_url` günceller ama `COALESCE(NULLIF($, ''), ...)` kullandığından
  **boş değere set edilemiyor** (alan temizlenemez). E-posta düzenlenemez.
- `posts` (`0005_posts.sql`): `id, user_id, caption, location_name, lat, lon,
  created_at` + `post_photos`. **Yok:** arşiv bayrağı, **gönderi silme**,
  caption düzenleme uçları. `feed.go`'da `list/userPosts/mine/create/like/
  comments` var; silme/arşiv yok. `respondPosts` ortak sorgu `extraWhere` ile
  filtreliyor.

**Mobil**
- `ProfileScreen.tsx`: avatar, @username modal düzenleme, isim/e-posta metin,
  rozet sergileme, liderlik, gönderi ızgarası, hızlı kutucuklar. Bio yok,
  istatistik (gönderi/takipçi/takip) yok, gönderi yönetimi yok, arşiv yok.
- `store/auth.tsx` `User`: `id, name, username, email, country, avatar_url`.
- `UserProfileScreen.tsx`: başkalarının profili (takip et/listele); bio yok.

---

## Hedef Özellikler

1. **Profili Düzenle** ekranı (tek yerden): avatar, görünen ad, @username, bio,
   ülke. (E-posta: Faz 2 — hassas/benzersiz.)
2. **Bio** alanı (profilde ve başkalarının profilinde görünür).
3. **İstatistik satırı:** gönderi · takipçi · takip (dokununca ilgili liste).
4. **Gönderi yönetimi:** her gönderi için **Arşivle / Arşivden çıkar / Sil**
   (+ opsiyonel caption düzenle).
5. **Arşiv görünümü:** arşivlenen gönderiler ızgaradan ve akıştan gizli; ayrı
   "Arşiv" ekranından görülüp geri alınabilir.

---

## Backend Değişiklikleri

### Migration `0018_profile_enhance.sql` (yeni)
```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_posts_user_active
  ON posts(user_id, created_at DESC) WHERE archived_at IS NULL;
```
*(Karar: tek **görünen ad** — mevcut `name` düzenlenebilir olur, isim/soyisim
ayrımı yok.)*

### `internal/user/user.go`
- `profile` struct + `get`: `bio` döndür. Ayrıca **sayıları** ekle:
  `post_count` (arşivsiz), `follower_count`, `following_count` (alt sorgularla).
- `update`: **kısmi/temizlenebilir** güncellemeye geçir. `updateReq` alanlarını
  pointer (`*string`) yap; yalnızca gönderilen alanları güncelle, `bio`/`country`
  boş gönderilince **temizlenebilsin**. `username` validasyonu + 23505 (taken)
  korunur.

### `internal/feed/feed.go`
- `respondPosts` ana sorgusuna `p.archived_at IS NULL` ekle (akış ve profil
  ızgarası arşivlileri göstermesin). Arşiv görünümü için ayrı sorgu/uç.
- Yeni uçlar (sahip-yalnız; `posts.user_id == auth`):
  - `DELETE /api/posts/:id` → gönderiyi sil (foto dosyaları + satır).
  - `POST   /api/posts/:id/archive` → `archived_at = now()`.
  - `POST   /api/posts/:id/unarchive` → `archived_at = NULL`.
  - `GET    /api/posts/mine?archived=true` (veya `/api/posts/archived`) →
    arşivlenenler.
  - *(Opsiyonel)* `PATCH /api/posts/:id` → caption güncelle.
- Dosya silmede `UploadDir` içindeki medya dosyalarını da kaldır (best-effort).

---

## Mobil Değişiklikler

### Yeni: `EditProfileScreen.tsx`
- Form: avatar (mevcut `pickAvatar` mantığı taşınır), görünen ad, @username
  (benzersizlik hatası 409), bio (çok satır), ülke.
- Kaydet → `PUT /api/users/:id` + `useAuth().updateUser(...)`.
- `ProfileStackParams`'a `EditProfile` eklenir; ProfileScreen başlığında
  "Profili Düzenle" butonu/satırı.

### `ProfileScreen.tsx`
- Üst bilgi: avatar + ad + @username + **bio** + **istatistik satırı**
  (Gönderi / Takipçi / Takip — dokununca Follows/grid).
- "Profili Düzenle" girişi (username modalı yerini buna bırakır).
- Gönderi ızgarası: gönderiye dokun → detay; **uzun bas / menü** →
  Arşivle / Sil (+ caption düzenle). Silme/arşiv sonrası ızgara güncellenir.
- Başlıkta **Arşiv** ikonu → `ArchivedPostsScreen`.

### Yeni: `ArchivedPostsScreen.tsx`
- Arşivlenen gönderi ızgarası; her birinde "Geri al" (unarchive) ve "Sil".

### Diğer
- `store/auth.tsx` `User` tipine `bio` (+ istenirse first/last) ekle.
- `UserProfileScreen.tsx`: bio + istatistikleri göster (düzenleme yok).
- `PostDetail`/`LikersSheet` bileşenleri sahip için işlem menüsü gösterebilir.

---

## Fazlama

- **Faz 1 (çekirdek):** migration 0018; `users.update` kısmi+bio; profil
  istatistikleri; EditProfileScreen; bio gösterimi.
- **Faz 2 (gönderi yönetimi):** archive/unarchive/delete uçları + feed filtre;
  ProfileScreen gönderi menüsü; ArchivedPostsScreen.
- **Faz 3 (Instagram ekstraları, sonraya):** kaydedilenler (bookmarks), gizli
  hesap, öne çıkanlar (highlights), caption düzenleme. (Dördü de istendi;
  e-posta değiştirme bu fazda.)

---

## Doğrulama
- Backend: `go build ./... && go test ./...`; migration'ı çalışan DB'ye uygula.
- API akışı (gateway:8080): profil güncelle (bio temizleme dahil), gönderi
  arşivle → `mine`/`feed`'de görünmez → `archived`'da görünür → unarchive →
  geri döner; sil → kalkar. İstatistik sayıları doğrula.
- Mobil: EditProfile ile alanları değiştir, ızgaradan arşivle/sil, Arşiv
  ekranından geri al.

---

## Kararlar (netleşti)
1. **İsim:** Tek **görünen ad** (`name` düzenlenebilir); isim/soyisim ayrımı yok.
2. **E-posta:** Faz 1 kapsamında **değil** — salt görünür; Faz 3'te değiştirme.
3. **Silme:** **Arşiv** (yumuşak gizleme, geri alınır) **+ kalıcı sil** (medya
   dosyalarıyla birlikte). İkisi de var.
4. **Faz 3 (sonraya):** kaydedilenler, gizli hesap, öne çıkanlar, caption
   düzenleme — dördü de yapılacak.
