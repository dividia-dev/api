/**
 * WSPlayer.js - WebSocket H.264/H.265 Video Player Component
 *
 * A fully self-contained WebSocket video player for Dividia NVR streams.
 * Generates all HTML (canvas, overlay, loading spinner, stats) inside a container.
 *
 * @example Basic Usage:
 * ```html
 * <div id="cam1" style="width: 320px; height: 240px;"></div>
 * <script>
 * const player = WSPlayer.create('cam1', {
 *     camera: [1, 'Front Door'],
 *     host: '192.168.0.131',
 *     profile: 2,
 *     session: 'your-session-token'
 * });
 * </script>
 * ```
 *
 * @example Multiple cameras:
 * ```javascript
 * cameras.forEach(cam => {
 *     WSPlayer.create(`cam${cam.id}`, {
 *         camera: [cam.id, cam.name],
 *         host: 'nvr.example.com',
 *         port: 443,
 *         profile: 2,
 *         session: sessionToken,
 *         secure: true
 *     });
 * });
 * ```
 *
 * @example Hide specific overlays:
 * ```javascript
 * // Hide FPS and timestamp, show only camera name
 * WSPlayer.create('cam1', {
 *     camera: [1, 'Lobby'],
 *     host: 'nvr.example.com',
 *     session: token,
 *     noOverlay: ['fps', 'ts']  // Options: 'cam_name', 'fps', 'ts'
 * });
 *
 * // Hide ALL overlays (shorthand)
 * WSPlayer.create('cam1', { ..., noOverlay: true });
 * // or
 * WSPlayer.create('cam1', { ..., noOverlay: [] });
 * ```
 *
 * Requirements:
 * - Secure context (HTTPS or localhost) for WebCodecs API
 * - Modern browser: Chrome 94+, Edge 94+, Safari 16.4+
 *
 * @author Dividia Technologies
 * @version 2.3.0
 */

class WSPlayer {
    /**
     * Create a new WSPlayer instance
     *
     * @param {HTMLElement|string} target - Container element or ID
     * @param {Object} options - Configuration options
     * @param {string} [options.url] - Full WebSocket URL (alternative to host/port/camera/profile/session)
     * @param {Array|Object} [options.camera] - Camera info: [id, name] or {id, name}
     * @param {string} [options.host] - NVR hostname
     * @param {number} [options.port] - NVR port (default: 443 for secure, 80 for insecure)
     * @param {number} [options.profile=1] - Stream profile (1 or 2)
     * @param {string} [options.session] - Session token
     * @param {boolean} [options.secure] - Use wss:// (auto-detected from page protocol if not specified)
     * @param {boolean} [options.showOverlay=true] - Show camera name overlay
     * @param {boolean} [options.showStats=true] - Show FPS/frame stats
     * @param {boolean} [options.showTimestamp=true] - Show current time
     * @param {boolean|Array} [options.noOverlay] - Hide overlays: true or [] = hide all; ['cam_name', 'fps', 'ts'] = hide specific
     * @param {boolean} [options.autoStart=false] - Start streaming immediately
     * @param {boolean} [options.autoReconnect=true] - Auto-reconnect on disconnect
     * @param {number} [options.reconnectDelay=5000] - Reconnect delay in ms
     * @param {number} [options.stallTimeout=5000] - Stall detection timeout in ms
     * @param {Function} [options.onConnect] - Called when WebSocket connects
     * @param {Function} [options.onDisconnect] - Called when WebSocket disconnects
     * @param {Function} [options.onError] - Called on error
     * @param {Function} [options.onFirstFrame] - Called when first frame is decoded
     * @param {Function} [options.onMetadata] - Called when metadata is received
     * @param {Function} [options.onReconnecting] - Called when reconnection starts
     * @param {Function} [options.onStall] - Called when stream stalls (no data received)
     */
    constructor(target, options = {}) {
        this.options = options;

        // Resolve target element
        this._resolveTarget(target);

        // Parse camera info
        this._parseCamera(options.camera);

        // Build WebSocket URL
        this.wsUrl = this._buildUrl(options);

        // UI options - check noOverlay first, then fall back to individual options
        // noOverlay: true or [] = hide all; noOverlay: ['fps', 'ts'] = hide specific ones
        const noOverlay = options.noOverlay;
        const hideAll = noOverlay === true || (Array.isArray(noOverlay) && noOverlay.length === 0);
        const hideList = hideAll ? ['cam_name', 'fps', 'ts'] : (Array.isArray(noOverlay) ? noOverlay : []);

        this.showOverlay = !hideList.includes('cam_name') && options.showOverlay !== false;
        this.showStats = !hideList.includes('fps') && options.showStats !== false;
        this.showTimestamp = !hideList.includes('ts') && options.showTimestamp !== false;

        // Connection state
        this.ws = null;
        this.isConnected = false;
        this.shouldReconnect = options.autoReconnect !== false;
        this.reconnectDelay = options.reconnectDelay || 5000;
        this.reconnectTimer = null;

        // Stall detection
        this.stallTimeout = options.stallTimeout || 5000;
        this.lastMessage = 0;
        this.stallInterval = null;

        // Decoder state
        this.decoder = null;
        this.codec = null;
        this.timestampCounter = 0;
        this.frameCount = 0;
        this.firstFrameReceived = false;
        this.gotKeyframe = false;  // Track if we've received a keyframe (required before decoding)
        this.startTime = null;

        // Stats update interval
        this.statsInterval = null;

        // Metadata from server
        this.metadata = null;

        // Callbacks
        this.onConnect = options.onConnect || null;
        this.onDisconnect = options.onDisconnect || null;
        this.onError = options.onError || null;
        this.onFirstFrame = options.onFirstFrame || null;
        this.onMetadata = options.onMetadata || null;
        this.onReconnecting = options.onReconnecting || null;
        this.onStall = options.onStall || null;

        // Debug mode
        this.debug = options.debug || false;

        // Auto-start if requested
        if (options.autoStart) {
            this.start();
        }
    }

