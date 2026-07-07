/**
 * Browser WebSocket Client Hook for SAL BAN Monolith Engine MCP Server.
 * 
 * Integrates into salban.de to connect to the local WebSocket bridge at ws://localhost:8080.
 * Handles bidirectional state synchronization, full preset loading, and live parameter tweaks.
 */
(function() {
    let ws = null;
    let reconnectTimeout = null;
    let lastSentStateStr = null;
    
    // Web socket configuration
    const WS_URL = 'ws://localhost:8080';
    const SYNC_INTERVAL_MS = 2000;

    function connectWebSocket() {
        if (ws) {
            try {
                ws.close();
            } catch(e) {}
        }
        
        console.log(`[Groovebox MCP Bridge] Connecting to local server at ${WS_URL}...`);
        ws = new WebSocket(WS_URL);

        ws.onopen = () => {
            console.log('[Groovebox MCP Bridge] Connected successfully!');
            if (typeof statusConsole !== 'undefined') {
                statusConsole.innerText = '[SYSTEM] Local MCP WebSocket Bridge: CONNECTED';
            }
            // Send initial state synchronization
            syncState();
        };

        ws.onmessage = (event) => {
            try {
                const message = JSON.parse(event.data);
                if (!message) return;

                if (message.type === 'apply_preset') {
                    if (typeof applyPresetState === 'function') {
                        console.log('[Groovebox MCP Bridge] Applying full preset from MCP...');
                        applyPresetState(message.preset);
                        if (typeof statusConsole !== 'undefined') {
                            statusConsole.innerText = '[SYSTEM] Preset applied from local MCP';
                        }
                    } else {
                        console.warn('[Groovebox MCP Bridge] applyPresetState function not found!');
                    }
                } else if (message.type === 'tweak_parameter') {
                    if (typeof tweakParameterByPath === 'function') {
                        console.log(`[Groovebox MCP Bridge] Tweaking parameter: ${message.path} -> ${message.value}`);
                        tweakParameterByPath(message.path, message.value);
                    } else {
                        console.warn('[Groovebox MCP Bridge] tweakParameterByPath function not found!');
                    }
                }
            } catch (err) {
                console.error('[Groovebox MCP Bridge] Error parsing message:', err);
            }
        };

        ws.onclose = () => {
            console.log('[Groovebox MCP Bridge] Connection closed. Attempting reconnect in 5s...');
            if (typeof statusConsole !== 'undefined') {
                statusConsole.innerText = '[SYSTEM] Local MCP WebSocket Bridge: DISCONNECTED (retrying)';
            }
            scheduleReconnect();
        };

        ws.onerror = (err) => {
            console.error('[Groovebox MCP Bridge] WebSocket error encountered:', err);
        };
    }

    function scheduleReconnect() {
        if (reconnectTimeout) clearTimeout(reconnectTimeout);
        reconnectTimeout = setTimeout(() => {
            connectWebSocket();
        }, 5000);
    }

    function syncState() {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        if (typeof presetState === 'undefined') return;

        try {
            const stateStr = JSON.stringify(presetState);
            if (stateStr !== lastSentStateStr) {
                ws.send(JSON.stringify({
                    type: 'state_sync',
                    preset: presetState
                }));
                lastSentStateStr = stateStr;
                console.log('[Groovebox MCP Bridge] Synchronized state to local MCP cache');
            }
        } catch (e) {
            console.error('[Groovebox MCP Bridge] Failed to stringify state for synchronization:', e);
        }
    }

    // Run the synchronization loop
    setInterval(syncState, SYNC_INTERVAL_MS);

    // Initial launch on document ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', connectWebSocket);
    } else {
        connectWebSocket();
    }
})();
