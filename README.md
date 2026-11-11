# Metric Radar

**TR** · KriptoliaTR'nin [Metric](https://metric.xyz) araştırma aracı: havuzlar, işlem akışı, cüzdan pozisyonları ve güvenlik seviyeleri tek ekranda. Türkçe/İngilizce.
**EN** · KriptoliaTR's research tool for [Metric](https://metric.xyz): pools, trade feed, wallet positions and safety tiers from one screen. Turkish/English.

Live: `https://kriptolia.github.io/metric-radar/`

Bağımsız bir topluluk projesidir; Metric ile bağlantısı yoktur. Yatırım tavsiyesi değildir. / Independent community project, not affiliated with Metric. Not financial advice.

---

## Özellikler / Features

| Sekme / Tab | TR | EN |
|---|---|---|
| Genel bakış / Overview | Zincir bazında TVL, hacim, fonlu havuz sayısı, güvenlik dağılımı, öne çıkan havuzlar, son 15 dakikanın "işlem nabzı", TVL/hacim geçmişi | Per-chain TVL, volume, funded-pool counts, safety mix, leading pools, a 15-minute "trade pulse", TVL/volume history |
| Havuzlar / Pools | Filtre (zincir, seviye, TVL, durum, küratör, özel, boş), arama, sıralama (TVL, hacim, 7g APR, Markout APR, Trading PnL APR…), CSV | Filters (chain, tier, TVL, status, curator, private, empty), search, sorting, CSV export |
| Havuz detayı / Pool detail | Seviye ve neden kodları, ücret paylaşımı, markout tablosu (4 pencere × 3 ufuk), fiyat sağlayıcı, korumalar (StopLoss, Velocity Guard), canlı derinlik defteri, bin dağılımı, TVL ve hacim geçmişi, X'te paylaş | Tier + reason codes, fee split, markout table, price provider, safeguards, live depth ladder, bin distribution, TVL and volume history, share on X |
| İşlemler / Trades | Üç zincirde son swap'lar (15 dk / 1 sa / 3 sa), hacim ve istatistik, havuza göre dağılım, otomatik yenileme | Recent swaps on three chains (15 min / 1 h / 3 h), stats, by-pool breakdown, auto-refresh |
| Cüzdan / Wallet | Adres → üç zincirde açık LP pozisyonları: değer, tutarlar, bin aralığı, aralıkta mı, kazanılan ücret, ücret APR, Trading PnL, döneme göre performans. Ayrıca Ethereum ve Robinhood'da adresin tüm Metric swap'ları ve hacmi | Address → open LP positions on three chains: value, amounts, bin range, in-range status, fees earned, fee APR, trading PnL, performance by period. Plus every Metric swap and its volume on Ethereum and Robinhood |
| Rehber / Guide | Metric nedir, LP nasıl kazanır, puan için 3 yol, seviyeler, kontrol listesi | What Metric is, how LPs earn, three ways to position for points, tiers, checklist |

## Nasıl çalışır / How it works

Bağımlılık yok; tek sayfa statik site (HTML/CSS/JS). Dört veri kaynağı var: / No dependencies; a single-page static site with four data sources:

