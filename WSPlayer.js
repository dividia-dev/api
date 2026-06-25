/**
 * WSPlayer.js - WebSocket H.264/H.265 Video Player Component
 *
 * A fully self-contained WebSocket video player for Dividia NVR streams.
 * Generates all HTML (canvas, overlay, loading spinner, stats) inside a container.
 *
 * Features:
 * - Hardware/Software decoder auto-detection to avoid "pumping" (frame jitter)
 * - Automatically switches to software decoding if hardware causes timing issues
 * - Persists decoder preference per hostname in localStorage
 * - Analytics overlays (object detection, license-plate recognition, point-of-sale)
 *   drawn on the video, with per-type show/hide toggles
 * - Structured analytics events (objectEvent / lprEvent / posEvent) published to an
 *   optional MessageQueue, each with a cropped JPEG of the detection. Event emission
 *   is independent of the overlay toggles, so data flows even while boxes are hidden.
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
 * @example Reset decoder preference (retry hardware after switching to software):
 * ```javascript
 * WSPlayer.resetDecoderPreference();
 * ```
 *
 * Requirements:
 * - Secure context (HTTPS or localhost) for WebCodecs API
 * - Modern browser: Chrome 94+, Edge 94+, Safari 16.4+
 *
 * @author Dividia Technologies
 * @version 2.5.0
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
     * @param {MessageQueue} [options.messageQueue] - Optional pub/sub bus. When set, the
     *        player publishes 'objectEvent' / 'lprEvent' / 'posEvent' (each with a cropped
     *        JPEG). Emission is independent of the overlay toggles below.
     * @param {boolean|Function} [options.showObjects=true] - Draw object detection boxes.
     *        Pass a predicate (obj)=>boolean to draw only matching objects.
     * @param {boolean|Function} [options.showLpr=false] - Draw license-plate quads + ROI.
     *        Pass a predicate (result)=>boolean to draw only matching plate reads.
     * @param {boolean|Function} [options.showPos=false] - Draw the point-of-sale receipt panel.
     * @param {Function} [options.onOverlayChange] - Called (type, value) when an overlay is
     *        toggled (e.g. via the right-click menu), so external UI can stay in sync.
     * @param {boolean} [options.showPtz=false] - Show on-video PTZ controls (D-pad / zoom / presets).
     * @param {Function} [options.onPtz] - Called with each PTZ command object as it is sent
     *        upstream over the WebSocket (e.g. {axis:'x',value:80} or {preset:'goto',n:1}).
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
        this.spsPpsBuffer = null;  // Buffer SPS/PPS until IDR arrives
        this.startTime = null;

        // Always start with hardware — pumping detection may switch to software for this session
        // (never persisted to localStorage; each page load starts fresh with hardware)
        this.useHardwareAccel = true;
        this.pumpingCheckDone = false;
        this.frameTimings = [];
        this.lastFrameTime = null;

        // Stats update interval
        this.statsInterval = null;

        // Metadata from server
        this.metadata = null;

        // ---- Analytics metadata layer (objects / LPR / POS) ----
        // Optional pub/sub bus; when present the player publishes structured events.
        this.messageQueue = options.messageQueue || null;

        // Overlay visibility (per-type). Each accepts true | false | predicate fn.
        // Defaults preserve historical behavior: object boxes on, LPR/POS off.
        this.showObjects = options.showObjects !== undefined ? options.showObjects : true;
        this.showLpr = options.showLpr !== undefined ? options.showLpr : false;
        this.showPos = options.showPos !== undefined ? options.showPos : false;
        this.showPtz = options.showPtz !== undefined ? options.showPtz : false;

        // Dedup state so events fire once, not every frame.
        this.objIds = [];          // recently-seen object tracking ids (ring, cap 100)
        this._lprSeen = [];        // recently-emitted "state|plate" keys (ring, cap 100)
        this._lastPosJson = null;  // last POS payload published (fire only on change)
        this._ptzEl = null;        // PTZ control overlay element (built when showPtz)

        // Callbacks
        this.onConnect = options.onConnect || null;
        this.onDisconnect = options.onDisconnect || null;
        this.onError = options.onError || null;
        this.onFirstFrame = options.onFirstFrame || null;
        this.onMetadata = options.onMetadata || null;
        this.onReconnecting = options.onReconnecting || null;
        this.onStall = options.onStall || null;
        this.onOverlayChange = options.onOverlayChange || null;
        this.onPtz = options.onPtz || null;

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
     * Reset decoder preference to retry hardware acceleration
     * Call this if you want to re-test hardware decoding after it was switched to software
     * @static
     */
    static resetDecoderPreference() {
        // No-op: preference is no longer persisted to localStorage.
        // Each page load starts fresh with hardware decoding.
        // Pumping detection may switch to software for the current session only.
    }

    /**
     * Check for pumping (frame timing jitter) and switch to software if detected
     * @private
     */
    _checkForPumping() {
        if (this.pumpingCheckDone || !this.useHardwareAccel) return;
        if (this.frameTimings.length < 30) return; // Need enough samples (~3 seconds at 10fps)

        const renderDeltas = this.frameTimings.map(t => t.renderDelta).filter(d => d > 0);
        if (renderDeltas.length < 25) return;

        // Calculate standard deviation
        const avg = renderDeltas.reduce((a, b) => a + b, 0) / renderDeltas.length;
        const variance = renderDeltas.reduce((sum, val) => sum + Math.pow(val - avg, 2), 0) / renderDeltas.length;
        const stdDev = Math.sqrt(variance);

        // Check for burst pattern: multiple very short deltas followed by very long ones
        const veryShort = renderDeltas.filter(d => d < 15).length;
        const veryLong = renderDeltas.filter(d => d > 300).length;
        const hasBurstPattern = veryShort > 5 && veryLong > 2;

        this.pumpingCheckDone = true;

        if (stdDev > 80 || hasBurstPattern) {
            console.warn(`[WSPlayer] Detected pumping (stdDev=${stdDev.toFixed(1)}, burst=${hasBurstPattern}), switching to software decoding for this session`);
            this.useHardwareAccel = false;
            this._restartDecoder();
        } else {
            this._log(`Pumping check passed (stdDev=${stdDev.toFixed(1)}), keeping hardware decoding`);
        }
    }

    /**
     * Restart decoder with current acceleration preference
     * @private
     */
    _restartDecoder() {
        const savedCodec = this.codec;
        this._stopDecoder();
        if (savedCodec) {
            this.codec = savedCodec;
            this._initDecoder(savedCodec);
        }
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

        // Right-click the video to toggle analytics overlays (objects / LPR / POS).
        this.canvas.addEventListener('contextmenu', (e) => this._openOverlayMenu(e));

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
        this._updatePtzVisible();
        this._connect();
    }

    /**
     * Stop the WebSocket connection and cleanup
     */
    stop() {
        this._log('Stopping');
        this.shouldReconnect = false;
        this._cleanup();
        this._closeOverlayMenu();
        if (this._ptzEl) { try { this._ptzEl.remove(); } catch (_) {} this._ptzEl = null; }
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
            hardwareAcceleration: this.useHardwareAccel ? 'prefer-hardware' : 'prefer-software',
            pumpingCheckDone: this.pumpingCheckDone,

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
            `Decoder: ${s.decoderState} (${s.hardwareAcceleration})`
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

            this.ws.onclose = (event) => {
                this._log('WebSocket closed');
                this._log('WebSocket closed', event.code, event.reason);

                this.isConnected = false;
                this._stopDecoder();
                this._stopStatsInterval();
                clearInterval(this.stallInterval);

                if (this.shouldReconnect) {
                    this._log(`Reconnecting in ${this.reconnectDelay / 1000}s...`);
                    // for somereason cloud stuff triggers this and it never goes away - will addres later when there is more time
                    
                    // this._showLoading('Reconnecting...', `Connection lost`);
                    // this._fadeCanvas();
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
    _initDecoder(codec, keyframeBytes) {
        this.decoder = new VideoDecoder({
            output: (frame) => this._handleFrame(frame),
            error: (e) => {
                this._log('Decoder error:', e);
                this._error(e);
            }
        });

        const accel = this.useHardwareAccel ? 'prefer-hardware' : 'prefer-software';

        if (codec === 'h264') {
            // Extract actual profile/level from SPS — fallback to High Profile L4.0
            const codecStr = (keyframeBytes && this._extractH264Codec(keyframeBytes)) || 'avc1.640028';
            this.decoder.configure({
                codec: codecStr,
                avc: { format: 'annexb' },
                hardwareAcceleration: accel
            });
            this._log(`Decoder initialized (H.264 ${codecStr}, ${accel})`);
        } else if (codec === 'h265') {
            this.decoder.configure({
                codec: 'hvc1.1.1.L120.A0',
                hardwareAcceleration: accel
            });
            this._log(`Decoder initialized (H.265, ${accel})`);
        }
    }

    /**
     * Extract H.264 codec string from SPS NAL unit in the bitstream.
     * Handles both Annex B (start codes) and raw NAL format.
     * @private
     */
    _extractH264Codec(bytes) {
        // Scan for SPS via start codes
        for (let i = 0; i < bytes.length - 4; i++) {
            if (bytes[i] === 0 && bytes[i + 1] === 0) {
                let s = -1;
                if (bytes[i + 2] === 1) s = i + 3;
                else if (bytes[i + 2] === 0 && bytes[i + 3] === 1) s = i + 4;
                if (s > 0 && s + 3 < bytes.length && (bytes[s] & 0x1F) === 7) {
                    const hex = (v) => v.toString(16).padStart(2, '0').toUpperCase();
                    return `avc1.${hex(bytes[s+1])}${hex(bytes[s+2])}${hex(bytes[s+3])}`;
                }
            }
        }
        // Raw NAL: check if first byte is SPS header
        if (bytes.length > 3 && (bytes[0] & 0x1F) === 7) {
            const hex = (v) => v.toString(16).padStart(2, '0').toUpperCase();
            return `avc1.${hex(bytes[1])}${hex(bytes[2])}${hex(bytes[3])}`;
        }
        return null;
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
        this.spsPpsBuffer = null;
        // Note: Don't reset frameTimings/pumpingCheckDone here - preserve across decoder restarts
        // They are reset in _cleanup() for full stop/reconnect scenarios
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
     * Collect all NAL types in a buffer.
     * Handles both Annex B (start codes) and raw NAL (no start codes, single NAL per message).
     * @private
     */
    _scanNalTypes(bytes, codec) {
        const types = new Set();
        const getNalType = (b) => codec === 'h265' ? ((b >> 1) & 0x3F) : (b & 0x1F);

        // Try Annex B: scan for start codes (00 00 01 or 00 00 00 01)
        let foundStartCode = false;
        for (let i = 0; i < bytes.length - 4; i++) {
            if (bytes[i] === 0 && bytes[i + 1] === 0) {
                let s = -1;
                if (bytes[i + 2] === 1) s = i + 3;
                else if (bytes[i + 2] === 0 && bytes[i + 3] === 1) s = i + 4;
                if (s > 0 && s < bytes.length) {
                    foundStartCode = true;
                    types.add(getNalType(bytes[s]));
                }
            }
        }

        // No start codes found — treat as raw NAL (first byte is NAL header)
        if (!foundStartCode && bytes.length > 0) {
            types.add(getNalType(bytes[0]));
        }

        return types;
    }

    /**
     * Detect if buffer contains a decodable keyframe (IDR picture data)
     * SPS/PPS alone are NOT keyframes — the decoder needs actual picture data
     * @private
     */
    _detectKey(bytes, codec) {
        const types = this._scanNalTypes(bytes, codec);
        if (codec === 'h264') return types.has(5);        // IDR slice
        if (codec === 'h265') return types.has(19) || types.has(20) || types.has(21);
        return false;
    }

    /**
     * Check if buffer has SPS/PPS parameter sets
     * @private
     */
    _hasParamSets(bytes, codec) {
        const types = this._scanNalTypes(bytes, codec);
        if (codec === 'h264') return types.has(7) || types.has(8);
        if (codec === 'h265') return types.has(32) || types.has(33) || types.has(34);
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
        const hasParams = this._hasParamSets(bytes, this.codec);

        // Debug: log NAL info for first few frames
        if (this.debug && this.timestampCounter < 10) {
            const types = Array.from(this._scanNalTypes(bytes, this.codec));
            this._log(`Frame ${this.timestampCounter}: ${bytes.length} bytes, NALs=[${types}], isKey=${isKey}, params=${hasParams}`);
        }

        // If decoder died from a previous error, fully reset and start over
        if (this.decoder && this.decoder.state === 'closed') {
            this._log('Decoder closed (error recovery), waiting for next keyframe');
            this.decoder = null;
            this.codec = null;
            this.gotKeyframe = false;
            this.spsPpsBuffer = null;
            this.timestampCounter = 0;
            // Re-detect codec for this frame
            this.codec = this._detectCodec(bytes);
        }

        // Must wait for keyframe before decoding
        if (!this.gotKeyframe) {
            // Buffer SPS/PPS that arrive without an IDR
            if (hasParams && !isKey) {
                this.spsPpsBuffer = new Uint8Array(bytes);
                this._log('Buffered SPS/PPS, waiting for IDR...');
                return;
            }
            if (!isKey) return;  // skip delta frames

            // IDR arrived — prepend buffered SPS/PPS if IDR doesn't have its own
            if (!hasParams && this.spsPpsBuffer) {
                this._log('Prepending buffered SPS/PPS to IDR');
                const combined = new Uint8Array(this.spsPpsBuffer.length + bytes.length);
                combined.set(this.spsPpsBuffer, 0);
                combined.set(bytes, this.spsPpsBuffer.length);
                bytes = combined;
            }
            this.spsPpsBuffer = null;
            this.gotKeyframe = true;
            this._log('Got first keyframe, starting decode');
        }

        if (!this.decoder) {
            this._initDecoder(this.codec, isKey ? bytes : null);
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
        const renderTime = performance.now();

        // Resize canvas if needed
        if (this.canvas.width !== frame.displayWidth ||
            this.canvas.height !== frame.displayHeight) {
            this.canvas.width = frame.displayWidth;
            this.canvas.height = frame.displayHeight;
        }

        // Draw frame
        this.ctx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);

        // Draw + publish analytics metadata (objects / LPR / POS) if present.
        // Runs after the frame is on the canvas so event crops capture real pixels.
        this._processMetadata();

        frame.close();
        this.frameCount++;

        // Collect frame timing for pumping detection
        const renderDelta = this.lastFrameTime ? (renderTime - this.lastFrameTime) : 0;
        this.lastFrameTime = renderTime;

        this.frameTimings.push({
            renderTime: renderTime,
            renderDelta: renderDelta
        });

        // Keep only last 200 samples
        if (this.frameTimings.length > 200) {
            this.frameTimings.shift();
        }

        // Check for pumping after ~3 seconds of data
        if (!this.pumpingCheckDone && this.frameTimings.length >= 30) {
            this._checkForPumping();
        }

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

    // ==================== Analytics Metadata (objects / LPR / POS) ====================

    /**
     * Set overlay visibility at runtime.
     * @param {'objects'|'lpr'|'pos'} type
     * @param {boolean|Function} value - true | false | predicate(item)=>boolean
     */
    setOverlayVisible(type, value) {
        if (type === 'objects') this.showObjects = value;
        else if (type === 'lpr') this.showLpr = value;
        else if (type === 'pos') this.showPos = value;
        else if (type === 'ptz') { this.showPtz = value; this._updatePtzVisible(); }
        if (this.onOverlayChange) {
            try { this.onOverlayChange(type, value); } catch (_) {}
        }
    }

    /**
     * Get the current overlay visibility setting for a type.
     * @param {'objects'|'lpr'|'pos'} type
     * @returns {boolean|Function}
     */
    getOverlayVisible(type) {
        if (type === 'objects') return this.showObjects;
        if (type === 'lpr') return this.showLpr;
        if (type === 'pos') return this.showPos;
        if (type === 'ptz') return this.showPtz;
        return undefined;
    }

    /**
     * Right-click context menu to toggle analytics overlays directly on the video.
     * Mirrors setOverlayVisible() so users can do by hand what the API does in code.
     * @private
     */
    _openOverlayMenu(e) {
        e.preventDefault();
        e.stopPropagation();
        this._closeOverlayMenu();

        const menu = document.createElement('div');
        menu.style.cssText =
            'position:fixed;z-index:99999;background:#1e1e1e;border:1px solid #444;' +
            'border-radius:4px;font-family:system-ui,-apple-system,sans-serif;font-size:13px;' +
            'color:#ddd;padding:4px 0;box-shadow:0 4px 14px rgba(0,0,0,0.45);user-select:none;min-width:180px;';

        const items = [
            ['objects', 'Show object boxes'],
            ['lpr', 'Show license plates'],
            ['pos', 'Show POS'],
            ['ptz', 'Show PTZ controls'],
        ];
        for (const [type, label] of items) {
            const on = this._overlayEnabled(this.getOverlayVisible(type));
            const row = document.createElement('div');
            row.style.cssText = 'padding:6px 14px;cursor:pointer;white-space:nowrap;';
            row.textContent = (on ? '☑ ' : '☐ ') + label;
            row.addEventListener('mouseenter', () => { row.style.background = '#333'; });
            row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; });
            row.addEventListener('click', (ev) => {
                ev.stopPropagation();
                this.setOverlayVisible(type, !this._overlayEnabled(this.getOverlayVisible(type)));
                this._closeOverlayMenu();
            });
            menu.appendChild(row);
        }

        document.body.appendChild(menu);
        this._overlayMenuEl = menu;

        // Position at the cursor, clamped to the viewport.
        const mw = menu.offsetWidth, mh = menu.offsetHeight;
        const x = Math.min(e.clientX, window.innerWidth - mw - 6);
        const y = Math.min(e.clientY, window.innerHeight - mh - 6);
        menu.style.left = Math.max(4, x) + 'px';
        menu.style.top = Math.max(4, y) + 'px';

        // Close on any outside click or another right-click (capture phase).
        setTimeout(() => {
            const close = (ev) => {
                if (this._overlayMenuEl && this._overlayMenuEl.contains(ev.target)) return;
                this._closeOverlayMenu();
            };
            this._overlayMenuCloser = close;
            document.addEventListener('click', close, true);
            document.addEventListener('contextmenu', close, true);
        }, 0);
    }

    /**
     * Tear down the overlay context menu.
     * @private
     */
    _closeOverlayMenu() {
        if (this._overlayMenuEl) {
            try { this._overlayMenuEl.remove(); } catch (_) {}
            this._overlayMenuEl = null;
        }
        if (this._overlayMenuCloser) {
            document.removeEventListener('click', this._overlayMenuCloser, true);
            document.removeEventListener('contextmenu', this._overlayMenuCloser, true);
            this._overlayMenuCloser = null;
        }
    }

    // ==================== PTZ Controls ====================

    /**
     * Send a PTZ command upstream over the WebSocket. The server receives
     * { type: 'ptz', ...cmd } — e.g. {axis:'x',value:80} (move) / {axis:'x',value:0}
     * (stop) / {preset:'goto',n:1} (recall preset). Also fires the onPtz callback.
     * @private
     */
    _sendPtz(cmd) {
        if (this.onPtz) { try { this.onPtz(cmd); } catch (_) {} }
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            this._log('PTZ not sent (socket not open):', cmd);
            return;
        }
        try {
            this.ws.send(JSON.stringify(Object.assign({ type: 'ptz' }, cmd)));
        } catch (e) {
            this._log('PTZ send failed:', e);
        }
    }

    /**
     * Build the PTZ control overlay: a 3x3 pan/tilt D-pad (home in the center),
     * zoom +/- and presets 1-4. Directional/zoom buttons send a velocity on press
     * and a stop (value:0) on release; home/presets are one-shot recalls.
     * @private
     */
    _buildPtzOverlay() {
        const root = document.createElement('div');
        root.style.cssText =
            'position:absolute;right:8px;top:50%;transform:translateY(-50%);z-index:15;' +
            'background:rgba(0,0,0,0.45);border:1px solid #444;border-radius:6px;padding:6px;' +
            'display:flex;flex-direction:column;gap:6px;user-select:none;pointer-events:auto;';

        const V = 80;
        const ACTIONS = {
            'pan-n':   { hold: [{ axis: 'y', value: -V }] },
            'pan-s':   { hold: [{ axis: 'y', value:  V }] },
            'pan-e':   { hold: [{ axis: 'x', value:  V }] },
            'pan-w':   { hold: [{ axis: 'x', value: -V }] },
            'pan-ne':  { hold: [{ axis: 'y', value: -V }, { axis: 'x', value:  V }] },
            'pan-nw':  { hold: [{ axis: 'y', value: -V }, { axis: 'x', value: -V }] },
            'pan-se':  { hold: [{ axis: 'y', value:  V }, { axis: 'x', value:  V }] },
            'pan-sw':  { hold: [{ axis: 'y', value:  V }, { axis: 'x', value: -V }] },
            'zoom-in': { hold: [{ axis: 'z', value:  V }] },
            'zoom-out':{ hold: [{ axis: 'z', value: -V }] },
            'home':    { oneshot: [{ preset: 'goto', n: 0 }] },
            'preset-1':{ oneshot: [{ preset: 'goto', n: 1 }] },
            'preset-2':{ oneshot: [{ preset: 'goto', n: 2 }] },
            'preset-3':{ oneshot: [{ preset: 'goto', n: 3 }] },
            'preset-4':{ oneshot: [{ preset: 'goto', n: 4 }] },
        };

        const makeBtn = (label, action, w) => {
            const b = document.createElement('button');
            b.textContent = label;
            b.style.cssText =
                'width:' + (w || 26) + 'px;height:26px;background:#111;border:1px solid #444;' +
                'color:#fff;font-family:monospace;font-size:13px;cursor:pointer;padding:0;line-height:24px;border-radius:3px;';
            const cfg = ACTIONS[action];
            let pressed = false;
            const press = (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                if (pressed) return;
                pressed = true;
                b.style.background = '#2e7d32';
                b.style.borderColor = '#fff';
                if (!cfg) return;
                if (cfg.oneshot) cfg.oneshot.forEach(c => this._sendPtz(c));
                else if (cfg.hold) cfg.hold.forEach(c => this._sendPtz(c));
            };
            const release = () => {
                if (!pressed) return;
                pressed = false;
                b.style.background = '#111';
                b.style.borderColor = '#444';
                if (cfg && cfg.hold) cfg.hold.forEach(c => this._sendPtz({ axis: c.axis, value: 0 }));
            };
            b.addEventListener('mousedown', press);
            b.addEventListener('touchstart', press, { passive: false });
            b.addEventListener('mouseup', release);
            b.addEventListener('mouseleave', release);
            b.addEventListener('touchend', release);
            b.addEventListener('touchcancel', release);
            b.addEventListener('click', ev => ev.stopPropagation());
            return b;
        };

        // 3x3 D-pad with home (house) in the center.
        const pad = document.createElement('div');
        pad.style.cssText = 'display:grid;grid-template-columns:repeat(3,26px);gap:3px;';
        const dirs = [
            ['↖', 'pan-nw'], ['↑', 'pan-n'], ['↗', 'pan-ne'],
            ['←', 'pan-w'],  ['⌂', 'home'],  ['→', 'pan-e'],
            ['↙', 'pan-sw'], ['↓', 'pan-s'], ['↘', 'pan-se'],
        ];
        dirs.forEach(d => pad.appendChild(makeBtn(d[0], d[1])));
        root.appendChild(pad);

        // Zoom +/-.
        const zoom = document.createElement('div');
        zoom.style.cssText = 'display:flex;gap:3px;justify-content:center;';
        zoom.appendChild(makeBtn('+', 'zoom-in', 39));
        zoom.appendChild(makeBtn('−', 'zoom-out', 39));
        root.appendChild(zoom);

        // Presets 1-4.
        const presets = document.createElement('div');
        presets.style.cssText = 'display:flex;gap:3px;justify-content:center;';
        for (let i = 1; i <= 4; i++) presets.appendChild(makeBtn(String(i), 'preset-' + i, 18));
        root.appendChild(presets);

        // Keep clicks on the controls from bubbling to the video (fullscreen/menu).
        root.addEventListener('click', ev => ev.stopPropagation());
        root.addEventListener('mousedown', ev => ev.stopPropagation());
        root.addEventListener('contextmenu', ev => ev.stopPropagation());

        return root;
    }

    /**
     * Show or remove the PTZ control overlay to match this.showPtz.
     * @private
     */
    _updatePtzVisible() {
        if (!this.container) return;
        if (this._overlayEnabled(this.showPtz)) {
            if (!this._ptzEl) {
                this._ptzEl = this._buildPtzOverlay();
                this.container.appendChild(this._ptzEl);
            }
        } else if (this._ptzEl) {
            try { this._ptzEl.remove(); } catch (_) {}
            this._ptzEl = null;
        }
    }

    /**
     * Is an overlay type enabled at all (truthy bool, or a predicate function)?
     * @private
     */
    _overlayEnabled(flag) {
        return typeof flag === 'function' ? true : !!flag;
    }

    /**
     * Should this specific item be drawn? Evaluates a predicate if one was given.
     * @private
     */
    _overlayOn(flag, item) {
        if (typeof flag === 'function') {
            try { return !!flag(item); } catch (_) { return false; }
        }
        return !!flag;
    }

    /**
     * Track object ids so each object publishes an event only once.
     * Objects without a usable id are not published (can't dedup safely).
     * @private
     */
    _isObjNew(id) {
        if (id === undefined || id === null || id === '') return false;
        const key = String(id);
        if (this.objIds.includes(key)) return false;
        if (this.objIds.length > 100) this.objIds.shift();
        this.objIds.push(key);
        return true;
    }

    /**
     * Dedup LPR reads by (state, plate) so a plate fires once per state transition
     * (DETECTING then HIT) rather than every frame it stays in view.
     * @private
     */
    _isLprNew(state, plate) {
        const key = state + '|' + plate;
        if (this._lprSeen.includes(key)) return false;
        if (this._lprSeen.length > 100) this._lprSeen.shift();
        this._lprSeen.push(key);
        return true;
    }

    /**
     * Crop a region of the current canvas to a base64 JPEG data URL.
     * Used to attach a detection snippet to published events.
     * @private
     * @returns {Promise<string|null>}
     */
    _cropToJpeg(px, py, pw, ph) {
        try {
            const tmp = document.createElement('canvas');
            tmp.width = Math.max(1, Math.round(pw));
            tmp.height = Math.max(1, Math.round(ph));
            const tctx = tmp.getContext('2d');
            tctx.drawImage(this.canvas, px, py, pw, ph, 0, 0, tmp.width, tmp.height);
            return new Promise((resolve) => {
                tmp.toBlob((blob) => {
                    if (!blob) return resolve(null);
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(reader.result);
                    reader.onerror = () => resolve(null);
                    reader.readAsDataURL(blob);
                }, 'image/jpeg', 0.85);
            });
        } catch (_) {
            return Promise.resolve(null);
        }
    }

    /**
     * Draw + publish analytics metadata for the current frame.
     * Drawing is gated by the per-type overlay toggles; publishing to the
     * MessageQueue is NOT (so data flows even when boxes are hidden).
     * @private
     */
    _processMetadata() {
        const md = this.metadata;
        if (!md) return;

        const ctx = this.ctx;
        const W = this.canvas.width;
        const H = this.canvas.height;
        if (!W || !H) return;

        // Scale stroke + font to canvas resolution so overlays stay legible after
        // CSS downscales a high-res canvas (e.g. a 4K source shown ~960px wide).
        const stroke = Math.max(2, Math.round(W / 500));
        const fontSize = Math.max(11, Math.round(W / 80));
        const pad = Math.max(2, Math.round(fontSize / 4));
        ctx.font = `bold ${fontSize}px sans-serif`;
        ctx.textBaseline = 'top';

        this._processObjects(md, ctx, W, H, stroke, fontSize, pad);
        this._processLpr(md, ctx, W, H, stroke, fontSize, pad);
        this._processPos(md, ctx, W, H);
    }

    /**
     * Object detection boxes (normalized bbox [x,y,w,h]) + objectEvent publish.
     * @private
     */
    _processObjects(md, ctx, W, H, stroke, fontSize, pad) {
        if (!Array.isArray(md.objects)) return;

        for (const obj of md.objects) {
            if (!Array.isArray(obj.bbox) || obj.bbox.length !== 4) continue;
            const [x, y, w, h] = obj.bbox;
            const px = x * W, py = y * H, pw = w * W, ph = h * H;

            // Publish once per new tracked id (independent of the overlay toggle).
            if (this.messageQueue && this._isObjNew(obj.id)) {
                this._cropToJpeg(px, py, pw, ph).then((image) => {
                    this.messageQueue.publish('objectEvent', {
                        id: obj.id,
                        label: obj.label,
                        description: obj.description,
                        image
                    });
                });
            }

            if (this._overlayOn(this.showObjects, obj)) {
                ctx.lineWidth = stroke;
                ctx.strokeStyle = 'lime';
                ctx.strokeRect(px, py, pw, ph);
                if (obj.label) {
                    const textW = ctx.measureText(obj.label).width;
                    ctx.fillStyle = 'rgba(0,0,0,0.6)';
                    ctx.fillRect(px, py, textW + pad * 2, fontSize + pad * 2);
                    ctx.fillStyle = 'lime';
                    ctx.fillText(obj.label, px + pad, py + pad);
                }
            }
        }
    }

    /**
     * LPR plate quadrilaterals + ROI rectangle + lprEvent publish.
     * coordinates are 4 corner points in [0..1]; state is WAITING | DETECTING | HIT.
     * @private
     */
    _processLpr(md, ctx, W, H, stroke, fontSize, pad) {
        const lpr = md.lpr;
        if (!lpr) return;

        // Publish plate reads (independent of the overlay toggle), deduped by state+plate.
        if (this.messageQueue && (lpr.state === 'DETECTING' || lpr.state === 'HIT') && Array.isArray(lpr.results)) {
            for (const r of lpr.results) {
                if (!Array.isArray(r.coordinates) || r.coordinates.length !== 4) continue;
                // On HIT prefer the confirmed global plate; else this result's candidate.
                const plate = (lpr.state === 'HIT' && lpr.plate) ? lpr.plate : (r.plate || '');
                if (!plate || !this._isLprNew(lpr.state, plate)) continue;

                const xs = r.coordinates.map(p => p.x * W);
                const ys = r.coordinates.map(p => p.y * H);
                const cx = Math.min(...xs), cy = Math.min(...ys);
                const cw = Math.max(...xs) - cx, ch = Math.max(...ys) - cy;
                const evt = {
                    camname: md.camname, plate, state: lpr.state,
                    confidence: r.confidence, region: r.region, coordinates: r.coordinates
                };
                if (cw > 0 && ch > 0) {
                    this._cropToJpeg(cx, cy, cw, ch).then((image) => {
                        this.messageQueue.publish('lprEvent', Object.assign({}, evt, { image }));
                    });
                } else {
                    this.messageQueue.publish('lprEvent', Object.assign({}, evt, { image: null }));
                }
            }
        }

        // ROI rectangle (faint, dashed) — skip the trivial full-frame default.
        if (this._overlayEnabled(this.showLpr) && Array.isArray(lpr.roi) && lpr.roi.length === 4) {
            const [rx, ry, rw, rh] = lpr.roi;
            if (!(rx === 0 && ry === 0 && rw === 1 && rh === 1)) {
                ctx.save();
                ctx.lineWidth = Math.max(1, Math.round(stroke / 2));
                ctx.strokeStyle = 'rgba(255,255,255,0.6)';
                ctx.setLineDash([Math.max(4, stroke * 2), Math.max(4, stroke * 2)]);
                ctx.strokeRect(rx * W, ry * H, rw * W, rh * H);
                ctx.restore();
            }
        }

        // Plate quads + labels.
        if (Array.isArray(lpr.results) && lpr.results.length) {
            const color = lpr.state === 'HIT' ? 'red' : 'yellow';
            for (const r of lpr.results) {
                if (!Array.isArray(r.coordinates) || r.coordinates.length !== 4) continue;
                if (!this._overlayOn(this.showLpr, r)) continue;

                ctx.lineWidth = stroke;
                ctx.strokeStyle = color;
                ctx.beginPath();
                for (let i = 0; i < 4; i++) {
                    const p = r.coordinates[i];
                    const ppx = p.x * W, ppy = p.y * H;
                    if (i === 0) ctx.moveTo(ppx, ppy);
                    else ctx.lineTo(ppx, ppy);
                }
                ctx.closePath();
                ctx.stroke();

                const text = (lpr.state === 'HIT' && lpr.plate) ? lpr.plate : (r.plate || '');
                if (text) {
                    const xs = r.coordinates.map(p => p.x * W);
                    const ys = r.coordinates.map(p => p.y * H);
                    const minX = Math.min(...xs), minY = Math.min(...ys);
                    const textW = ctx.measureText(text).width;
                    const labelY = Math.max(0, minY - fontSize - pad * 2);
                    ctx.fillStyle = 'rgba(0,0,0,0.6)';
                    ctx.fillRect(minX, labelY, textW + pad * 2, fontSize + pad * 2);
                    ctx.fillStyle = color;
                    ctx.fillText(text, minX + pad, labelY + pad);
                }
            }
        }
    }

    /**
     * POS register text: posEvent publish (on change) + receipt-style panel.
     * md.pos is an array of { terminal, name, lines:[...] }.
     * @private
     */
    _processPos(md, ctx, W, H) {
        const pos = md.pos;
        if (!Array.isArray(pos) || !pos.length) return;

        // Publish only when the register text changes (independent of the toggle).
        if (this.messageQueue) {
            const posJson = JSON.stringify(pos);
            if (posJson !== this._lastPosJson) {
                this._lastPosJson = posJson;
                this.messageQueue.publish('posEvent', { camname: md.camname, pos });
            }
        }

        if (!this._overlayEnabled(this.showPos)) return;

        // Receipt-style panel, top-right. Monospace preserves POS column alignment.
        ctx.save();
        const fs = Math.max(11, Math.round(W / 90));
        const lineH = Math.round(fs * 1.3);
        const boxPad = Math.max(4, Math.round(fs / 2));
        ctx.font = `${fs}px monospace`;
        ctx.textBaseline = 'top';

        const rows = [];
        for (const reg of pos) {
            const term = (reg.terminal !== undefined && reg.terminal !== null) ? ` [${reg.terminal}]` : '';
            rows.push({ text: (reg.name || 'POS') + term, header: true });
            if (Array.isArray(reg.lines)) {
                for (const l of reg.lines) rows.push({ text: String(l), header: false });
            }
            rows.push({ text: '', header: false }); // spacer between registers
        }
        if (rows.length && rows[rows.length - 1].text === '') rows.pop();

        let maxW = 0;
        for (const r of rows) maxW = Math.max(maxW, ctx.measureText(r.text).width);
        const boxW = maxW + boxPad * 2;
        const boxH = rows.length * lineH + boxPad * 2;
        const bx = Math.max(0, W - boxW - boxPad);
        const by = boxPad;

        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(bx, by, boxW, boxH);

        let ty = by + boxPad;
        for (const r of rows) {
            ctx.fillStyle = r.header ? '#0ff' : '#fff';
            ctx.fillText(r.text, bx + boxPad, ty);
            ty += lineH;
        }
        ctx.restore();
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

        // Reset frame timing state for fresh start
        // Note: pumpingCheckDone stays as-is since preference is persisted in localStorage
        this.frameTimings = [];
        this.lastFrameTime = null;

        // Reset metadata dedup state so a fresh stream starts clean
        this.objIds = [];
        this._lprSeen = [];
        this._lastPosJson = null;
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
