/**
 * X4 Send - Service Worker (Background Script)
 * Handles EPUB generation, X4 upload, and download fallback
 */

// Cross-browser compatibility
// Cross-browser compatibility
// browserAPI is defined in settings.js, which is loaded before this script in manifest.json
// const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

// Import required modules (paths relative to service worker location in src/background/)
// Import required modules
// Note: In Firefox 'scripts' (Background Page), these are loaded via manifest.json.
// In Chrome 'service_worker', importScripts works and is required.
if (typeof importScripts === 'function') {
    try {
        importScripts(
            '../epub/jszip.min.js',
            '../utils/logger.js',
            '../utils/sanitize.js',
            '../epub/epub_templates.js',
            '../epub/image_processor.js',
            '../epub/epub_builder.js',
            '../upload/x4_upload_tab.js',
            '../upload/crosspoint_upload.js',
            '../utils/settings.js'
        );
    } catch (e) {
        console.error('[X4 SW] importScripts failed:', e);
    }
}

console.log('[X4 Service Worker] Initialized');

// Message handler
browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'X4_SEND_ARTICLE') {
        handleSendArticle(message, sender, sendResponse);
        return true; // Keep channel open for async response
    }

    if (message.type === 'X4_DOWNLOAD_ARTICLE') {
        handleDownloadArticle(message.payload, sendResponse);
        return true;
    }

    if (message.type === 'X4_DOWNLOAD_EPUB') {
        handleDownloadEpub(message.payload)
            .then(result => sendResponse(result))
            .catch(error => sendResponse({
                success: false,
                error: error.message
            }));
        return true;
    }

    if (message.type === 'X4_FETCH') {
        handleFetch(message.payload)
            .then(result => sendResponse(result))
            .catch(error => sendResponse({
                success: false,
                error: error.message
            }));
        return true;
    }
});

/**
 * Handle fetch proxy (to bypass CORS/Mixed Content in popup)
 */
