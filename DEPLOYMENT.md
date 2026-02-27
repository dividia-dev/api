# Deployment Guide

Instructions for hosting the Dividia NVR API demo pages.

## Overview

The demo pages can be served over HTTP or HTTPS. Different streaming features are available depending on the protocol:

| Protocol | Supported Features | Use Case |
|----------|-------------------|----------|
| **HTTPS** | JPEG, MJPEG, WebSocket H.264 | Remote NVR access |
| **HTTP** | JPEG, MJPEG | Local network testing |

The pages auto-detect their protocol and configure accordingly - the same files work for both.

## Option 1: GitHub Pages (Recommended)

GitHub Pages provides free HTTPS hosting.

1. Fork or push this repository to GitHub
2. Go to **Settings** → **Pages**
3. Select **Deploy from a branch**
4. Choose **main** branch, **/ (root)** folder
5. Access at: `https://dividia-dev.github.io/api/`

**Note:** GitHub Pages only supports HTTPS. For HTTP testing, run locally.

## Option 2: Local Development Server

For testing with local IP addresses:

```bash
cd api
python3 -m http.server 8080
```

Open: `http://localhost:8080/nvr-demo.html`

**Note:** `localhost` is a secure context, so WebSocket H.264 works even over HTTP.

## Option 3: Web Server (Nginx)

Deploy to your own web server:

```nginx
# HTTP (for local network access)
server {
    listen 80;
    server_name api-demo.example.com;
    root /var/www/api;
    index nvr-demo.html;
}

# HTTPS (for remote access)
server {
    listen 443 ssl;
    server_name api-demo.example.com;
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;
    root /var/www/api;
    index nvr-demo.html;
}
```

## Option 4: Node.js Server

**HTTP Server:**
```javascript
const http = require('http');
const fs = require('fs');
const path = require('path');

http.createServer((req, res) => {
    let filePath = path.join(__dirname, req.url === '/' ? 'nvr-demo.html' : req.url);
    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('Not found');
        } else {
            const ext = path.extname(filePath);
            const contentType = ext === '.html' ? 'text/html' :
                               ext === '.js' ? 'application/javascript' : 'text/plain';
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(data);
        }
    });
}).listen(8080);
console.log('Server running at http://localhost:8080');
```

**HTTPS Server:**
```javascript
const https = require('https');
const fs = require('fs');
const path = require('path');

const options = {
    key: fs.readFileSync('server.key'),
    cert: fs.readFileSync('server.cert')
};

https.createServer(options, (req, res) => {
    let filePath = path.join(__dirname, req.url === '/' ? 'nvr-demo.html' : req.url);
    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('Not found');
        } else {
            const ext = path.extname(filePath);
            const contentType = ext === '.html' ? 'text/html' :
                               ext === '.js' ? 'application/javascript' : 'text/plain';
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(data);
        }
    });
}).listen(8443);
console.log('Server running at https://localhost:8443');
```

## Protocol Auto-Detection

The demo pages automatically detect how they're being served:

| Page Protocol | Behavior |
|---------------|----------|
| **HTTPS** | Locks to HTTPS mode, enables WebSocket H.264 |
| **HTTP** | Locks to HTTP mode, disables WebSocket H.264 (unless localhost) |
| **file://** | Shows error - web server required |

## NVR Configuration

For the demo pages to communicate with NVRs, CORS headers must be configured:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: POST, GET, OPTIONS
Access-Control-Allow-Headers: Content-Type
```

Without these headers, cross-origin requests will fail.

## Security Notes

- WebSocket H.264 requires a secure context (HTTPS or localhost)
- Self-signed certificates require manual browser acceptance
- Session tokens expire after 2 hours of inactivity
- Use `force=true` in `auth.loginUser` for API integrations

## Files

| File | Description |
|------|-------------|
| `nvr-demo.html` | Combined live + playback demo |
| `live-test.html` | Live video streaming demo |
| `playback-test.html` | Recorded video playback demo |
| `api-reference.html` | Complete API documentation |

## Troubleshooting

**CORS errors:**
- Verify NVR CORS headers are configured
- Check browser console for specific error

**WebSocket not working:**
- Ensure page is served over HTTPS (or localhost)
- Check browser supports WebCodecs (Chrome 94+, Safari 16.4+)

**Mixed content errors:**
- HTTPS pages cannot access HTTP NVRs
- Use HTTP version for local network access
- Use HTTPS version for remote access
