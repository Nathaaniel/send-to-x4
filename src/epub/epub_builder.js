/**
 * EPUB Builder
 * Generates EPUB files from article/longpost data using JSZip
 */

// EpubBuilder will use the JSZip global from jszip.min.js (loaded via manifest)
const EpubBuilder = {
    /**
     * Generate EPUB blob from article data
     * @param {Object} article - { title, author, date, body, sourceUrl }
     * @param {Object} [options] - { includeImages }
     * @returns {Promise<Blob>} - EPUB blob
     */
    async build(article, options = {}) {
        // JSZip is available globally from jszip.min.js loaded by service worker
        if (typeof JSZip === 'undefined') {
            throw new Error('JSZip not loaded');
        }

        const zip = new JSZip();
        const uuid = this.generateUuid();

        // Fetch, downscale and embed the article's images, so the book reads
        // the same offline. Anything that cannot be retrieved is dropped, and
        // the article still builds.
        let body = article.body;
        let images = [];

        if (options.includeImages !== false && typeof ImageProcessor !== 'undefined') {
            try {
                const processed = await ImageProcessor.processBody(body);
                body = processed.html;
                images = processed.images;
            } catch (error) {
                console.warn('[EpubBuilder] Image processing failed, continuing without images:', error);
            }
        }

        let coverMediaType = null;
        /*
        // Cover disabled for X4 compatibility
        if (article.coverUrl) {
            try {
                console.log('[EpubBuilder] Fetching cover:', article.coverUrl);
                const response = await fetch(article.coverUrl);
                if (response.ok) {
                    const blob = await response.blob();
                    coverMediaType = blob.type || 'image/jpeg'; // Default to jpeg if unknown
                    // Add to zip
                    zip.file('OEBPS/images/cover.jpg', blob);
                }
            } catch (e) {
                console.warn('[EpubBuilder] Failed to fetch cover:', e);
            }
        }
        */

        const metadata = {
            title: article.title,
            author: article.author,
            date: article.date,
            uuid: uuid,
            coverMediaType,
            images
        };

        // Add mimetype file (must be first and uncompressed)
        zip.file('mimetype', EpubTemplates.mimetype, { compression: 'STORE' });

        // Add container.xml in META-INF
        zip.file('META-INF/container.xml', EpubTemplates.containerXml);

        // Add content.opf
        zip.file('OEBPS/content.opf', EpubTemplates.contentOpf(metadata));

        // Add toc.ncx
        zip.file('OEBPS/toc.ncx', EpubTemplates.tocNcx(metadata));

        // Add content.xhtml (pass full article including url)
        zip.file('OEBPS/content.xhtml', EpubTemplates.contentXhtml({ ...article, body }));

        // Add the embedded images; every one of these is listed in the OPF
        // manifest above, which an EPUB requires.
        images.forEach(image => {
            zip.file(`OEBPS/${image.href}`, image.data);
        });

        // Generate the EPUB as a Blob
        const epubBlob = await zip.generateAsync({
            type: 'blob',
            mimeType: 'application/epub+zip',
            compression: 'DEFLATE',
            compressionOptions: { level: 9 }
        });

        return epubBlob;
    },

    /**
     * Generate a filename for the EPUB.
     * Format: Title - Author - Source - Date.epub
     *
     * Every component is sanitized: downloads.download() rejects the whole
     * request with "Invalid filename" if any part contains a reserved
     * character (a page that publishes "2026-03-04 10:00" as its date, for
     * instance), and a stray "/" would silently write into a subdirectory.
     * @param {Object} article - { title, author, date, sourceUrl }
     * @returns {string}
     */
    generateFilename(article) {
        const parts = [];

        // 1. Title (First)
        parts.push(Sanitizer.sanitizeFilename(article.title, 50) || 'Untitled');

        // 2. Author
        const safeAuthor = Sanitizer.sanitizeFilename(article.author, 30);
        if (safeAuthor) parts.push(safeAuthor);

        // 3. Source (Domain)
        if (article.sourceUrl) {
            try {
                const hostname = new URL(article.sourceUrl).hostname;
                const source = Sanitizer.sanitizeFilename(hostname.replace(/^www\./, ''), 40);
                if (source) parts.push(source);
            } catch (e) {
                // ignore invalid url
            }
        }

        // 4. Date (Last)
        parts.push(this.normalizeDate(article.date));

        // Re-sanitize the joined name: it is the value handed to the downloads
        // API, and it must not end in a dot or space either.
        const filename = Sanitizer.sanitizeFilename(parts.join(' - '), 150) || 'Untitled';

        return filename + '.epub';
    },

    /**
     * Normalize whatever the page advertised as a publication date into
     * YYYY-MM-DD. Pages publish all sorts of things here ("2026-03-04 10:00",
     * "03/04/2026", free text), and the raw value used to go straight into the
     * filename.
     * @param {string} date
     * @returns {string}
     */
    normalizeDate(date) {
        const today = new Date().toISOString().split('T')[0];
        if (!date) return today;

        const iso = String(date).match(/(\d{4})-(\d{2})-(\d{2})/);
        if (iso) return iso[0];

        const parsed = new Date(date);
        if (!isNaN(parsed.getTime())) return parsed.toISOString().split('T')[0];

        return Sanitizer.sanitizeFilename(date, 20) || today;
    },

    /**
     * Generate a UUID v4
     * @returns {string}
     */
    generateUuid() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    },

    /**
     * Convert Blob to ArrayBuffer for message passing
     * @param {Blob} blob 
     * @returns {Promise<ArrayBuffer>}
     */
    async blobToArrayBuffer(blob) {
        if (typeof blob.arrayBuffer === 'function') {
            return blob.arrayBuffer();
        }

        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsArrayBuffer(blob);
        });
    }
};