    /**
     * Factory method to create and start a player in a container
     * @param {HTMLElement|string} container - Container element or ID
     * @param {Object} options - Configuration options
     * @returns {WSPlayer} The created player instance
     */
    static create(container, options = {}) {
        options.autoStart = true;
        return new WSPlayer(container, options);
    }

    /**
     * Check if WebCodecs is supported
     * @returns {Object} { supported: boolean, reason?: string }
     */
    static checkSupport() {
        if (!window.isSecureContext) {
            return {
                supported: false,
                reason: 'WebCodecs requires a secure context (HTTPS or localhost)'
            };
        }
        if (typeof VideoDecoder === 'undefined') {
            return {
                supported: false,
                reason: 'VideoDecoder not available. Use Chrome 94+, Edge 94+, or Safari 16.4+'
            };
        }
        return { supported: true };
    }

    /**
     * Resolve target element
     * @private
     */
    _resolveTarget(target) {
        let element;

        if (typeof target === 'string') {
            element = document.getElementById(target);
            if (!element) {
                throw new Error(`WSPlayer: Element with ID '${target}' not found`);
            }
        } else {
            element = target;
        }

        if (!element) {
            throw new Error('WSPlayer: Valid target element required');
        }

        this.container = element;
        this._createHTML();
    }

    /**
     * Create HTML structure inside container
     * @private
     */
    _createHTML() {
        this.container.innerHTML = '';

        // Set container styles
        const containerStyle = window.getComputedStyle(this.container);
        if (containerStyle.position === 'static') {
            this.container.style.position = 'relative';
        }
        this.container.style.overflow = 'hidden';
        this.container.style.backgroundColor = '#000';

        // Create canvas
        this.canvas = document.createElement('canvas');
        this.canvas.style.cssText = 'width: 100%; height: 100%; display: block; object-fit: contain;';
        this.container.appendChild(this.canvas);
        this.ctx = this.canvas.getContext('2d');

        // Create overlay (top-left: camera info)
        this.overlayEl = document.createElement('div');
        this.overlayEl.style.cssText = `
            position: absolute;
            left: 8px;
            top: 8px;
            background: rgba(0, 0, 0, 0.6);
            padding: 4px 10px;
            border-radius: 4px;
            font-size: 13px;
            font-family: system-ui, -apple-system, sans-serif;
            color: white;
            pointer-events: none;
            z-index: 10;
        `;
        this.container.appendChild(this.overlayEl);

        // Create stats display (bottom-left)
        this.statsEl = document.createElement('div');
        this.statsEl.style.cssText = `
            position: absolute;
            left: 8px;
            bottom: 8px;
            background: rgba(0, 0, 0, 0.6);
            padding: 3px 8px;
            border-radius: 4px;
            font-size: 11px;
            font-family: monospace;
            color: #aaa;
            pointer-events: none;
            z-index: 10;
            display: none;
        `;
        this.container.appendChild(this.statsEl);

        // Create timestamp display (bottom-right)
        this.timestampEl = document.createElement('div');
        this.timestampEl.style.cssText = `
            position: absolute;
            right: 8px;
            bottom: 8px;
            background: rgba(0, 0, 0, 0.6);
            padding: 3px 8px;
            border-radius: 4px;
            font-size: 11px;
            font-family: monospace;
            color: #aaa;
            pointer-events: none;
            z-index: 10;
            display: none;
        `;
        this.container.appendChild(this.timestampEl);

        // Create loading overlay
        this.loadingEl = document.createElement('div');
        this.loadingEl.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            background: rgba(0, 0, 0, 0.7);
            z-index: 20;
        `;
        this.loadingEl.innerHTML = `
            <div class="wsplayer-spinner" style="
                width: 40px;
                height: 40px;
                border: 3px solid rgba(255,255,255,0.2);
                border-top-color: #fff;
                border-radius: 50%;
                animation: wsplayer-spin 1s linear infinite;
            "></div>
            <div class="wsplayer-loading-text" style="
                margin-top: 12px;
                color: white;
                font-size: 14px;
                font-family: system-ui, -apple-system, sans-serif;
            ">Connecting...</div>
            <div class="wsplayer-loading-status" style="
                margin-top: 4px;
                color: #aaa;
                font-size: 12px;
                font-family: system-ui, -apple-system, sans-serif;
            "></div>
        `;
        this.container.appendChild(this.loadingEl);

        // Add spinner animation
        if (!document.getElementById('wsplayer-styles')) {
            const style = document.createElement('style');
            style.id = 'wsplayer-styles';
            style.textContent = `
                @keyframes wsplayer-spin {
                    to { transform: rotate(360deg); }
                }
            `;
            document.head.appendChild(style);
        }

        // Store references to loading elements
        this.loadingTextEl = this.loadingEl.querySelector('.wsplayer-loading-text');
        this.loadingStatusEl = this.loadingEl.querySelector('.wsplayer-loading-status');
        this.spinnerEl = this.loadingEl.querySelector('.wsplayer-spinner');
    }

    /**
     * Parse camera info from various formats
     * @private
     */
    _parseCamera(camera) {
        if (Array.isArray(camera)) {
            this.cameraId = camera[0];
            this.cameraName = camera[1] || `Camera ${camera[0]}`;
        } else if (camera && typeof camera === 'object') {
            this.cameraId = camera.id || camera.bID;
            this.cameraName = camera.name || camera.sName || `Camera ${this.cameraId}`;
        } else if (typeof camera === 'number') {
            this.cameraId = camera;
            this.cameraName = `Camera ${camera}`;
        } else {
            this.cameraId = null;
            this.cameraName = '';
        }
    }

    /**
     * Build WebSocket URL from options
     * @private
     */
    _buildUrl(options) {
        if (options.url) {
            return options.url;
        }

        const cameraId = this.cameraId || options.cameraId;
        if (!options.host || !cameraId || !options.session) {
            throw new Error('WSPlayer: Either url or (host, camera/cameraId, session) required');
        }

        const secure = options.secure !== undefined
            ? options.secure
            : window.location.protocol === 'https:';

        const protocol = secure ? 'wss' : 'ws';
        const port = options.port || (secure ? 443 : 80);
        const profile = options.profile || 1;

        return `${protocol}://${options.host}:${port}/ws/cam${cameraId}-pro${profile}?sess=${options.session}`;
    }

