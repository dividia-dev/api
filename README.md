# Dividia NVR API Documentation & Demo

Interactive demo pages and API reference documentation for third-party developers integrating with Dividia NVR systems.

## What's This For?

These demo pages help developers learn how to:
- Authenticate with Dividia NVRs
- Retrieve camera lists
- Stream live video (JPEG, MJPEG, WebSocket H.264)
- Search and playback recorded video
- Handle events and timestamps

## Contents

```
dividia-api/
├── nvr-api-demo.html           # Combined demo (live + playback)
├── live-test.html              # Live video streaming demo
├── playback-test.html          # Recorded video playback demo
├── dividia-api-reference.html  # Complete API documentation
├── DEPLOYMENT.md               # Deployment guide
└── README.md                   # This file
```

## Quick Start

### Option 1: Use the Hosted Demo (HTTPS)

Access the demo pages directly:
```
https://dividia.github.io/dividia-api/nvr-api-demo.html
```

**Best for:**
- Remote NVR access (serial.dvr.dividia.net URLs)
- WebSocket H.264 streaming
- No local setup required

### Option 2: Run Locally (HTTP)

For testing with local IP addresses:

```bash
# Clone the repo
git clone https://github.com/dividia-dev/nvr-api-demo.git
cd dividia-api

# Start local HTTP server
python3 -m http.server 8080

# Open in browser
# http://localhost:8080/nvr-api-demo.html
```

**Best for:**
- Testing with local IP addresses (192.168.x.x)
- JPEG and MJPEG streaming
- Development and debugging

### Why Both HTTP and HTTPS?

| Protocol | Use Case | Supported Features |
|----------|----------|-------------------|
| **HTTPS** | Remote access via internet | JPEG, MJPEG, WebSocket H.264 |
| **HTTP** | Local network testing | JPEG, MJPEG |

The pages auto-detect their protocol and configure accordingly.

## Demo Pages

### Combined Demo (`nvr-api-demo.html`)

All-in-one demo with tabbed interface for live streaming and playback.

**Features:**
- Single authentication for both live and playback
- Tab switching between Live Video and Playback
- Three live streaming methods
- Event search and video playback

### Live Video (`live-test.html`)

Standalone demo for live video streaming.

**Streaming Methods:**
- **JPEG Snapshot**: Polls for images at configurable rate (0.5-4 fps)
- **MJPEG Stream**: Continuous motion JPEG stream
- **WebSocket H.264**: Low-latency H.264 with WebCodecs (HTTPS only)

### Playback (`playback-test.html`)

Standalone demo for recorded video.

**Features:**
- Event search by camera and date range
- Thumbnail previews
- HTML5 video playback with controls
- Timestamp overlays

### API Reference (`dividia-api-reference.html`)

Complete API documentation covering:
- Authentication (JSON-RPC)
- Session management
- Camera configuration
- Event retrieval
- Video playback
- Live video streaming
- Timezone handling
- Error handling

## Key Concepts

### Authentication

All API calls require a session token from `auth.loginUser`:

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

### Session Management

- Sessions expire after 2 hours of inactivity
- Use `auth.checkExists` to keep sessions alive
- Video streaming does NOT extend session timeout

### Live Video Streaming

| Method | Bandwidth | Latency | HTTPS Required |
|--------|-----------|---------|----------------|
| JPEG Polling | High | Medium | No |
| MJPEG | Medium | Low | No |
| WebSocket H.264 | Low | Lowest | Yes |

### CORS Requirements

NVRs must have CORS headers configured for cross-origin access:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: POST, GET, OPTIONS
Access-Control-Allow-Headers: Content-Type
```

## API Endpoints Summary

**JSON-RPC API:**
```
POST http(s)://nvr-address/JSON/
```

**Live Video (JPEG/MJPEG):**
```
GET /mpe/cam{N}.jpg?sess={SESSION}&ts={TIMESTAMP}
GET /mpe/cam{N}.mjpg?sess={SESSION}
```

**Live Video (WebSocket H.264):**
```
WS(S) /ws/cam{N}-pro{PROFILE}?sess={SESSION}
```

**Recorded Video:**
```
GET /camstream/?cmd=fetch&session={SESSION}&file={PATH}
```

## Integration Patterns

**Web Browser Applications:**
- Use WebSocket H.264 for best performance (HTTPS required)
- Fallback to MJPEG for broader compatibility

**Native Mobile/Desktop Apps:**
- Use RTSP streams for native H.264 decoding
- Or MJPEG for simple HTTP-based streaming

**Server-Side Applications:**
- Use MJPEG or RTSP
- WebCodecs is browser-only

**Embedded/IoT:**
- Use JPEG polling (simplest, most compatible)

## Browser Compatibility

| Feature | Chrome | Edge | Safari | Firefox |
|---------|--------|------|--------|---------|
| JPEG/MJPEG | Yes | Yes | Yes | Yes |
| WebSocket H.264 | 94+ | 94+ | 16.4+ | No |

## Troubleshooting

**"Failed to fetch" errors:**
- Check NVR CORS headers are configured
- Verify NVR is accessible from browser
- Check browser console for detailed error

**WebSocket H.264 not available:**
- Requires HTTPS (or http://localhost)
- Check browser compatibility (Chrome 94+, Safari 16.4+)
- Verify `window.isSecureContext` returns true

**Video not playing:**
- Check session hasn't expired (2 hour timeout)
- Verify camera is enabled and not in failed state
- Check browser console for errors

## Deployment

See [DEPLOYMENT.md](DEPLOYMENT.md) for instructions on hosting these pages.

## Support

For questions about the Dividia NVR API or to report issues with these demo pages, please contact Dividia support or file an issue on GitHub.

https://github.com/dividia-dev/nvr-api-demo.git

---

**Dividia Corporation**
>>>>>>> b08c2e9 (Add initial source code)
