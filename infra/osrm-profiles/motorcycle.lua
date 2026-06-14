-- Morider — motosiklete özel OSRM profili.
--
-- Hazır "car" profilini taban alır ve motorcular için ayarlar: otoyol/trunk
-- yollarını caydırır, ikincil/üçüncül (kıvrımlı, manzaralı) yolları öne
-- çıkarır, motosiklete yasak yolları (motorcycle=no) dışlar ve bozuk zemini
-- biraz daha cezalandırır. Sadece kendi OSRM sunucunuzda kullanılır
-- (router.project-osrm.org yalnız "driving" profili sunar).
--
-- Kullanım (Makefile):
--   make osrm-data OSRM_PROFILE=motorcycle
--   make osrm-up
--
-- NOT: Hız tablosunu ölçeklediğimiz için tahmini varış süresi de buna göre
-- değişir; amaç "en hızlı" değil "en keyifli" rotadır. Çarpanlar deneme
-- gerektirir — gerçek rotalarla test edip dengeyi kendinize göre ayarlayın.

-- Taban "car" profili ve lib modülleri imajın içinde /opt altında durur.
package.path = '/opt/?.lua;' .. package.path
local car = assert(loadfile('/opt/car.lua'))()

-- Yol tipi başına hız çarpanı (1.0 = değişiklik yok). <1 caydırır, >1 öne çıkarır.
-- weight_name = 'routability' süreyi temel aldığından, hızı düşürmek o yolu
-- "pahalı" yapıp rota motorunun ondan kaçınmasını sağlar.
local highway_factor = {
  motorway       = 0.55,
  motorway_link  = 0.55,
  trunk          = 0.70,
  trunk_link     = 0.70,
  primary        = 0.90,
  primary_link   = 0.90,
  secondary      = 1.05,
  secondary_link = 1.05,
  tertiary       = 1.25,
  tertiary_link  = 1.25,
  unclassified   = 1.25,
  residential    = 1.00,
}

-- Asfaltsız/bozuk zeminleri ek olarak caydır (kıvrımlı asfalt isteriz, arazi değil).
local surface_factor = 0.6
local penalized_surfaces = { gravel = true, ground = true, dirt = true, earth = true, mud = true, sand = true }

-- scale, bir tablodaki sayısal alanı çarpanla ölçekler; alan yoksa/nil ise
-- dokunmaz (OSRM sürümü taban tabloyu değiştirse bile profil patlamaz).
local function scale(tbl, key, factor)
  if tbl and type(tbl[key]) == 'number' then
    tbl[key] = tbl[key] * factor
  end
end

local base_setup = car.setup

function car.setup()
  local profile = base_setup()

  -- Motosiklete özgü erişim etiketlerini en yüksek önceliğe al; böylece
  -- motorcycle=no olan yol dışlanır, motorcycle=yes olan yol açılır.
  if profile.access_tags_hierarchy then
    table.insert(profile.access_tags_hierarchy, 1, 'motorcycle')
  end

  -- Yol tipi hızlarını ölçekle (manzaralı yolları öne çıkar, otoyolu caydır).
  local speeds = profile.speeds and profile.speeds.highway
  if speeds then
    for key, factor in pairs(highway_factor) do
      scale(speeds, key, factor)
    end
  end

  -- Bozuk zemin hızlarını düşür.
  if profile.surface_speeds then
    for surface in pairs(penalized_surfaces) do
      scale(profile.surface_speeds, surface, surface_factor)
    end
  end

  return profile
end

return car