    /**
     * Start the WebSocket connection and video stream
     */
    start() {
        const support = WSPlayer.checkSupport();
        if (!support.supported) {
            this._showError('Not Supported', support.reason);
            this._error(new Error(support.reason));
            return;
        }

        this._log('Connecting to', this.wsUrl);
        this.shouldReconnect = this.options.autoReconnect !== false;
        this.startTime = Date.now();
        this.frameCount = 0;
        this.firstFrameReceived = false;

        this._showLoading('Connecting...', 'Establishing WebSocket');
        this._connect();
    }

    /**
     * Stop the WebSocket connection and cleanup
     */
    stop() {
        this._log('Stopping');
        this.shouldReconnect = false;
        this._cleanup();
        this._setOverlay('Stopped');
        this._hideLoading();

        if (this.onDisconnect) {
            this.onDisconnect();
        }
    }

    /**
     * Restart the stream (stop and start)
     */
    restart() {
        this._log('Restarting');
        this._cleanup();
        this.start();
    }

    /**
     * Check if currently connected
     * @returns {boolean}
     */
    connected() {
        return this.isConnected;
    }

    /**
     * Get current player status for debugging
     * @returns {Object} Status object with connection state, stats, and config
     */
    getStatus() {
        const now = performance.now();
        return {
            // Connection state
            connected: this.isConnected,
            reconnecting: this.shouldReconnect && !this.isConnected,

            // Stream info
            cameraId: this.cameraId,
            cameraName: this.cameraName,
            codec: this.codec,

            // Stats
            frameCount: this.frameCount,
            fps: this.getFPS(),
            firstFrameReceived: this.firstFrameReceived,

            // Timing
            uptime: this.startTime ? Math.floor((Date.now() - this.startTime) / 1000) : 0,
            lastMessageAge: this.lastMessage ? Math.floor(now - this.lastMessage) : null,

            // Decoder state
            decoderState: this.decoder ? this.decoder.state : 'none',

            // Config
            wsUrl: this.wsUrl,
            autoReconnect: this.options.autoReconnect !== false,
            reconnectDelay: this.reconnectDelay,
            stallTimeout: this.stallTimeout
        };
    }

