/**
 * Image Processor
 *
 * Turns the remote images an article references into small, self-contained
 * files inside the EPUB. Nothing here reaches the network at reading time:
 * every image that survives is downscaled, converted to grayscale, re-encoded
 * as JPEG and written into the book, and every image that cannot be fetched or
 * decoded is dropped rather than left as a broken remote reference.
 *
 * Runs in the background context (service worker or background page), which is
 * the only place with both host permissions for cross-origin fetches and a
 * canvas to resize with.
 */
const ImageProcessor = {
    /** Widest an image gets on the X4's panel; larger ones are downscaled. */
    MAX_WIDTH: 800,

    /** Images below this on either axis are icons, spacers or tracking pixels. */
    MIN_DIMENSION: 64,

    /** Caps, so a photo-heavy page cannot produce an unusable book. */
    MAX_IMAGES: 30,
    MAX_SOURCE_BYTES: 8 * 1024 * 1024,
    MAX_TOTAL_BYTES: 6 * 1024 * 1024,

    /** Grayscale JPEG is the smallest thing an e-ink panel renders well. */
    JPEG_QUALITY: 0.72,
    OUTPUT_MEDIA_TYPE: 'image/jpeg',

    FETCH_TIMEOUT_MS: 8000,

    /**
     * Whether this context can decode and re-encode images at all.
     * @returns {boolean}
     */
    isSupported() {
        if (typeof createImageBitmap !== 'function') return false;
        return typeof OffscreenCanvas === 'function' ||
            (typeof document !== 'undefined' && typeof document.createElement === 'function');
    },

    /**
     * Fetch, shrink and embed every image referenced by an article body.
     *
     * @param {string} html - Article body, with absolute image URLs
     * @returns {Promise<{html: string, images: Array<{id: string, href: string, mediaType: string, data: ArrayBuffer}>}>}
     */
    async processBody(html) {
        const images = [];

        if (!html || !this.isSupported()) {
            return { html: html || '', images };
        }

        // One entry per distinct source URL, so a repeated image is fetched,
        // converted and stored once.
        const bySource = new Map();
        let totalBytes = 0;

        const tags = html.match(/<img\b[^>]*>/gi) || [];
        for (const tag of tags) {
            const url = this.readAttribute(tag, 'src');
            if (!url || bySource.has(url)) continue;

            if (bySource.size >= this.MAX_IMAGES) {
                console.log('[ImageProcessor] Image limit reached, skipping the rest');
                break;
            }
            if (totalBytes >= this.MAX_TOTAL_BYTES) {
                console.log('[ImageProcessor] Size budget reached, skipping the rest');
                break;
            }

            const converted = await this.fetchAndConvert(url);
            if (!converted) {
                bySource.set(url, null);
                continue;
            }

            const id = `img-${images.length + 1}`;
            const image = {
                id,
                href: `images/${id}.jpg`,
                mediaType: this.OUTPUT_MEDIA_TYPE,
                data: converted.data
            };

            totalBytes += converted.data.byteLength;
            images.push(image);
            bySource.set(url, image);
        }

        // Rewrite each tag to point at the embedded copy, or remove it.
        const rewritten = html.replace(/<img\b[^>]*>/gi, (tag) => {
            const url = this.readAttribute(tag, 'src');
            const image = url ? bySource.get(url) : null;
            if (!image) return '';

            const alt = this.readAttribute(tag, 'alt');
            const altAttr = alt ? ` alt="${this.escapeAttribute(alt)}"` : '';

            return `<img src="${image.href}"${altAttr} />`;
        });

        console.log(`[ImageProcessor] Embedded ${images.length} image(s), ${(totalBytes / 1024).toFixed(0)}KB`);

        return { html: rewritten, images };
    },

    /**
     * Fetch one image and convert it for the X4. Returns null for anything
     * that cannot be retrieved, decoded, or is too small to be worth keeping.
     * @param {string} url
     * @returns {Promise<{data: ArrayBuffer, width: number, height: number}|null>}
     */
    async fetchAndConvert(url) {
        try {
            const blob = await this.fetchImage(url);
            if (!blob) return null;

            if (blob.size > this.MAX_SOURCE_BYTES) {
                console.log('[ImageProcessor] Skipping oversized source:', url, blob.size);
                return null;
            }

            return await this.shrinkForEink(blob);
        } catch (error) {
            console.log('[ImageProcessor] Skipping image:', url, error.message);
            return null;
        }
    },

    /**
     * Fetch an image, preferring the HTTP cache.
     *
     * The documented workflow has the reader load the article online and then
     * switch to the X4's hotspot before sending, so there is often no route to
     * the internet by the time this runs. The page's own cache is no help: an
     * extension fetch uses a separate cache partition, so a first attempt made
     * on the hotspot fails and the image is dropped. What force-cache does buy
     * is the second attempt - once this extension has fetched an image, a later
     * build of the same article embeds it with no network at all, which is why
     * downloading an article online and then sending it on the hotspot keeps
     * its images.
     * @param {string} url
     * @returns {Promise<Blob|null>}
     */
    async fetchImage(url) {
        const attempt = async (cache) => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), this.FETCH_TIMEOUT_MS);

            try {
                const response = await fetch(url, { cache, signal: controller.signal });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return await response.blob();
            } finally {
                clearTimeout(timer);
            }
        };

        try {
            return await attempt('force-cache');
        } catch (error) {
            return await attempt('default');
        }
    },

    /**
     * Downscale to MAX_WIDTH, flatten onto white, convert to grayscale and
     * re-encode as JPEG.
     * @param {Blob} blob
     * @returns {Promise<{data: ArrayBuffer, width: number, height: number}|null>}
     */
    async shrinkForEink(blob) {
        const bitmap = await createImageBitmap(blob);

        try {
            if (bitmap.width < this.MIN_DIMENSION || bitmap.height < this.MIN_DIMENSION) {
                return null;
            }

            const scale = Math.min(1, this.MAX_WIDTH / bitmap.width);
            const width = Math.max(1, Math.round(bitmap.width * scale));
            const height = Math.max(1, Math.round(bitmap.height * scale));

            const canvas = this.createCanvas(width, height);
            const ctx = canvas.getContext('2d');

            // JPEG has no alpha channel, so flatten transparency onto white
            // rather than letting it come out black.
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, width, height);
            ctx.drawImage(bitmap, 0, 0, width, height);

            const frame = ctx.getImageData(0, 0, width, height);
            const pixels = frame.data;
            for (let i = 0; i < pixels.length; i += 4) {
                const luma = (pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114) | 0;
                pixels[i] = luma;
                pixels[i + 1] = luma;
                pixels[i + 2] = luma;
            }
            ctx.putImageData(frame, 0, 0);

            const encoded = await this.canvasToBlob(canvas);
            const data = await encoded.arrayBuffer();

            return { data, width, height };
        } finally {
            if (typeof bitmap.close === 'function') bitmap.close();
        }
    },

    /**
     * OffscreenCanvas in a service worker, a DOM canvas in a background page.
     * @param {number} width
     * @param {number} height
     */
    createCanvas(width, height) {
        if (typeof OffscreenCanvas === 'function') {
            return new OffscreenCanvas(width, height);
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        return canvas;
    },

    /**
     * @param {OffscreenCanvas|HTMLCanvasElement} canvas
     * @returns {Promise<Blob>}
     */
    canvasToBlob(canvas) {
        if (typeof canvas.convertToBlob === 'function') {
            return canvas.convertToBlob({ type: this.OUTPUT_MEDIA_TYPE, quality: this.JPEG_QUALITY });
        }

        return new Promise((resolve, reject) => {
            canvas.toBlob(
                blob => blob ? resolve(blob) : reject(new Error('Canvas encoding failed')),
                this.OUTPUT_MEDIA_TYPE,
                this.JPEG_QUALITY
            );
        });
    },

    /**
     * Read one attribute out of a tag string.
     * @param {string} tag
     * @param {string} name
     * @returns {string|null}
     */
    readAttribute(tag, name) {
        const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
        if (!match) return null;

        const value = match[1] !== undefined ? match[1] : match[2];
        return this.decodeEntities(value).trim() || null;
    },

    /**
     * Attribute values arrive XML-escaped (query strings routinely carry
     * &amp;), and fetch needs the original URL.
     * @param {string} value
     * @returns {string}
     */
    decodeEntities(value) {
        return String(value)
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&apos;/g, "'")
            .replace(/&#(\d+);/g, (m, code) => String.fromCharCode(parseInt(code, 10)))
            .replace(/&amp;/g, '&');
    },

    /**
     * @param {string} value
     * @returns {string}
     */
    escapeAttribute(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }
};
