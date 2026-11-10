# Metric Radar

**TR** · KriptoliaTR'nin [Metric](https://metric.xyz) araştırma aracı: havuzlar, işlem akışı, cüzdan pozisyonları ve güvenlik seviyeleri tek ekranda. Türkçe/İngilizce.
**EN** · KriptoliaTR's research tool for [Metric](https://metric.xyz): pools, trade feed, wallet positions and safety tiers from one screen. Turkish/English.

Live: `https://kriptolia.github.io/metric-radar/`

Bağımsız bir topluluk projesidir; Metric ile bağlantısı yoktur. Yatırım tavsiyesi değildir. / Independent community project, not affiliated with Metric. Not financial advice.

---

## Özellikler / Features

| Sekme / Tab | TR | EN |
|---|---|---|
| Genel bakış / Overview | Zincir bazında TVL, hacim (24s/7g/tüm zamanlar), havuz sayısı, güvenlik dağılımı, öne çıkan havuzlar, son 1 saatin "işlem nabzı", TVL/hacim geçmişi | Per-chain TVL, volume (24h/7d/all), pool counts, safety mix, leading pools, last-hour "trade pulse", TVL/volume history |
| Havuzlar / Pools | Filtre (zincir, seviye, TVL, durum, küratör, özel), arama, sıralama (TVL, hacim, 7g APR, Markout APR, Trading PnL APR…), CSV | Filters (chain, tier, TVL, status, curator, private), search, sorting (TVL, volume, 7d APR, markout APR, trading PnL APR…), CSV export |
| Havuz detayı / Pool detail | Seviye ve neden kodları (açıklamalı), ücret paylaşımı, markout tablosu (4 pencere × 3 ufuk), fiyat sağlayıcı, korumalar (StopLoss, Velocity Guard), canlı derinlik defteri, bin dağılımı, havuz geçmişi, X'te paylaş | Tier + reason codes explained, fee split, markout table (4 windows × 3 horizons), price provider, safeguards, live depth ladder, bin distribution, pool history, share on X |
| İşlemler / Trades | Zincir RPC'sinden okunan son swap'lar (1s–24s), hacim/istatistik, havuza göre dağılım, otomatik yenileme | Recent swaps read from chain RPCs (1h–24h), stats, by-pool breakdown, auto-refresh |
| Cüzdan / Wallet | Adres → üç zincirde LP pozisyonları (değer, tutarlar, bin aralığı, aralıkta mı), swap geçmişi ve hacmi, puan paneli (uç nokta açılınca dolacak) | Address → LP positions on three chains (value, amounts, bin range, in-range status), swap history and volume, points panel (fills once the endpoint opens) |
| Rehber / Guide | Metric nedir, LP nasıl kazanır, puan için 3 yol, seviyeler, kontrol listesi | What Metric is, how LPs earn, three ways to position for points, tiers, checklist |

## Nasıl çalışır / How it works

- **Veri / Data:** Metric'in anahtarsız açık API'si (`api.metric.xyz/public/v1`). Tarayıcı canlı API'ye ulaşamazsa (CORS vb.) site `data/latest.json` anlık görüntüsüne düşer ve rozet "Anlık görüntü" olur.
  / Metric's keyless public API. If the browser can't reach it (CORS etc.), the site falls back to the `data/latest.json` snapshot and the badge reads "Snapshot".
- **Zincir verisi / Chain data:** İşlem akışı ve cüzdan sorgusu doğrudan JSON-RPC ile çalışır (`rpc.metric.xyz/{chainId}`, ardından public RPC'ler). `LiquidityAdded/Removed` ve `Swap` olayları okunur; pozisyonlar `MetricOmmPoolDataProvider` üzerinden (`positionBinShares`, `binTotalShares`, `binState`) Multicall3 ile değerlenir.
  / The trade feed and wallet lookup use JSON-RPC directly. `LiquidityAdded/Removed` and `Swap` logs are decoded; positions are valued through `MetricOmmPoolDataProvider` via Multicall3.
- **Geçmiş / History:** `scripts/snapshot.py` GitHub Actions ile saatte bir çalışır, `data/latest.json` ve `data/history.json` dosyalarını günceller (zincir bazında saatlik + günlük, havuz bazında günlük seri).
  / `scripts/snapshot.py` runs hourly on GitHub Actions and rolls `data/latest.json` and `data/history.json`.
- Bağımlılık yok; tek sayfa statik site (HTML/CSS/JS). / No dependencies; a single-page static site.

## Yayınlama / Deploy (GitHub Pages)

1. Repo'yu `kriptolia/metric-radar` olarak oluştur ve bu klasörü `main` dalına push et.
2. **Settings → Pages → Source: Deploy from a branch → `main` / `/ (root)`**.
3. **Settings → Actions → General → Workflow permissions: Read and write** (saatlik anlık görüntü commit'i için).
4. **Actions → snapshot → Run workflow** ile ilk anlık görüntüyü al. Sonrası saat başı otomatik.

EN: create the repo, push to `main`, enable Pages from the `main` branch root, give Actions read/write permission, run the `snapshot` workflow once.

## Ayarlar / Settings

- Sağ üstteki dişli: API adresi ve zincir başına RPC listesi (tarayıcıda saklanır). / The gear icon: API base and per-chain RPC lists (stored in the browser).
- CORS hatası alırsan `proxy/worker.js` dosyasını bir Cloudflare Worker olarak yayınla ve API adresi olarak onu gir. / If you hit a CORS error, deploy `proxy/worker.js` as a Cloudflare Worker and point the API base at it.
- Referans kodu: `assets/data.js` içinde `referralCode` alanı; dolu olursa havuz bağlantıları `?ref=` ile açılır. / Referral code: `referralCode` in `assets/data.js`; when set, pool links carry `?ref=`.
- Dil: tarayıcı diline göre otomatik; `?lang=tr` / `?lang=en` ile zorlanır. / Language follows the browser; force with `?lang=`.

## Geliştirme / Development

```bash
python3 scripts/dev_mock.py 8080        # mock API + mock RPC + static site
open "http://localhost:8080/?api=mock"   # demo wallet: 0x1111111111111111111111111111111111111111
METRIC_API_BASE=http://localhost:8080/public/v1 python3 scripts/snapshot.py   # snapshot against the mock
```

Gerçek API ile: `python3 -m http.server 8080` ve `http://localhost:8080/`. / With the real API: any static server.

## Teşekkür / Credits

- Metric ekibi ve [dokümantasyonu](https://docs.metric.xyz) / the Metric team and docs
- [@0xMoei](https://x.com/0xMoei) — [metricscan](https://metricscan.org) ilhamı / inspiration
- [filipelclima/metric-lp-planner](https://github.com/filipelclima/metric-lp-planner) — pozisyon okuma yöntemi / position-reading method

## Lisans / License

MIT — see `LICENSE`.