    /**
     * Get a formatted debug string
     * @returns {string} Human-readable status string
     */
    getDebugString() {
        const s = this.getStatus();
        const lines = [
            `Camera: ${s.cameraName} (ID: ${s.cameraId})`,
            `Connected: ${s.connected ? 'Yes' : 'No'}${s.reconnecting ? ' (reconnecting)' : ''}`,
            `Codec: ${s.codec || 'unknown'}`,
            `Frames: ${s.frameCount} | FPS: ${s.fps.toFixed(1)}`,
            `Uptime: ${s.uptime}s`,
            `Decoder: ${s.decoderState}`
        ];
        return lines.join('\n');
    }

    /**
     * Get current frame count
     * @returns {number}
     */
    getFrameCount() {
        return this.frameCount;
    }

    /**
     * Get current FPS
     * @returns {number}
     */
    getFPS() {
        if (!this.startTime || this.frameCount === 0) return 0;
        const elapsed = (Date.now() - this.startTime) / 1000;
        return elapsed > 0 ? (this.frameCount / elapsed) : 0;
    }

    /**
     * Get camera info
     * @returns {Object} { id, name }
     */
    getCamera() {
        return { id: this.cameraId, name: this.cameraName };
    }

    // ==================== UI Methods ====================

    /**
     * Show loading overlay
     * @private
     */
    _showLoading(text, status) {
        if (this.loadingEl) {
            this.loadingEl.style.display = 'flex';
            if (this.spinnerEl) this.spinnerEl.style.display = 'block';
            if (this.loadingTextEl) {
                this.loadingTextEl.textContent = text || 'Loading...';
                this.loadingTextEl.style.color = 'white';
            }
            if (this.loadingStatusEl) {
                this.loadingStatusEl.textContent = status || '';
            }
        }
    }

