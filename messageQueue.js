/**
 * messageQueue.js - Tiny pub/sub event bus for WSPlayer metadata
 *
 * A dependency-free publish/subscribe bus. Pass one MessageQueue instance to one
 * or more WSPlayer instances (via the `messageQueue` option) and the player(s)
 * will publish structured analytics events as they arrive on the video WebSocket:
 *
 *   - 'lprEvent'    license plate reads      { camname, plate, state, confidence, region, coordinates, image }
 *   - 'objectEvent' object detections        { id, label, description, image }
 *   - 'posEvent'    point-of-sale register   { camname, pos:[{ terminal, name, lines:[...] }] }
 *
 * A single queue can aggregate events from every camera on the page, giving a
 * 3rd-party integration one place to subscribe for all license-plate / object /
 * POS data. Event emission is independent of the on-screen overlay toggles, so
 * you can receive the data while hiding the boxes.
 *
 * @example
 * ```javascript
 * const mq = new MessageQueue();
 * mq.subscribe('lprEvent', (e) => {
 *     console.log('Plate:', e.plate, e.confidence, e.region);
 *     // e.image is a base64 data URL of the cropped plate (or null)
 * });
 * WSPlayer.create('cam1', { url, messageQueue: mq, showLpr: true });
 * ```
 *
 * @author Dividia Technologies
 * @version 1.0.0
 */

class MessageQueue {
    constructor() {
        this.subscribers = {}; // eventType -> [callbacks]
    }

    /**
     * Register a callback for an event type.
     * @param {string} eventType - e.g. 'lprEvent', 'objectEvent', 'posEvent'
     * @param {Function} callback - invoked with the event payload
     */
    subscribe(eventType, callback) {
        if (!this.subscribers[eventType]) {
            this.subscribers[eventType] = [];
        }
        this.subscribers[eventType].push(callback);
    }

    /**
     * Remove a previously registered callback.
     * @param {string} eventType
     * @param {Function} callback - the same reference passed to subscribe()
     */
    unsubscribe(eventType, callback) {
        if (this.subscribers[eventType]) {
            this.subscribers[eventType] = this.subscribers[eventType].filter(
                (cb) => cb !== callback
            );
        }
    }

    /**
     * Publish an event to all subscribers of that type.
     * @param {string} eventType
     * @param {*} data - payload passed to each subscriber
     */
    publish(eventType, data) {
        if (this.subscribers[eventType]) {
            this.subscribers[eventType].forEach((callback) => {
                try {
                    callback(data);
                } catch (e) {
                    console.error(`[MessageQueue] subscriber for '${eventType}' threw:`, e);
                }
            });
        }
    }
}

// Export for module usage
if (typeof module !== 'undefined' && module.exports) {
    module.exports = MessageQueue;
}
