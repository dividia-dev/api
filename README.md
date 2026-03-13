# Dividia API Documentation & Demo

Interactive demo pages and API reference documentation for third-party developers integrating with Dividia video systems.

## Overview

This repository contains demo pages and documentation for two Dividia platforms:

| Platform | Description | Authentication | Demo Page |
|----------|-------------|----------------|-----------|
| **NVR** | Direct connection to on-premise NVR devices | JSON-RPC session token | `nvr-demo.html` |
| **Cloud** | Cloud-connected cameras via Dividia Cloud API | JWT Bearer token | `cloud-api-demo.html` |

Both platforms support live video streaming via WebSocket H.264 using the shared `WSPlayer.js` library.

## Contents

```
api/
├── NVR Demo Files
│   ├── nvr-demo.html           # Combined live + playback demo
│   └── api-reference.html      # NVR API documentation
│
├── Cloud Demo Files
│   ├── cloud-api-demo.html     # Cloud live streaming demo
│   ├── cloud-api-reference.html # Cloud API documentation
│   └── dev-server.js           # Development server with CORS proxy
│
├── Shared
│   └── WSPlayer.js             # WebSocket H.264 video player component
│
├── DEPLOYMENT.md               # Deployment guide
└── README.md                   # This file
```

---

## NVR Integration

Direct connection to Dividia NVR devices on local network or via remote access (serial.dvr.dividia.net).

### Quick Start (NVR)

**Option 1: Hosted Demo (HTTPS)**
```
https://dividia-dev.github.io/api/nvr-demo.html
```
Best for remote NVR access and WebSocket H.264 streaming.

**Option 2: Run Locally (HTTP)**
```bash
# Start local server
python3 -m http.server 8080
# or: npx serve -p 8080

# Open http://localhost:8080/nvr-demo.html
```
Best for local network testing with IP addresses (192.168.x.x).

### NVR Demo Pages

| Page | Description |
|------|-------------|
| `nvr-demo.html` | Combined live + playback demo with tabbed interface |
| `api-reference.html` | Complete NVR API documentation |

### NVR Streaming Methods

| Method | Bandwidth | Latency | HTTPS Required |
|--------|-----------|---------|----------------|
| JPEG Polling | High | Medium | No |
| MJPEG Stream | Medium | Low | No |
| WebSocket H.264 | Low | Lowest | Yes* |

*WebSocket H.264 works on `http://localhost` for development.

### NVR Authentication

NVR uses JSON-RPC with session tokens:

```javascript
// POST to /JSON/
{
  "jsonrpc": "2.0",
  "method": "auth.loginUser",
  "params": ["username", "password", true, false],
  "id": 1
}

// Response
{
  "result": [true, "session_token_here"],
  "id": 1
}
```

### NVR API Endpoints

```
POST /JSON/                                    # JSON-RPC API
GET  /mpe/cam{N}.jpg?sess={SESSION}           # JPEG snapshot
GET  /mpe/cam{N}.mjpg?sess={SESSION}          # MJPEG stream
WS   /ws/cam{N}-pro{PROFILE}?sess={SESSION}   # WebSocket H.264
GET  /camstream/?cmd=fetch&session=...        # Recorded video
```

### NVR CORS Requirements

NVRs must have CORS headers configured for cross-origin access:
```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: POST, GET, OPTIONS
Access-Control-Allow-Headers: Content-Type
```

---

## Cloud Integration

Connection to cloud-connected cameras via Dividia Cloud API.

### Quick Start (Cloud)

**Option 1: Development Server (Recommended)**
```bash
# Start dev server with CORS proxy
node dev-server.js

# Open http://localhost:3000/cloud-api-demo.html
```
The dev server proxies API requests to bypass CORS restrictions during development.

**Option 2: Direct Access**

For production deployments, access the Cloud API directly at:
```
https://api.cloud.dividia.net
```

### Cloud Demo Pages

| Page | Description |
|------|-------------|
| `cloud-api-demo.html` | Cloud live streaming demo |
| `cloud-api-reference.html` | Complete Cloud API documentation |
| `dev-server.js` | Development server with CORS proxy |

### Cloud Streaming

Cloud currently supports WebSocket H.264 streaming only:

| Method | Bandwidth | Latency | Notes |
|--------|-----------|---------|-------|
| WebSocket H.264 | Low | Lowest | HTTPS required, uses WSPlayer.js |

### Cloud Authentication

Cloud uses REST API with JWT Bearer tokens:

```javascript
// POST to /ve/auth
{
  "username": "user@example.com",
  "password": "password"
}

// Response
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "devices": [
    { "sDeviceID": "0A58A9FEAC02", "sName": "Front Lobby", "fOnline": 1 }
  ],
  "cameras": [
    { "sDeviceID": "0A58A9FEAC02", "bCamera": 1, "bProfile": 2, "sName": "Door", "fEnabled": 1, "fOnline": 1 }
  ]
}

// Use token in subsequent requests
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

### Cloud API Endpoints

```
Base URL: https://api.cloud.dividia.net