1. **Saatlik anlık görüntü / Hourly snapshot.** `scripts/snapshot.py`, GitHub Actions ile saatte bir Metric'in açık API'sinden tüm havuzları çeker ve `latest.json` + `history.json` dosyalarını bu repo'nun `data` dalına yazar (dal her seferinde tek commit olarak yenilenir; repo büyümez, `main` yalnızca kod içerir). Sayfa önce bunu çizer.
   / Hourly, `scripts/snapshot.py` pulls every pool from Metric's public API and publishes `latest.json` + `history.json` to this repo's `data` branch (one commit, replaced each run: the repo doesn't grow and `main` stays code-only). The page paints from it first.
2. **Metric açık API'si / Metric public API** (`api.metric.xyz/public/v1`, anahtarsız / keyless). Fonlu havuzların güncel değerleri, derinlik, bin analizi, cüzdan pozisyonları (`/evm/{chain}/positions/{adres}`) ve yedek olarak havuz aktivitesi. API'ye ulaşılamazsa rozet "Anlık görüntü" olur.
   / Current values of funded pools, depth, bin analytics, wallet positions and, as a fallback, pool activity. If it is unreachable the badge reads "Snapshot".
3. **Zincir RPC'leri / Chain RPCs.** İşlem akışı `Swap` olaylarını doğrudan zincirden okur. Uç noktalar ve ölçülen sınırları `assets/data.js` içinde: Ethereum → MEV Blocker, PublicNode; BNB Chain → PublicNode (istek başına 10 adres); Robinhood Chain → resmî RPC. Hiçbiri yanıt vermezse en aktif havuzlar Metric API'sinden gösterilir.
   / The trade feed reads `Swap` events from the chain. Endpoints and their measured limits live in `assets/data.js`. If none answers, the busiest pools are shown from Metric's API.
4. **Blok explorer'ları / Block explorers** (Blockscout: Ethereum, Robinhood Chain). Yalnızca cüzdanın swap geçmişi için: adresin gönderdiği işlemlerin listesi explorer'dan alınır, her işlemin `Swap` olayları zincirden okunur. Havuzun `Swap` olayı cüzdanı değil router'ı gösterdiği için olay araması tek başına yetmez. BNB Chain için anahtarsız bir işlem listesi kaynağı yok.
   / Only for a wallet's swap history: the list of transactions the address sent comes from the explorer, and each transaction's `Swap` events are read from the chain. A pool's `Swap` event names the router, not the wallet, so searching events alone is not enough. BNB Chain has no keyless source for an address's transactions.

## Yayınlama / Deploy (GitHub Pages)

1. Repo'yu `main` dalına push et. / Push the repo to `main`.
2. **Settings → Pages → Source: Deploy from a branch → `main` / `/ (root)`**.
3. `snapshot` iş akışı push ile kendiliğinden çalışır ve `data` dalını oluşturur; sonrası saat başı otomatik. Elle çalıştırmak için: **Actions → snapshot → Run workflow**. Ek izin ya da gizli anahtar gerekmez.
   / The `snapshot` workflow runs on push and creates the `data` branch; after that it runs hourly. No extra permissions or secrets.

Fork'larda sayfa kendi `data` dalını okur (`<kullanıcı>.github.io/<repo>` adresinden türetilir). GitHub, 60 gün hareketsiz kalan herkese açık repo'larda zamanlanmış iş akışlarını durdurur; durursa Actions sekmesinden yeniden etkinleştir.
/ Forks read their own `data` branch. GitHub pauses scheduled workflows in public repos after 60 days without activity; re-enable it from the Actions tab if that happens.

## Ayarlar / Settings

- Sağ üstteki dişli: API adresi ve işlem akışı için ek RPC adresleri (tarayıcıda saklanır). / The gear icon: API base and extra RPC endpoints for the trade feed (stored in the browser).
- Metric API'sine kendi proxy'n üzerinden gitmek istersen `proxy/worker.js` dosyasını bir Cloudflare Worker olarak yayınla ve API adresi olarak onu gir. / To reach Metric's API through your own proxy, deploy `proxy/worker.js` as a Cloudflare Worker and enter it as the API base.
- Referans kodu: `assets/data.js` içinde `referralCode`; dolu olursa havuz bağlantıları `?ref=` ile açılır. / Referral code: `referralCode` in `assets/data.js`; when set, pool links carry `?ref=`.
- Dil: tarayıcı diline göre otomatik; `?lang=tr` / `?lang=en` ile zorlanır. / Language follows the browser; force with `?lang=`.
- Yeni sürüm yayınlarken `index.html` içindeki `?v=` değerini artır. / Bump the `?v=` value in `index.html` with each release.

## Geliştirme / Development

```bash
python3 scripts/dev_mock.py 8080         # mock API + mock RPC + mock explorer + static site
open "http://localhost:8080/?api=mock"    # demo wallet: 0x1111111111111111111111111111111111111111
open "http://localhost:8080/?api=mock&down=rpc"   # failure drills: rpc, explorer, api, positions
METRIC_API_BASE=http://localhost:8080/public/v1 python3 scripts/snapshot.py   # snapshot against the mock → data/
```

Gerçek servislerle: `python3 -m http.server 8080` ve `http://localhost:8080/`. `?data=local`, anlık görüntüyü `data/` klasöründen okur. / With the real services: any static server. `?data=local` reads the snapshot from `data/`.

## Teşekkür / Credits

- Metric ekibi ve [dokümantasyonu](https://docs.metric.xyz) / the Metric team and docs
- [@0xMoei](https://x.com/0xMoei) — [metricscan](https://metricscan.org) ilhamı / inspiration
- [filipelclima/metric-lp-planner](https://github.com/filipelclima/metric-lp-planner) — havuz olaylarını okuma yöntemi / method for reading pool events

## Lisans / License

MIT — see `LICENSE`.
