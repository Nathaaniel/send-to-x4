/**
 * EPUB Builder
 * Generates EPUB files from article/longpost data using JSZip
 */

// EpubBuilder will use the JSZip global from jszip.min.js (loaded via manifest)
const EpubBuilder = {
    /**
     * Generate EPUB blob from article data
     * @param {Object} article - { title, author, date, body, url }
     * @returns {Promise<Blob>} - EPUB blob
     */
    async build(article) {
        // JSZip is available globally from jszip.min.js loaded by service worker
        if (typeof JSZip === 'undefined') {
            throw new Error('JSZip not loaded');
        }

        const zip = new JSZip();
        const uuid = this.generateUuid();
        const hasImageUtils = typeof ImageUtils !== 'undefined';

        // --- Cover image ---------------------------------------------------
        let coverMediaType = null;
        let coverHref = null;
        if (hasImageUtils && article.coverUrl) {
            console.log('[EpubBuilder] Fetching cover:', article.coverUrl);
            const cover = await ImageUtils.prepareRemoteCover(article.coverUrl);
            if (cover) {
                coverHref = 'images/cover.' + cover.ext;
                coverMediaType = cover.mediaType;
                zip.file('OEBPS/' + coverHref, cover.blob);
            }
        }

        // --- Inline article images ----------------------------------------
        // Download each <img>, optimize for e-ink, embed in the zip, and
        // rewrite the body to reference the local copies.
        let body = article.body;
        let images = [];
        if (hasImageUtils) {
            try {
                const embedded = await ImageUtils.embedBodyImages(article.body, article.sourceUrl, zip);
                body = embedded.body;
                images = embedded.images;
                console.log('[EpubBuilder] Embedded', images.length, 'inline image(s)');
            } catch (e) {
                console.warn('[EpubBuilder] Inline image embedding failed:', e.message);
            }
        }

        // --- Flatten links ------------------------------------------------
        // Hyperlinks are unclickable on the X4, so drop them but keep the text.
        body = EpubTemplates.flattenLinks(body);

        // --- Chapter TOC --------------------------------------------------
        // Inject ids into headings and derive a navMap so long articles are
        // navigable from the X4's table of contents.
        const toc = EpubTemplates.buildToc(body);
        body = toc.body;

        const metadata = {
            title: article.title,
            author: article.author,
            date: article.date,
            lang: article.lang || 'en',
            uuid: uuid,
            coverMediaType,
            coverHref,
            images,
            headings: toc.headings
        };

        // Add mimetype file (must be first and uncompressed)
        zip.file('mimetype', EpubTemplates.mimetype, { compression: 'STORE' });

        // Add container.xml in META-INF
        zip.file('META-INF/container.xml', EpubTemplates.containerXml);

        // Add content.opf
        zip.file('OEBPS/content.opf', EpubTemplates.contentOpf(metadata));

        // Add toc.ncx
        zip.file('OEBPS/toc.ncx', EpubTemplates.tocNcx(metadata));

        // Add content.xhtml (pass full article with rewritten body)
        zip.file('OEBPS/content.xhtml', EpubTemplates.contentXhtml({ ...article, body }));

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
     * Generate a filename for the EPUB
     * Format: @handle - YYYY-MM-DD - first words.epub
     * @param {Object} article - { title, author, date }
     * @returns {string}
     */
    generateFilename(article) {
        const parts = [];

        // 1. Title (First)
        const safeTitle = Sanitizer.sanitizeFilename(article.title, 50);
        if (safeTitle) {
            parts.push(safeTitle);
        } else {
            parts.push('Untitled');
        }

        // 2. Author
        if (article.author) {
            const safeAuthor = Sanitizer.sanitizeFilename(article.author, 30);
            if (safeAuthor) parts.push(safeAuthor);
        }

        // 3. Source (Domain)
        if (article.sourceUrl) {
            try {
                const hostname = new URL(article.sourceUrl).hostname;
                const source = hostname.replace(/^www\./, '');
                parts.push(source);
            } catch (e) {
                // ignore invalid url
            }
        }

        // 4. Date (Last)
        const date = article.date || new Date().toISOString().split('T')[0];
        parts.push(date);

        return parts.join(' - ') + '.epub';
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
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsArrayBuffer(blob);
        });
    }
};
