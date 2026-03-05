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
api/
├── nvr-demo.html           # Combined demo (live + playback)
├── WSPlayer.js             # Reusable WebSocket H.264/H.265 video player
├── live-test.html          # Live video streaming demo
├── playback-test.html      # Recorded video playback demo
├── api-reference.html      # Complete API documentation
├── DEPLOYMENT.md           # Deployment guide
└── README.md               # This file
```

## Quick Start

### Option 1: Use the Hosted Demo (HTTPS)

Access the demo pages directly:
```
https://dividia-dev.github.io/api/nvr-demo.html
```

**Best for:**
- Remote NVR access (serial.dvr.dividia.net URLs)
- WebSocket H.264 streaming
- No local setup required

### Option 2: Run Locally (HTTP)

For testing with local IP addresses:

```bash
# Clone the repo
git clone https://github.com/dividia-dev/api.git
cd api

# Start local HTTP server (Python)
python3 -m http.server 8080

# Or use Node.js (no install needed)
npx serve -p 8080
# or: npx http-server -p 8080

# Open in browser
# http://localhost:8080/nvr-demo.html
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

### Combined Demo (`nvr-demo.html`)

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

### API Reference (`api-reference.html`)

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

## WSPlayer.js - Reusable WebSocket Video Player

For integrating WebSocket H.264/H.265 video into your own applications, use the `WSPlayer.js` library. It's a fully self-contained component that generates all HTML (canvas, overlays, loading spinner, stats) inside a container element.

### Basic Usage

```html
<script src="WSPlayer.js"></script>

<!-- Just provide an empty container - WSPlayer generates all HTML inside -->
<div id="camera-1" style="width: 640px; height: 480px;"></div>

<script>
// Create and start player using the factory method
const player = WSPlayer.create('camera-1', {
    camera: [1, 'Front Door'],  // [cameraId, cameraName]
    host: '256.dvr.dividia.net',
    port: 443,
    profile: 1,
    session: 'your-session-token',
    secure: true,

    onConnect: () => console.log('Connected'),
    onFirstFrame: () => console.log('Video started'),
    onError: (err) => console.error('Error:', err)
});

// Control methods
player.stop();      // Stop streaming
player.start();     // Start streaming
player.restart();   // Restart streaming

// Status methods
player.connected();       // Returns true/false
player.getStatus();       // Returns full status object
player.getDebugString();  // Returns human-readable debug info
</script>
```

### Features

- **Self-contained** - Generates all HTML (canvas, overlays, spinner, stats) inside container
- **H.264 and H.265 support** - Auto-detects codec from stream
- **Hardware acceleration** - Uses WebCodecs for efficient decoding
- **Auto-reconnect** - Automatically reconnects on disconnect
- **Stall detection** - Detects and reports when stream stops
- **Built-in overlays** - Camera name, FPS stats, and timestamp (configurable)
- **Loading states** - Built-in loading spinner and error display
- **Callbacks** - Events for connect, disconnect, first frame, errors, stall, reconnecting, metadata

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `camera` | array | - | Camera info as `[id, name]` |
| `host` | string | - | NVR hostname |
| `port` | number | 443/80 | NVR port |
| `profile` | number | 1 | Stream profile (1=full, 2=lower) |
| `session` | string | - | Session token |
| `secure` | boolean | auto | Use wss:// (auto-detected from page) |
| `url` | string | - | Full WebSocket URL (alternative to above) |
| `noOverlay` | bool/array | - | Hide overlays: `true` or `['cam_name', 'fps', 'ts']` |
| `autoReconnect` | boolean | true | Auto-reconnect on disconnect |
| `reconnectDelay` | number | 5000 | Reconnect delay in ms |
| `stallTimeout` | number | 5000 | Stall detection timeout in ms |
| `debug` | boolean | false | Enable debug logging |

### Callbacks

| Callback | Description |
|----------|-------------|
| `onConnect` | WebSocket connected |
| `onFirstFrame` | First video frame displayed |
| `onError` | Connection or decode error |
| `onDisconnect` | Connection closed |
| `onReconnecting` | Auto-reconnect started |
| `onStall` | No data received (stalled) |
| `onMetadata` | Server metadata received |

See `WSPlayer.js` and `api-reference.html` for full documentation.

## Integration Patterns

**Web Browser Applications:**
- Use WebSocket H.264 for best performance (HTTPS required)
- Use `WSPlayer.js` for easy integration
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

https://github.com/dividia-dev/api

---

**Dividia Corporation**
