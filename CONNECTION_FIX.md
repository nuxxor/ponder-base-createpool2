# Bağlantı Kopması Çözümleri

## Sorun
- VSCode local PC (Almanya) → Hetzner server SSH bağlantısı kopuyor
- Sniper bot → Geth WebSocket bağlantısı arada kopuyor

## Uygulanan Çözümler

### 1. SSH KeepAlive (Sunucu Tarafı) ✅
Dosya: `~/.ssh/config`
```bash
Host *
    ServerAliveInterval 60      # Her 60 saniyede keepalive gönder
    ServerAliveCountMax 3        # 3 başarısız deneme sonrası kes
    TCPKeepAlive yes
```

### 2. Local PC Tarafı (Senin Bilgisayarın)

#### Windows VSCode Settings
`%USERPROFILE%\.ssh\config` dosyasına ekle:
```
Host hetzner
    HostName 188.40.25.155  # Hetzner IP'ni buraya yaz
    User base
    ServerAliveInterval 30
    ServerAliveCountMax 5
    TCPKeepAlive yes
```

#### VSCode Settings.json
`Ctrl+Shift+P` → "Preferences: Open User Settings (JSON)"
```json
{
  "remote.SSH.connectTimeout": 60,
  "remote.SSH.keepAlive": true,
  "remote.SSH.serverAliveInterval": 30,
  "remote.SSH.serverAliveCountMax": 5
}
```

### 3. WebSocket Reconnection İyileştirmesi

Sniper bot zaten auto-reconnect yapıyor:
```typescript
transport: webSocket(WS_RPC_URL, {
  reconnect: true,      // Otomatik yeniden bağlan
  retryCount: 10,       // 10 deneme
  retryDelay: 1000,     // 1 saniye bekle
})
```

### 4. Geth WebSocket Timeout Artırma

Docker container'ını yeniden başlat (opsiyonel):
```bash
docker stop geth
docker start geth
```

Veya docker-compose.yml'de timeout ayarlarını arttır:
```yaml
command:
  - --ws.origins=*
  - --ws.api=eth,net,web3
  - --ws.rpcprefix=/
  - --http.timeout.read=300
  - --http.timeout.write=300
```

## Test Etmek İçin

### SSH Bağlantısını Test Et
```bash
# Local PC'den (cmd/PowerShell)
ssh -v hetzner
# "ServerAliveInterval 30" mesajını görmeli
```

### Sniper Bağlantısını İzle
```bash
# Hetzner server'da
npm run sniper

# Log'larda görmelisin:
# [sniper] ♥️ Heartbeat - Block: ... - 60 saniyede bir
```

### Bağlantı Durumunu Kontrol Et
```bash
# SSH bağlantılarını gör
ss -tn | grep :22

# WebSocket bağlantılarını gör
ss -tn | grep :28546
```

## Hala Koparsa

1. **SSH Session timeout uzat** - Hetzner server `/etc/ssh/sshd_config`:
   ```
   ClientAliveInterval 60
   ClientAliveCountMax 3
   ```
   Sonra: `sudo systemctl restart sshd`

2. **VSCode Remote SSH uzantısını güncelle**
   - VSCode Extensions → Remote - SSH → Update

3. **Geth restart interval ekle** (auto-heal için):
   ```bash
   # Crontab ekle
   */30 * * * * docker restart geth 2>&1 | logger -t geth-restart
   ```

## Monitoring

Bağlantı sağlığını izle:
```bash
# Sürekli SSH bağlantı durumu
watch -n 5 'ss -tn | grep :22 | wc -l'

# Sürekli WebSocket bağlantı durumu
watch -n 5 'ss -tn | grep :28546'
```
