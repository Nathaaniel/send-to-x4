/**
 * Image Utils
 * Fetches, optimizes, and embeds images into EPUBs.
 *
 * Runs in the background service worker (Chrome MV3) / background page (Firefox),
 * which has the <all_urls> host permission, so cross-origin image fetches are allowed.
 *
 * For the Xteink X4 (480x800, 4.3" e-ink) images are converted to grayscale and
 * downscaled to keep EPUBs small and fast to render. If OffscreenCanvas/createImageBitmap
 * is unavailable (or decoding fails), the original image bytes are embedded as-is.
 */
const ImageUtils = {
    config: {
        grayscale: true,
        grayscaleGamma: 0.85, // <1 lightens midtones (keeps pure black/white); 1 = no change
        maxDimension: 800,   // px, longest side for inline images. X4 panel is 480x800.
        coverSize: { width: 480, height: 400 }, // landscape cover, 6:5 to match the library thumbnail slot
        jpegQuality: 0.7,
        maxImages: 50,       // safety cap on embedded images per article
        fetchTimeoutMs: 15000
    },

    /** True if we can decode + re-encode images in this context. */
    canProcess() {
        return typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap === 'function';
    },

    /**
     * Convert a 2D canvas context to grayscale in place (Rec. 601 luma),
     * with an optional gamma lift (config.grayscaleGamma < 1) to lighten midtones.
     */
    applyGrayscale(ctx, w, h) {
        const gamma = this.config.grayscaleGamma || 1;
        let lut = null;
        if (gamma !== 1) {
            lut = new Uint8Array(256);
            for (let i = 0; i < 256; i++) {
                lut[i] = Math.round(255 * Math.pow(i / 255, gamma));
            }
        }
        const imgData = ctx.getImageData(0, 0, w, h);
        const d = imgData.data;
        for (let i = 0; i < d.length; i += 4) {
            let lum = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
            if (lut) lum = lut[lum];
            d[i] = d[i + 1] = d[i + 2] = lum;
        }
        ctx.putImageData(imgData, 0, 0);
    },

    /** Embed the original bytes unchanged (used when canvas processing is unavailable). */
    rawResult(blob) {
        const mediaType = /^image\//i.test(blob.type) ? blob.type : 'image/jpeg';
        return { blob, mediaType, ext: this.mediaTypeToExt(mediaType) };
    },

    mediaTypeToExt(type) {
        const map = {
            'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
            'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg'
        };
        return map[(type || '').toLowerCase()] || 'jpg';
    },

    /** Fetch a URL (http/https/data:) and return its Blob, or throw. */
    async fetchBlob(url) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.config.fetchTimeoutMs);
        try {
            const resp = await fetch(url, { signal: controller.signal, credentials: 'omit' });
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            const blob = await resp.blob();
            if (!blob || blob.size === 0) throw new Error('empty body');
            return blob;
        } finally {
            clearTimeout(timer);
        }
    },

    /**
     * Optimize an image Blob for e-ink: downscale + (optionally) grayscale + JPEG re-encode.
     * Falls back to the original bytes when canvas processing is unavailable or fails.
     * @returns {Promise<{ blob: Blob, mediaType: string, ext: string }>}
     */
    async processBlob(blob, opts = {}) {
        const cfg = { ...this.config, ...opts };

        if (this.canProcess()) {
            try {
                const bitmap = await createImageBitmap(blob);
                const w = bitmap.width, h = bitmap.height;
                if (w < 2 || h < 2) {
                    if (bitmap.close) bitmap.close();
                    throw new Error('image too small (likely a tracking pixel)');
                }

                const scale = Math.min(1, cfg.maxDimension / Math.max(w, h));
                const ow = Math.max(1, Math.round(w * scale));
                const oh = Math.max(1, Math.round(h * scale));

                const canvas = new OffscreenCanvas(ow, oh);
                const ctx = canvas.getContext('2d');
                // Flatten transparency onto white (e-ink has no alpha)
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, ow, oh);
                ctx.drawImage(bitmap, 0, 0, ow, oh);
                if (bitmap.close) bitmap.close();

                if (cfg.grayscale) this.applyGrayscale(ctx, ow, oh);

                const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: cfg.jpegQuality });
                return { blob: out, mediaType: 'image/jpeg', ext: 'jpg' };
            } catch (e) {
                console.warn('[ImageUtils] processing failed, embedding original:', e.message);
            }
        }

        return this.rawResult(blob);
    },

    /**
     * Optimize an image for use as the EPUB cover: scale to *fill* the library
     * thumbnail frame (object-fit: cover) and center-crop to coverSize, then
     * grayscale + JPEG. Falls back to the original bytes when canvas processing
     * is unavailable or fails.
     * @returns {Promise<{ blob: Blob, mediaType: string, ext: string }>}
     */
    async processCover(blob) {
        const cfg = this.config;

        if (this.canProcess()) {
            try {
                const bitmap = await createImageBitmap(blob);
                const w = bitmap.width, h = bitmap.height;
                if (w < 2 || h < 2) {
                    if (bitmap.close) bitmap.close();
                    throw new Error('cover image too small');
                }

                const tw = cfg.coverSize.width, th = cfg.coverSize.height;
                // "cover" fit: scale so the image fully covers the frame, center, crop overflow
                const scale = Math.max(tw / w, th / h);
                const sw = w * scale, sh = h * scale;
                const dx = (tw - sw) / 2;
                const dy = (th - sh) / 2;

                const canvas = new OffscreenCanvas(tw, th);
                const ctx = canvas.getContext('2d');
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, tw, th);
                ctx.drawImage(bitmap, dx, dy, sw, sh); // overflow is clipped by the canvas bounds
                if (bitmap.close) bitmap.close();

                if (cfg.grayscale) this.applyGrayscale(ctx, tw, th);

                const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: cfg.jpegQuality });
                return { blob: out, mediaType: 'image/jpeg', ext: 'jpg' };
            } catch (e) {
                console.warn('[ImageUtils] cover processing failed, embedding original:', e.message);
            }
        }

        return this.rawResult(blob);
    },

    /** Fetch + optimize a single remote image. Returns null on failure. */
    async prepareRemoteImage(url, opts = {}) {
        try {
            const blob = await this.fetchBlob(url);
            return await this.processBlob(blob, opts);
        } catch (e) {
            console.warn('[ImageUtils] failed to prepare image:', url, '-', e.message);
            return null;
        }
    },

    /** Fetch + shape a remote image into a portrait cover. Returns null on failure. */
    async prepareRemoteCover(url) {
        try {
            const blob = await this.fetchBlob(url);
            return await this.processCover(blob);
        } catch (e) {
            console.warn('[ImageUtils] failed to prepare cover:', url, '-', e.message);
            return null;
        }
    },

    // --- HTML <img> helpers (string-based; the service worker has no DOM) -----

    getAttr(tag, name) {
        const m = tag.match(new RegExp(name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')', 'i'));
        if (!m) return null;
        return m[2] !== undefined ? m[2] : m[3];
    },

    firstSrcsetUrl(srcset) {
        if (!srcset) return null;
        const first = srcset.split(',')[0].trim().split(/\s+/)[0];
        return first || null;
    },

    /** Pick the best source URL from an <img> tag, including common lazy-load attrs. */
    pickSrc(tag) {
        return this.getAttr(tag, 'src')
            || this.getAttr(tag, 'data-src')
            || this.getAttr(tag, 'data-original')
            || this.getAttr(tag, 'data-lazy-src')
            || this.firstSrcsetUrl(this.getAttr(tag, 'srcset'))
            || this.firstSrcsetUrl(this.getAttr(tag, 'data-srcset'));
    },

    resolveUrl(src, baseUrl) {
        try { return new URL(src, baseUrl).href; } catch (e) { return src; }
    },

    decodeEntities(s) {
        return s ? s.replace(/&amp;/g, '&').replace(/&#0*38;/g, '&') : s;
    },

    escapeAttr(s) {
        return String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    },

    /**
     * Find every <img> in the body, download + optimize each, write it into the zip,
     * and rewrite the tag to point at the embedded local file.
     * Duplicate URLs are stored once. Images that fail to load are dropped.
     *
     * @param {string} body - article HTML (with absolute or resolvable img src)
     * @param {string} baseUrl - page URL, used to resolve relative src
     * @param {JSZip} zip - the EPUB zip being built
     * @returns {Promise<{ body: string, images: Array<{id,href,mediaType}> }>}
     */
    async embedBodyImages(body, baseUrl, zip) {
        if (!body || !/<img/i.test(body)) return { body, images: [] };

        // Replace each <img ...> with a unique token so async work can't disturb indices.
        const tasks = [];
        const tokenized = body.replace(/<img\b[^>]*>/gi, (tag) => {
            const token = `@@X4IMG${tasks.length}@@`;
            tasks.push({ token, tag });
            return token;
        });

        const images = [];
        const urlToHref = new Map();
        const replacements = {};
        let fileCounter = 0;

        for (const { token, tag } of tasks) {
            let rawSrc = this.pickSrc(tag);
            const alt = this.decodeEntities(this.getAttr(tag, 'alt') || '');

            if (!rawSrc) { replacements[token] = ''; continue; }
            rawSrc = this.decodeEntities(rawSrc.trim());
            const url = this.resolveUrl(rawSrc, baseUrl);

            let href = urlToHref.get(url);
            if (!href) {
                if (images.length >= this.config.maxImages) { replacements[token] = ''; continue; }
                const prep = await this.prepareRemoteImage(url);
                if (!prep) { replacements[token] = ''; continue; }
                fileCounter++;
                const filename = `img${fileCounter}.${prep.ext}`;
                zip.file('OEBPS/images/' + filename, prep.blob);
                href = 'images/' + filename;
                urlToHref.set(url, href);
                images.push({ id: `img${fileCounter}`, href, mediaType: prep.mediaType });
            }

            const altAttr = alt ? ` alt="${this.escapeAttr(alt)}"` : '';
            replacements[token] = `<img src="${href}"${altAttr} />`;
        }

        let out = tokenized;
        for (const { token } of tasks) {
            out = out.split(token).join(replacements[token] ?? '');
        }
        return { body: out, images };
    }
};

// Attach to global scope (self in service worker, window in background page)
if (typeof self !== 'undefined') {
    self.ImageUtils = ImageUtils;
} else if (typeof window !== 'undefined') {
    window.ImageUtils = ImageUtils;
}