    /**
     * Hide loading overlay
     * @private
     */
    _hideLoading() {
        if (this.loadingEl) {
            this.loadingEl.style.display = 'none';
        }
    }

    /**
     * Show error in loading overlay
     * @private
     */
    _showError(text, status) {
        if (this.loadingEl) {
            this.loadingEl.style.display = 'flex';
            if (this.spinnerEl) this.spinnerEl.style.display = 'none';
            if (this.loadingTextEl) {
                this.loadingTextEl.textContent = text || 'Error';
                this.loadingTextEl.style.color = '#e57373';
            }
            if (this.loadingStatusEl) {
                this.loadingStatusEl.textContent = status || '';
            }
        }
    }

    /**
     * Set overlay text
     * @private
     */
    _setOverlay(text) {
        if (this.overlayEl && this.showOverlay) {
            this.overlayEl.textContent = text;
            this.overlayEl.style.display = 'block';
        }
    }

    /**
     * Hide overlay
     * @private
     */
    _hideOverlay() {
        if (this.overlayEl) {
            this.overlayEl.style.display = 'none';
        }
    }

    /**
     * Update stats display
     * @private
     */
    _updateStats() {
        if (this.statsEl && this.showStats && this.firstFrameReceived) {
            const fps = this.getFPS().toFixed(1);
            this.statsEl.textContent = `Frames: ${this.frameCount} | FPS: ${fps}`;
            this.statsEl.style.display = 'block';
        }

        if (this.timestampEl && this.showTimestamp && this.firstFrameReceived) {
            this.timestampEl.textContent = new Date().toLocaleTimeString();
            this.timestampEl.style.display = 'block';
        }
    }

    /**
     * Start stats update interval
     * @private
     */
    _startStatsInterval() {
        if (this.statsInterval) clearInterval(this.statsInterval);
        this.statsInterval = setInterval(() => this._updateStats(), 1000);
    }

    /**
     * Stop stats update interval
     * @private
     */
    _stopStatsInterval() {
        if (this.statsInterval) {
            clearInterval(this.statsInterval);
            this.statsInterval = null;
        }
    }

    // ==================== WebSocket Methods ====================

    /**
     * Connect to WebSocket
     * @private
     */
    _connect() {
        try {
            this.ws = new WebSocket(this.wsUrl);
            this.ws.binaryType = 'arraybuffer';

            this.ws.onopen = () => {
                this._log('Connected');
                this.isConnected = true;
                this.lastMessage = performance.now();
                this.stallInterval = setInterval(() => this._checkStall(), 1000);

                // this._showLoading('Connected', 'Waiting for video data...');

                if (this.onConnect) {
                    this.onConnect();
                }
            };

            this.ws.onerror = (err) => {
                this._log('WebSocket error', err);
                this._showError('Connection Failed', 'Unable to connect to stream');
                this._showLoading('');
                this._error(err);
            };

            this.ws.onclose = () => {
                this._log('WebSocket closed');
                this.isConnected = false;
                this._stopDecoder();
                this._stopStatsInterval();
                clearInterval(this.stallInterval);

                if (this.shouldReconnect) {
                    this._log(`Reconnecting in ${this.reconnectDelay / 1000}s...`);
                    this._showLoading('Reconnecting...', `Connection lost`);
                    this._fadeCanvas();
                    clearTimeout(this.reconnectTimer);
                    this.reconnectTimer = setTimeout(() => this._connect(), this.reconnectDelay);

                    if (this.onReconnecting) {
                        this.onReconnecting();
                    }
                } else if (this.onDisconnect) {
                    this.onDisconnect();
                }
            };

            this.ws.onmessage = (ev) => {
                this.lastMessage = performance.now();

                try {
                    if (typeof ev.data === 'string') {
                        this.metadata = JSON.parse(ev.data);
                        if (this.onMetadata) {
                            this.onMetadata(this.metadata);
                        }
                    } else {
                        this._decodeAU(new Uint8Array(ev.data));
                    }
                } catch (e) {
                    this._log('Message error:', e);
                    this._error(e);
                }
            };
        } catch (e) {
            this._log('Connection error:', e);
            this._showError('Connection Failed', e.message);
            this._error(e);
        }
    }