POST /ve/auth                     # Authenticate, get JWT token + devices/cameras
WS   /{deviceID}-cam{N}-pro{P}    # WebSocket H.264 stream
```

### Cloud WebSocket URL Format

```
wss://api.cloud.dividia.net/{deviceID}-cam{N}-pro{P}

Example:
wss://api.cloud.dividia.net/0A58A9FEAC02-cam1-pro1
```

| Component | Description |
|-----------|-------------|
| `deviceID` | Device serial ID from `/ve/auth` response |
| `cam{N}` | Camera number (1-16) |
| `pro{P}` | Profile: 1 (full res) or 2 (lower res) |

---

## WSPlayer.js - Shared Video Player

Both NVR and Cloud demos use `WSPlayer.js` for WebSocket H.264 streaming. It's a self-contained component that generates all HTML (canvas, overlays, loading spinner) inside a container element.

### Basic Usage

```html
<script src="WSPlayer.js"></script>
<div id="camera-1" style="width: 640px; height: 480px;"></div>

<script>
const player = WSPlayer.create('camera-1', {
    // For NVR: use host/port/session
    camera: [1, 'Front Door'],
    host: '256.dvr.dividia.net',
    port: 443,
    profile: 1,
    session: 'your-session-token',
    secure: true,

    // OR for Cloud: use direct URL
    // url: 'wss://api.cloud.dividia.net/0A58A9FEAC02-cam1-pro1',

    // Callbacks
    onConnect: () => console.log('Connected'),
    onFirstFrame: () => console.log('Video started'),
    onError: (err) => console.error('Error:', err),
    onDisconnect: () => console.log('Disconnected')
});

// Control methods
player.stop();      // Stop streaming
player.start();     // Start streaming
player.restart();   // Restart streaming
```

### WSPlayer Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `url` | string | - | Full WebSocket URL (Cloud) |
| `host` | string | - | NVR hostname (NVR) |
| `port` | number | 443/80 | NVR port (NVR) |
| `session` | string | - | Session token (NVR) |
| `camera` | array | - | Camera info as `[id, name]` |
| `profile` | number | 1 | Stream profile (1=full, 2=lower) |
| `secure` | boolean | auto | Use wss:// |
| `noOverlay` | bool/array | - | Hide overlays: `true` or `['cam_name', 'fps', 'ts']` |
| `autoReconnect` | boolean | true | Auto-reconnect on disconnect |
| `reconnectDelay` | number | 5000 | Reconnect delay in ms |
| `stallTimeout` | number | 5000 | Stall detection timeout in ms |
| `debug` | boolean | false | Enable debug logging |

### WSPlayer Callbacks

| Callback | Description |
|----------|-------------|
| `onConnect` | WebSocket connected |
| `onFirstFrame` | First video frame displayed |
| `onError` | Connection or decode error |
| `onDisconnect` | Connection closed |
| `onReconnecting` | Auto-reconnect started |
| `onStall` | No data received (stalled) |
| `onMetadata` | Server metadata received |

### Browser Support Check

```javascript
const support = WSPlayer.checkSupport();
if (!support.supported) {
    console.error(support.reason);
    // Fall back to MJPEG (NVR only)
}
```

---

## Browser Compatibility

| Feature | Chrome | Edge | Safari | Firefox |
|---------|--------|------|--------|---------|
| JPEG/MJPEG (NVR) | Yes | Yes | Yes | Yes |
| WebSocket H.264 | 94+ | 94+ | 16.4+ | No |

**WebSocket H.264 Requirements:**
- Secure context (HTTPS or `http://localhost`)
- WebCodecs API support
- Modern browser (see table above)

---

## Platform Comparison

| Feature | NVR | Cloud |
|---------|-----|-------|
| Authentication | JSON-RPC session | JWT Bearer token |
| Live Streaming | JPEG, MJPEG, WebSocket | WebSocket only |
| Recorded Playback | Yes | Coming soon |
| CORS Proxy Needed | No (configure NVR) | Yes (dev) / No (prod) |
| API Style | JSON-RPC | REST |

---

## Troubleshooting

### Common Issues (Both Platforms)

**WebSocket H.264 not working:**
- Requires HTTPS (or `http://localhost`)
- Check browser supports WebCodecs (Chrome 94+, Safari 16.4+)
- Verify `window.isSecureContext` returns true

**Video not playing:**
- Check session/token hasn't expired
- Verify camera is enabled and online
- Check browser console for errors

### NVR-Specific Issues

**"Failed to fetch" errors:**
- Check NVR CORS headers are configured
- Verify NVR is accessible from browser

**Mixed content errors:**
- HTTPS pages cannot access HTTP NVRs directly
- Use HTTP version for local network access

### Cloud-Specific Issues

**CORS errors during development:**
- Use `dev-server.js` to proxy requests
- Run: `node dev-server.js`

**401 Unauthorized:**
- JWT token expired, re-authenticate via `/ve/auth`

---

## Deployment

See [DEPLOYMENT.md](DEPLOYMENT.md) for hosting instructions.

---

## Support

For questions or issues:
- GitHub: https://github.com/dividia-dev/api
- Contact Dividia support

---

**Dividia Corporation**