async function handleFetch(payload) {
    const { url, options } = payload;
    console.log('[X4 SW] Proxy fetch:', url, options?.method || 'GET');

    // Firefox Fallback: Use XMLHttpRequest to bypass potential Mixed Content/Fetch quirks
    if (typeof XMLHttpRequest !== 'undefined') {
        console.log('[X4 SW] Using XMLHttpRequest (Firefox compat mode)');
        return new Promise((resolve) => {
            const xhr = new XMLHttpRequest();
            xhr.open(options?.method || 'GET', url, true);

            // Set headers
            if (options?.headers) {
                for (const [key, value] of Object.entries(options.headers)) {
                    xhr.setRequestHeader(key, value);
                }
            }

            xhr.onload = function () {
                const success = xhr.status >= 200 && xhr.status < 300;
                // Parse body logic simplified
                let data = xhr.responseText;
                try {
                    data = JSON.parse(data);
                } catch (e) {
                    // Start is not JSON, keep as text
                }

                resolve({
                    success: success,
                    status: xhr.status,
                    statusText: xhr.statusText,
                    data: data
                });
            };

            xhr.onerror = function () {
                console.error('[X4 SW] XHR Error');
                resolve({
                    success: false,
                    error: 'Network Request Failed (XHR)'
                });
            };

            xhr.ontimeout = function () {
                resolve({
                    success: false,
                    error: 'Timeout'
                });
            };

            if (options?.body) {
                xhr.send(options.body);
            } else {
                xhr.send();
            }
        });
    }

    // Chrome / Service Worker: Use fetch
    try {
        const response = await fetch(url, options);

        // We need to read the body to send it back
        const contentType = response.headers.get('content-type');
        let data;

        if (contentType && contentType.includes('application/json')) {
            data = await response.json();
        } else {
            data = await response.text();
        }

        return {
            success: response.ok,
            status: response.status,
            statusText: response.statusText,
            data: data
        };
    } catch (error) {
        console.error('[X4 SW] Fetch error:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Whether article images should be embedded, defaulting to on if the setting
 * cannot be read.
 * @returns {Promise<boolean>}
 */
async function shouldIncludeImages() {
    try {
        return await Settings.getIncludeImages();
    } catch (error) {
        console.warn('[X4 SW] Could not read image setting, defaulting to on:', error);
        return true;
    }
}

/**
 * Handle download article request (generate EPUB and download locally)
 */
async function handleDownloadArticle(article, sendResponse) {
    console.log('[X4 SW] Handling download article:', article.title);

    try {
        // Generate EPUB - returns a Blob
        const epubBlob = await EpubBuilder.build(article, {
            includeImages: await shouldIncludeImages()
        });

        if (!epubBlob || !(epubBlob instanceof Blob)) {
            throw new Error('EPUB generation failed');
        }

        const filename = EpubBuilder.generateFilename(article);
        const arrayBuffer = await EpubBuilder.blobToArrayBuffer(epubBlob);

        console.log('[X4 SW] EPUB generated for download:', filename, 'size:', arrayBuffer.byteLength);

        // Download the EPUB
        await downloadEpubFallback(arrayBuffer, filename);

        sendResponse({ success: true, message: 'Downloaded!' });

    } catch (error) {
        console.error('[X4 SW] Download error:', error);
        sendResponse({ success: false, error: error.message });
    }
}

/**
 * Send status update to popup
 */
async function sendStatusUpdate(sender, status, message) {
    try {
        // Send to runtime (reaches popup)
        await browserAPI.runtime.sendMessage({
            type: 'X4_STATUS_UPDATE',
            status: status,
            message: message
        });
    } catch (e) {
        // Ignore errors (popup might be closed)
        // console.log('[X4 SW] internal message error:', e.message);
    }
}

async function logToPopup(message) {
    try {
        await chrome.runtime.sendMessage({
            type: 'X4_DEBUG_LOG',
            message: message
        });
    } catch (e) { /* ignore */ }
}

/**
 * Handle send article request
 * Strategy: Try upload first, download as fallback
 */
async function handleSendArticle(messageData, sender, sendResponse) {
    const article = messageData.payload;
    const settings = messageData.settings || {};
    const tabId = sender.tab?.id;
    console.log('[X4 SW] Handling send article:', article.title);
    console.log('[X4 SW] Settings:', settings);

    try {
        await logToPopup(`Starting Send Article: ${article.title}`);

        // Step 1: Generate EPUB
        if (tabId) await sendStatusUpdate(sender, 'generating', 'Creating EPUB...');
        await logToPopup('Generating EPUB...');

        const epubBlob = await EpubBuilder.build(article, {
            includeImages: settings.includeImages !== undefined
                ? settings.includeImages
                : await shouldIncludeImages()
        });
        const filename = EpubBuilder.generateFilename(article);
        const arrayBuffer = await EpubBuilder.blobToArrayBuffer(epubBlob);

        await logToPopup(`EPUB generated: ${filename} (${arrayBuffer.byteLength} bytes)`);

        // Step 2: Choose uploader based on settings
        const isCrosspoint = settings.firmwareType === 'crosspoint';
        const deviceIp = settings.deviceIp || (isCrosspoint ? '192.168.4.1' : '192.168.3.3');

        const uploader = isCrosspoint ? CrossPointUpload : X4UploadTab;
        const apiName = isCrosspoint ? 'CrossPoint' : 'standard X4';

        await logToPopup(`Configuring ${apiName} with IP: ${deviceIp}`);

        if (isCrosspoint) {
            CrossPointUpload.setIp(deviceIp);
        } else {
            if (typeof X4UploadTab.setIp === 'function') {
                X4UploadTab.setIp(deviceIp);
            }
        }

        // Step 3: Upload
        if (tabId) await sendStatusUpdate(sender, 'uploading', 'Sending to X4...');
        await logToPopup(`Attempting upload to ${deviceIp}...`);

        const uploadResult = await uploader.uploadEpub(arrayBuffer, filename);
        await logToPopup(`Upload result: ${JSON.stringify(uploadResult)}`);

        if (uploadResult.success) {
            await logToPopup('Upload successful!');
            sendResponse({
                success: true,
                message: 'Sent to X4!'
            });
            return;
        }

        // Step 3: Fallback
        await logToPopup(`Upload failed (${uploadResult.error}), falling back to download.`);
        if (tabId) await sendStatusUpdate(sender, 'downloading', 'Downloading (X4 upload failed)...');

        await downloadEpubFallback(arrayBuffer, filename);

        sendResponse({
            success: true,
            message: '📥 EPUB downloaded',
            downloadTriggered: true,
            uploadError: uploadResult.error
        });

    } catch (error) {
        await logToPopup(`Error: ${error.message}`);
        console.error('[X4 SW] Error:', error);
        sendResponse({
            success: false,
            error: error.message
        });
    }
}

/**
 * Trigger the download of a generated EPUB.
 *
 * Chrome MV3 service workers have no URL.createObjectURL, so the bytes travel
 * as a data URL there; Firefox background scripts do have it and a blob URL
 * keeps large books off the base64 detour. The choice is made by feature
 * detection rather than by sniffing the browser.
 *
 * @param {ArrayBuffer} arrayBuffer - EPUB bytes
 * @param {string} filename - Sanitized filename, including the .epub extension
 * @returns {Promise<number>} - The download id
 */
async function downloadEpubFallback(arrayBuffer, filename) {
    const canUseObjectUrl = typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function';
    let downloadUrl;

    if (canUseObjectUrl) {
        console.log('[X4 SW] Using Blob URL for download...');
        downloadUrl = URL.createObjectURL(new Blob([arrayBuffer], { type: 'application/epub+zip' }));
    } else {
        console.log('[X4 SW] Using data URL for download...');
        downloadUrl = arrayBufferToDataUrl(arrayBuffer);
    }

    try {
        let downloadId;

        try {
            downloadId = await browserAPI.downloads.download({
                url: downloadUrl,
                filename: filename,
                saveAs: false
            });
        } catch (error) {
            // downloads.download() rejects the whole request when the filename
            // is not acceptable to the platform. Rather than losing the book,
            // retry once with a name that cannot be rejected.
            const fallbackName = buildFallbackFilename(filename);
            console.warn(`[X4 SW] Download rejected for "${filename}" (${error.message}), retrying as "${fallbackName}"`);

            downloadId = await browserAPI.downloads.download({
                url: downloadUrl,
                filename: fallbackName,
                saveAs: false
            });
        }

        console.log('[X4 SW] Download started, ID:', downloadId);

        // The API resolves as soon as the download starts, so wait for the
        // final state: an interrupted download must not be reported as a
        // success to the popup.
        const finalState = await waitForDownload(downloadId);
        if (finalState && finalState.state === 'interrupted') {
            throw new Error(`Download interrupted (${finalState.error || 'unknown reason'})`);
        }

        console.log('[X4 SW] Download finished:', filename);
        return downloadId;
    } finally {
        if (canUseObjectUrl) {
            URL.revokeObjectURL(downloadUrl);
        }
    }
}

/**
 * Encode EPUB bytes as a base64 data URL (Chrome MV3 service worker path).
 * @param {ArrayBuffer} arrayBuffer
 * @returns {string}
 */
function arrayBufferToDataUrl(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const CHUNK = 0x8000;
    let binary = '';

    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }

    return `data:application/epub+zip;base64,${btoa(binary)}`;
}

/**
 * Last-resort filename, used when the platform rejects the generated one.
 * @param {string} filename
 * @returns {string}
 */
function buildFallbackFilename(filename) {
    const stem = (filename || '')
        .replace(/\.epub$/i, '')
        .replace(/[^\w \-]+/g, '')
        .trim()
        .substring(0, 40)
        .replace(/^[.\s]+|[.\s]+$/g, '');

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];

    return `${stem || 'article'} - ${stamp}.epub`;
}

/**
 * Resolve once a download reaches a terminal state.
 * Resolves with null if nothing is reported in time; a slow download is not
 * treated as a failure.
 * @param {number} downloadId
 * @param {number} timeoutMs
 * @returns {Promise<{state: string, error: string|null}|null>}
 */
function waitForDownload(downloadId, timeoutMs = 20000) {
    return new Promise(resolve => {
        let settled = false;

        const finish = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            browserAPI.downloads.onChanged.removeListener(onChanged);
            resolve(result);
        };

        const onChanged = (delta) => {
            if (delta.id !== downloadId) return;
            if (delta.state && delta.state.current !== 'in_progress') {
                finish({
                    state: delta.state.current,
                    error: delta.error ? delta.error.current : null
                });
            }
        };

        const timer = setTimeout(() => finish(null), timeoutMs);
        browserAPI.downloads.onChanged.addListener(onChanged);

        // The download may already be finished by the time the listener is up.
        try {
            Promise.resolve(browserAPI.downloads.search({ id: downloadId })).then(items => {
                const item = items && items[0];
                if (item && item.state !== 'in_progress') {
                    finish({ state: item.state, error: item.error || null });
                }
            }).catch(() => { /* the listener still covers us */ });
        } catch (e) {
            // the listener still covers us
        }
    });
}

/**
 * Handle direct download request (for popup action)
 */
async function handleDownloadEpub(payload) {
    const { article } = payload;

    const epubBlob = await EpubBuilder.build(article, {
        includeImages: await shouldIncludeImages()
    });
    const filename = EpubBuilder.generateFilename(article);
    const arrayBuffer = await EpubBuilder.blobToArrayBuffer(epubBlob);

    await downloadEpubFallback(arrayBuffer, filename);

    return { success: true, filename };
}

console.log('[X4 Service Worker] Ready');