    /**
     * Check for stalled stream
     * @private
     */
    _checkStall() {
        const now = performance.now();
        const delta = now - this.lastMessage;
        if (delta > this.stallTimeout) {
            this._log('Stream stalled');
            this._showLoading('Stream Stalled', 'No data received');
            this._fadeCanvas();
            clearInterval(this.stallInterval);

            if (this.onStall) {
                this.onStall();
            }
        }
    }

    // ==================== Decoder Methods ====================

    /**
     * Initialize the video decoder
     * @private
     */
    _initDecoder(codec) {
        this.decoder = new VideoDecoder({
            output: (frame) => this._handleFrame(frame),
            error: (e) => {
                this._log('Decoder error:', e);
                this._error(e);
            }
        });

        if (codec === 'h264') {
            this.decoder.configure({
                codec: 'avc1.42C01E',
                avc: { format: 'annexb' },
                hardwareAcceleration: 'prefer-hardware'
            });
            this._log('Decoder initialized (H.264)');
        } else if (codec === 'h265') {
            this.decoder.configure({
                codec: 'hvc1.1.1.L120.A0',
                hardwareAcceleration: 'prefer-hardware'
            });
            this._log('Decoder initialized (H.265)');
        }
    }

    /**
     * Stop and cleanup decoder
     * @private
     */
    _stopDecoder() {
        try {
            if (this.decoder && this.decoder.state !== 'closed') {
                this.decoder.close();
            }
        } catch (_) {}
        this.decoder = null;
        this.codec = null;
        this.timestampCounter = 0;
        this.gotKeyframe = false;  // Reset so we wait for keyframe on reconnect
    }

    /**
     * Get NAL header index
     * @private
     */
    _nalHeaderIndex(nal) {
        if (nal[0] === 0x00 && nal[1] === 0x00 && nal[2] === 0x01) return 3;
        if (nal[0] === 0x00 && nal[1] === 0x00 && nal[2] === 0x00 && nal[3] === 0x01) return 4;
        return 0;
    }

    /**
     * Detect codec type
     * @private
     */
    _detectCodec(bytes) {
        const hdr = this._nalHeaderIndex(bytes);
        const b = bytes[hdr];
        const h264nal = b & 0x1F;
        if (h264nal >= 1 && h264nal <= 31) return 'h264';
        return 'h265';
    }

    /**
     * Detect if frame is a keyframe by scanning all NAL units in the buffer
     * @private
     */
    _detectKey(bytes, codec) {
        // Scan through buffer looking for NAL start codes and check each NAL type
        for (let i = 0; i < bytes.length - 4; i++) {
            // Look for start code: 00 00 01 or 00 00 00 01
            if (bytes[i] === 0 && bytes[i + 1] === 0) {
                let nalStart = -1;
                if (bytes[i + 2] === 1) {
                    nalStart = i + 3;
                } else if (bytes[i + 2] === 0 && bytes[i + 3] === 1) {
                    nalStart = i + 4;
                }

                if (nalStart > 0 && nalStart < bytes.length) {
                    if (codec === 'h264') {
                        const nalType = bytes[nalStart] & 0x1F;
                        // IDR (5), SPS (7), PPS (8) indicate keyframe
                        if (nalType === 5 || nalType === 7 || nalType === 8) {
                            return true;
                        }
                    } else if (codec === 'h265') {
                        const nalType = (bytes[nalStart] >> 1) & 0x3F;
                        // IDR (19-21), VPS (32), SPS (33), PPS (34)
                        if (nalType >= 19 && nalType <= 21 || nalType >= 32 && nalType <= 34) {
                            return true;
                        }
                    }
                }
            }
        }
        return false;
    }

