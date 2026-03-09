/**
 * Development Server with CORS Proxy
 *
 * This server:
 * 1. Serves static files (HTML, JS, CSS) from current directory
 * 2. Proxies /api/* requests to the Cloud API (bypasses CORS)
 *
 * Usage:
 *   node dev-server.js                    # Proxy to api.cloud.dividia.net
 *   node dev-server.js --local            # Proxy to localhost:8081
 *   node dev-server.js --host 192.168.1.5 # Proxy to custom host
 *
 *   Then open: http://localhost:3000/cloud-api-demo.html
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 3000;

// Parse command line arguments
const args = process.argv.slice(2);
let CLOUD_API_HOST = 'api.cloud.dividia.net';
let CLOUD_API_PORT = 443;
let USE_HTTPS = true;

if (args.includes('--local')) {
    CLOUD_API_HOST = 'localhost';
    CLOUD_API_PORT = 8081;
    USE_HTTPS = false;
} else if (args.includes('--host')) {
    const hostIndex = args.indexOf('--host');
    if (args[hostIndex + 1]) {
        const hostArg = args[hostIndex + 1];
        if (hostArg.includes(':')) {
            const [host, port] = hostArg.split(':');
            CLOUD_API_HOST = host;
            CLOUD_API_PORT = parseInt(port);
        } else {
            CLOUD_API_HOST = hostArg;
        }
        USE_HTTPS = CLOUD_API_PORT === 443;
    }
}

// MIME types for static files
const mimeTypes = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);
    let pathname = parsedUrl.pathname;

    console.log(`${req.method} ${pathname}`);

    // Proxy requests to /api/* to Cloud API
    if (pathname.startsWith('/api/')) {
        const apiPath = pathname.replace('/api', '');
        const queryString = parsedUrl.search || '';

        const options = {
            hostname: CLOUD_API_HOST,
            port: CLOUD_API_PORT,
            path: apiPath + queryString,
            method: req.method,
            headers: {
                ...req.headers,
                host: CLOUD_API_HOST
            }
        };

        // Remove headers that cause issues
        delete options.headers['host'];
        delete options.headers['origin'];
        delete options.headers['referer'];

        const protocol = USE_HTTPS ? https : http;
        const proxyReq = protocol.request(options, (proxyRes) => {
            // Add CORS headers to response
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res);
        });

        proxyReq.on('error', (e) => {
            console.error('Proxy error:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Proxy error: ' + e.message }));
        });

        // Handle OPTIONS preflight
        if (req.method === 'OPTIONS') {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
            res.writeHead(200);
            res.end();
            return;
        }

        // Forward request body for POST
        if (req.method === 'POST' || req.method === 'PUT') {
            req.pipe(proxyReq);
        } else {
            proxyReq.end();
        }
        return;
    }

    // Serve static files
    if (pathname === '/') pathname = '/cloud-api-demo.html';

    const filePath = path.join(__dirname, pathname);
    const ext = path.extname(filePath).toLowerCase();
    const contentType = mimeTypes[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
        if (err) {
            if (err.code === 'ENOENT') {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('File not found: ' + pathname);
            } else {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Server error');
            }
            return;
        }

        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    });
});

const protocol = USE_HTTPS ? 'https' : 'http';
server.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║  Dividia Cloud API Development Server                      ║
╠════════════════════════════════════════════════════════════╣
║  Local:  http://localhost:${PORT}/cloud-api-demo.html          ║
║  Proxy:  /api/* → ${protocol}://${CLOUD_API_HOST}:${CLOUD_API_PORT}/*
╠════════════════════════════════════════════════════════════╣
║  Options:                                                   ║
║    --local           Proxy to localhost:8081                ║
║    --host HOST:PORT  Proxy to custom host                   ║
╚════════════════════════════════════════════════════════════╝
    `);
});
