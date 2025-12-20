# Zora Token Sniper - API Problem Analizi

## Proje Özeti

Bu proje, Base blockchain üzerinde yeni oluşturulan Zora ve Clanker tokenlarını gerçek zamanlı tespit eden bir sniper botudur.

### Çalışma Mantığı

1. **Lokal Full Node:** Base L2 reth node çalıştırıyoruz (port 28545 HTTP, 28546 WebSocket)
2. **WebSocket Subscription:** Yeni block eventlerini dinliyoruz
3. **Event Detection:** Zora `CreatorCoinCreated` ve Clanker `TokenCreated` eventlerini yakalıyoruz
4. **Validation:** Creator'ın sosyal medya hesaplarını kontrol ediyoruz
5. **Alert:** 100K+ Twitter takipçisi varsa anında Telegram'a alert gönderiyoruz

### Kullanılan API'ler

| API | Amaç | Endpoint |
|-----|------|----------|
| Zora SDK API | Token creator bilgisi | `https://api-sdk.zora.engineering/coin` |
| Twitter API | Takipçi sayısı | `https://api.twitterapi.io/twitter/user/info` |
| Neynar API | Farcaster profil | `https://api.neynar.com/v2/farcaster/user` |
| DexScreener | Likidite/Fiyat | `https://api.dexscreener.com/token-pairs/v1/base` |

---

## Problem: mycroftnfts Token Kaçırıldı

### Token Detayları
- **Token:** `0xde36e3ef6a0fbadbdf6b3ce5cfbd92045f5b239c`
- **İsim:** mycroftnfts
- **Twitter:** @mycroftnft (100,210 takipçi)
- **Oluşturulma:** 2025-12-19T16:08:55Z
- **Block:** 39685594

### Ne Oldu?

```
[sniper] 🚨 ZORA COIN DETECTED at 2025-12-19T16:08:55.401Z
[sniper] Validating 0xde36e3ef6a0fbadbdf6b3ce5cfbd92045f5b239c from zora...
[sniper] Zora API: no creatorProfile found
[sniper] Creator not indexed yet, retry 1/3 in 1000ms...
[sniper] Creator not indexed yet, retry 2/3 in 2000ms...
[sniper] Creator not indexed yet, retry 3/3 in 4000ms...
[sniper] Creator lookup failed after 3 retries (~15 seconds)
[sniper] ❌ Zora token rejected: creator_not_found_after_retries (7795ms)
```

### Gerçek Sebep

Token oluştuğu sırada Zora API geçici bir outage yaşadı:

```bash
$ curl -s "https://api-sdk.zora.engineering/coin?address=0xde36e3ef...&chain=8453"
no healthy upstream
HTTP: 503
```

Birkaç dakika sonra API düzeldi ve veri mevcut:

```json
{
  "zora20Token": {
    "creatorProfile": {
      "handle": "mycroftnfts",
      "socialAccounts": {
        "twitter": {
          "username": "mycroftnft",
          "followerCount": 100215
        }
      }
    }
  }
}
```

---

## Zora API Kullanımımız

### Mevcut Konfigürasyon

```typescript
// .env.local
ZORA_API_KEY=zora_api_7c92b489c0f7abd3d2d8204783c50f51fed97026cf6db7c8d0d42890ef13fbf0

// sniper.ts
const ZORA_API_BASE = "https://api-sdk.zora.engineering";
const ZORA_API_BASE_FALLBACK = "https://api-sdk.zora.co";
```

### API Request Formatı

```typescript
const url = new URL("/coin", ZORA_API_BASE);
url.searchParams.set("address", tokenAddress);
url.searchParams.set("chain", "8453");

const res = await fetch(url, {
  headers: {
    "api-key": ZORA_API_KEY,
    "Accept": "application/json"
  },
});
```

### Retry Logic

```typescript
// 3 retry, artan delay
// Retry 1: 1000ms bekle
// Retry 2: 2000ms bekle
// Retry 3: 4000ms bekle
// Toplam: ~7-8 saniye
```

---

## Tespit Edilen Sorunlar

### 1. API Intermittent 503 Errors
- Zora API bazen "no healthy upstream" (503) döndürüyor
- Rate limit DEĞİL (429 olurdu)
- Altyapısal bir sorun

### 2. Fallback Endpoint Çalışmıyor
- `api-sdk.zora.co` fallback olarak tanımlı
- Ama bu endpoint de aynı hatayı veriyor (muhtemelen aynı backend)

### 3. Retry Süresi Yetersiz Olabilir
- Toplam ~7-8 saniye retry yapıyoruz
- API outage daha uzun sürebilir

### 4. Token İsmi ≠ Twitter Handle
- Token: "mycroftnfts"
- Twitter: "mycroftnft"
- Zora API olmadan Twitter handle'ı bulamıyoruz

---

## Araştırılması Gereken Konular

### 1. Zora API Rate Limits
- API key ile kaç request/dakika yapabiliyoruz?
- IP bazlı mı, API key bazlı mı limit?
- Dokümantasyon: https://docs.zora.co

### 2. Alternatif Data Kaynakları
- On-chain'den creator bilgisi çekilebilir mi?
- Transaction trace ile creator wallet'ı bulunabilir mi?
- Warpcast/Farcaster'dan direkt wallet bazlı lookup?

### 3. API Key Tier
- Hangi plan/tier'dayız?
- Daha yüksek rate limit için upgrade mümkün mü?

### 4. Caching/Fallback Stratejileri
- API down iken ne yapmalı?
- Token isminden Twitter handle tahmin edilebilir mi?
- Retry süresini artırmalı mıyız?

---

## Test Komutları

```bash
# Zora API test
curl -s "https://api-sdk.zora.engineering/coin?address=TOKEN_ADDRESS&chain=8453" \
  -H "api-key: zora_api_7c92b489c0f7abd3d2d8204783c50f51fed97026cf6db7c8d0d42890ef13fbf0" \
  -H "Accept: application/json"

# Twitter API test
curl -s "https://api.twitterapi.io/twitter/user/info?userName=HANDLE" \
  -H "x-api-key: new1_ac6fde3770a148afae72c382aa29ddfc"

# Neynar API test
curl -s "https://api.neynar.com/v2/farcaster/user/by_username?username=HANDLE" \
  -H "api_key: FB6F84D8-F1AE-4736-B850-5D19EC22E034"
```

---

## Önerilen Çözümler (Araştırma Sonrası)

1. **Daha uzun retry süresi:** 503 hatası için 30 saniyeye kadar retry
2. **Background retry:** İlk seferde bulunamazsa, arka planda periyodik kontrol
3. **Çoklu veri kaynağı:** Zora API yanıt vermezse, on-chain data parse et
4. **Health check:** Zora API durumunu izle, down iken farklı strateji uygula

---

## Sistem Bilgileri

- **Platform:** Linux 5.15.0-161-generic
- **Node:** Base L2 reth (lokal, port 28545/28546)
- **WebSocket:** ws://127.0.0.1:28546
- **Tarih:** 2025-12-19