    /**
     * Decode an Access Unit
     * @private
     */
    _decodeAU(bytes) {
        if (!this.codec) {
            this.codec = this._detectCodec(bytes);
        }

        const isKey = this._detectKey(bytes, this.codec);

        // Debug: log NAL info for first few frames
        if (this.debug && this.timestampCounter < 10) {
            const hdr = this._nalHeaderIndex(bytes);
            const nalType = this.codec === 'h264' ? (bytes[hdr] & 0x1F) : ((bytes[hdr] >> 1) & 0x3F);
            this._log(`Frame ${this.timestampCounter}: ${bytes.length} bytes, NAL type ${nalType}, isKey=${isKey}`);
        }

        // Must wait for keyframe before decoding (required after configure/flush)
        if (!this.gotKeyframe) {
            if (!isKey) {
                // Skip delta frames until we get a keyframe
                return;
            }
            this.gotKeyframe = true;
            this._log('Got first keyframe, starting decode');
        }

        if (!this.decoder || this.decoder.state === 'closed') {
            this._initDecoder(this.codec);
        }

        try {
            this.decoder.decode(new EncodedVideoChunk({
                type: isKey ? 'key' : 'delta',
                timestamp: this.timestampCounter++,
                data: bytes
            }));
        } catch (e) {
            this._log('Decode error:', e);
        }
    }

    /**
     * Handle decoded frame
     * @private
     */
    _handleFrame(frame) {
        // Resize canvas if needed
        if (this.canvas.width !== frame.displayWidth ||
            this.canvas.height !== frame.displayHeight) {
            this.canvas.width = frame.displayWidth;
            this.canvas.height = frame.displayHeight;
        }

        // Draw frame
        this.ctx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);

        // Draw object detection boxes if present
        if (this.metadata?.objects) {
            this._drawObjects(this.metadata.objects);
        }

        frame.close();
        this.frameCount++;

        // First frame - hide loading, show overlay, start stats
        if (!this.firstFrameReceived) {
            this.firstFrameReceived = true;
            this._hideLoading();

            if (this.showOverlay && this.cameraName) {
                this._setOverlay(this.cameraName);
            }

            this._startStatsInterval();

            if (this.onFirstFrame) {
                this.onFirstFrame();
            }
        }
    }

    /**
     * Draw object detection boxes
     * @private
     */
    _drawObjects(objects) {
        this.ctx.lineWidth = 2;
        this.ctx.strokeStyle = 'lime';
        this.ctx.fillStyle = 'white';
        this.ctx.font = '12px sans-serif';

        for (const obj of objects) {
            const [x, y, w, h] = obj.bbox;
            const px = x * this.canvas.width;
            const py = y * this.canvas.height;
            const pw = w * this.canvas.width;
            const ph = h * this.canvas.height;

            this.ctx.strokeRect(px, py, pw, ph);
            if (obj.label) {
                this.ctx.fillText(obj.label, px + 4, Math.max(12, py + 14));
            }
        }
    }

    /**
     * Fade canvas to indicate disconnected state
     * @private
     */
    _fadeCanvas() {
        this.ctx.fillStyle = 'rgba(0, 0, 100, 0.5)';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }

    /**
     * Cleanup all resources
     * @private
     */
    _cleanup() {
        clearInterval(this.stallInterval);
        clearTimeout(this.reconnectTimer);
        this._stopStatsInterval();

        if (this.ws) {
            try {
                this.ws.onclose = null;
                this.ws.onerror = null;
                this.ws.onmessage = null;
                this.ws.onopen = null;
                this.ws.close();
            } catch (_) {}
            this.ws = null;
        }

        this._stopDecoder();
        this.isConnected = false;
        this.firstFrameReceived = false;
    }

    /**
     * Handle and report error
     * @private
     */
    _error(err) {
        if (this.onError) {
            this.onError(err);
        }
    }

    /**
     * Debug logging
     * @private
     */
    _log(...args) {
        if (this.debug) {
            const prefix = this.cameraName ? `[WSPlayer:${this.cameraName}]` : '[WSPlayer]';
            console.log(prefix, ...args);
        }
    }
}

// Export for module usage
if (typeof module !== 'undefined' && module.exports) {
    module.exports = WSPlayer;
}
