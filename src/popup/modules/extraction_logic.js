/**
 * Article extraction logic
 * This function is stringified and injected into the page, so it must be self-contained.
 */
// Note: This function is stringified, so no imports allowed!
export function extractArticle() {
    // Elements that must never reach the EPUB: unsupported by e-ink readers,
    // or pointing at a remote resource the reader cannot fetch offline.
    const STRIP_SELECTOR = [
        'script', 'style', 'svg', 'math', 'iframe', 'object', 'embed', 'form',
        'input', 'button', 'select', 'textarea', 'video', 'audio', 'canvas',
        'noscript', 'template', 'link', 'meta', 'base', 'map', 'dialog',
        'source', 'track', 'area', 'param'
    ].join(',');

    /**
     * The single best URL for an image, absolute.
     *
     * Lazy-loading sites leave a placeholder in src and the real file in a
     * data- attribute or srcset, so the obvious read is often the wrong one.
     */
    const pickImageUrl = (img) => {
        const fromSrcset = (value) => {
            if (!value) return null;
            // "url 320w, url 640w" - take the widest candidate on offer.
            const candidates = value.split(',')
                .map(part => part.trim().split(/\s+/))
                .filter(parts => parts[0])
                .map(parts => ({
                    url: parts[0],
                    width: parseInt(parts[1], 10) || 0
                }));
            if (!candidates.length) return null;
            return candidates.sort((a, b) => b.width - a.width)[0].url;
        };

        const isPlaceholder = (value) =>
            !value ||
            value.startsWith('data:image/svg+xml') ||
            /(?:blank|spacer|placeholder|1x1)\.(?:gif|png)$/i.test(value);

        const src = img.getAttribute('src');
        const candidates = [
            isPlaceholder(src) ? null : src,
            fromSrcset(img.getAttribute('srcset')),
            img.getAttribute('data-src'),
            img.getAttribute('data-original'),
            img.getAttribute('data-lazy-src'),
            fromSrcset(img.getAttribute('data-srcset')),
            src
        ];

        for (const candidate of candidates) {
            if (!candidate || isPlaceholder(candidate)) continue;
            try {
                const url = new URL(candidate, window.location.href);
                if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'data:') {
                    return url.href;
                }
            } catch (e) {
                // not a usable URL, try the next candidate
            }
        }

        return null;
    };

    /**
     * Turn an HTML fragment into a well-formed XHTML fragment.
     *
     * The EPUB content document is parsed as XML, so serializing raw innerHTML
     * into it is not safe: innerHTML emits HTML named entities (&nbsp;), which
     * XML does not define, and that single undefined entity is a fatal parse
     * error - the downloaded book fails to open. XMLSerializer emits XML that
     * is well-formed by construction.
     */
    const toCleanXhtml = (html) => {
        if (!html) return '';

        const container = document.createElement('div');
        container.innerHTML = html;

        // <picture> is a wrapper: keep the <img> inside it, lose the rest.
        container.querySelectorAll('picture').forEach(picture => {
            const img = picture.querySelector('img');
            if (img) {
                picture.replaceWith(img);
            } else {
                picture.remove();
            }
        });

        container.querySelectorAll(STRIP_SELECTOR).forEach(el => el.remove());

        // Resolve image URLs before the attribute sweep below removes them.
        // These stay absolute here; the EPUB builder fetches them, shrinks them
        // and rewrites each src to the embedded copy.
        const imageUrls = new Map();
        container.querySelectorAll('img').forEach(img => {
            const url = pickImageUrl(img);
            const width = parseInt(img.getAttribute('width'), 10);
            const height = parseInt(img.getAttribute('height'), 10);

            // Tracking pixels and spacers announce themselves.
            const isSpacer = (width > 0 && width <= 2) || (height > 0 && height <= 2);

            if (url && !isSpacer) {
                imageUrls.set(img, url);
            } else {
                img.remove();
            }
        });

        container.querySelectorAll('*').forEach(el => {
            Array.from(el.attributes).forEach(attr => {
                const name = attr.name.toLowerCase();
                if (name.indexOf('on') === 0 || name === 'style' || name === 'src' ||
                    name === 'srcset' || name === 'background' || name === 'poster' ||
                    name.indexOf('data-') === 0 || name.indexOf('aria-') === 0) {
                    el.removeAttribute(attr.name);
                }
            });
        });

        imageUrls.forEach((url, img) => img.setAttribute('src', url));

        try {
            return new XMLSerializer().serializeToString(container);
        } catch (e) {
            console.warn('[X4] XMLSerializer failed, falling back to innerHTML:', e);
            return container.innerHTML;
        }
    };

    try {
        console.log('[X4] Extracting article...');
        const hostname = window.location.hostname;

        // --- TWITTER / X SUPPORT ---
        if (hostname.includes('twitter.com') || hostname.includes('x.com')) {
            console.log('[X4] Detected Twitter/X');

            // 1. Identify Author from URL
            const urlParts = new URL(window.location.href).pathname.split('/');
            const authorHandle = urlParts[1]; // /username/status/...

            if (!authorHandle || !window.location.href.includes('/status/')) {
                // Fallback to Readability if not a specific thread/status
                console.log('[X4] Not a thread URL, using standard extraction');
            } else {
                console.log('[X4] Extracting Thread for:', authorHandle);

                // Select tweets
                const tweets = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
                let threadContent = [];
                let title = '';
                let firstTweetFound = false;

                console.log('[X4] Found tweets:', tweets.length);

                tweets.forEach((tweet, index) => {
                    // Check author via User-Name links
                    const userLinks = tweet.querySelectorAll('div[data-testid="User-Name"] a');
                    let isAuthor = false;
                    let debugLinks = [];

                    for (const link of userLinks) {
                        const href = link.getAttribute('href');
                        debugLinks.push(href);
                        if (href && href.replace('/', '').toLowerCase() === authorHandle.toLowerCase()) {
                            isAuthor = true;
                            break;
                        }
                    }

                    // console.log(`[X4] Tweet ${index} author check:`, isAuthor, debugLinks);

                    // Simple Thread Logic: Capture Author's tweets
                    if (isAuthor) {
                        // Extract Text
                        let textEl = tweet.querySelector('[data-testid="tweetText"]');
                        let isArticle = false;

                        // Fallback for Twitter Articles (Long Posts)
                        if (!textEl) {
                            textEl = tweet.querySelector('[data-testid="twitterArticleRichTextView"]');
                            isArticle = !!textEl;
                        }

                        const text = textEl ? textEl.innerHTML : '';
                        console.log(`[X4] Tweet ${index} text length:`, text.length);

                        // Extract Images
                        const photoEls = tweet.querySelectorAll('[data-testid="tweetPhoto"] img');
                        const photoUrls = Array.from(photoEls).map(img => img.src).filter(Boolean);

                        // Title logic
                        // For Articles, prefer the explicit article title
                        if (isArticle) {
                            const articleTitleEl = tweet.querySelector('[data-testid="twitter-article-title"]');
                            if (articleTitleEl) {
                                title = articleTitleEl.textContent.trim();
                            }
                        }
                        // Standard fallback
                        if (!title && textEl) {
                            title = textEl.textContent.substring(0, 50) + '...';
                        }

                        // Helper for XML escaping
                        const escapeXml = (str) => {
                            if (!str) return '';
                            return str.toString()
                                .replace(/&/g, '&amp;')
                                .replace(/</g, '&lt;')
                                .replace(/>/g, '&gt;')
                                .replace(/"/g, '&quot;')
                                .replace(/'/g, '&apos;');
                        };

                        let tweetHtml = `<div class="tweet">`;
                        if (isArticle && title) {
                            tweetHtml += `<h2>${escapeXml(title)}</h2>`;
                        }
                        // Articles often have complex HTML structure, so use div
                        if (text) tweetHtml += `<div>${toCleanXhtml(text)}</div>`;

                        // The EPUB builder fetches and shrinks these; sizing
                        // is handled by the stylesheet in the book.
                        photoUrls.forEach(url => {
                            tweetHtml += `<img src="${escapeXml(url)}" alt="" />`;
                        });
                        tweetHtml += `</div>`;

                        threadContent.push(tweetHtml);
                    }
                });
                console.log('[X4] Thread content items:', threadContent.length);

                if (threadContent.length > 0) {
                    const finalTitle = `${authorHandle} on X: "${title.replace(/"/g, "'")}"`;
                    // Date from first time element
                    const dateEl = document.querySelector('time[datetime]');
                    const rawDate = dateEl ? dateEl.getAttribute('datetime') : null;
                    const date = rawDate ? rawDate.split('T')[0] : new Date().toISOString().split('T')[0];

                    // Use first image found as cover
                    // We can look at the first tweet's photos
                    let coverUrl = null;
                    /*
                    // Cover disabled for X4 compatibility
                    const firstTweetPhotos = tweets[0].querySelectorAll('[data-testid="tweetPhoto"] img');
                    if (firstTweetPhotos.length > 0) {
                        coverUrl = firstTweetPhotos[0].src;
                    }
                    */

                    return {
                        success: true,
                        article: {
                            title: finalTitle,
                            author: `X (${authorHandle})`,
                            date,
                            coverUrl,
                            wordCount: threadContent.length * 30,
                            body: threadContent.join('\n'),
                            rawText: '',
                            sourceUrl: window.location.href
                        }
                    };
                }
            }
        }

        // --- STANDARD READABILITY ---
        // Check if Readability is available
        const hasReadability = typeof Readability !== 'undefined';
        console.log('[X4] Readability available:', hasReadability);

        let title = document.title;
        let author = '';
        let date = new Date().toISOString().split('T')[0];
        let body = '';
        let textContent = '';
        let wordCount = 0;

        if (hasReadability) {
            // Use Readability
            const docClone = document.cloneNode(true);
            const reader = new Readability(docClone);
            const article = reader.parse();

            if (article && article.textContent && article.textContent.length >= 400) {
                title = article.title || document.title;
                author = article.byline || article.siteName || '';
                body = toCleanXhtml(article.content);
                textContent = article.textContent;
                wordCount = textContent.split(/\s+/).length;

                // Try to get date
                const dateEl = document.querySelector('meta[property="article:published_time"]') ||
                    document.querySelector('time[datetime]');
                if (article.publishedTime) {
                    date = article.publishedTime.split('T')[0];
                } else if (dateEl) {
                    const dt = dateEl.getAttribute('content') || dateEl.getAttribute('datetime');
                    if (dt) date = dt.split('T')[0];
                }

                // Get author from meta if not in article
                if (!author) {
                    author = document.querySelector('meta[name="author"]')?.content ||
                        document.querySelector('meta[property="article:author"]')?.content ||
                        new URL(window.location.href).hostname.replace('www.', '');
                }

                console.log('[X4] Readability extracted:', title, wordCount, 'words');

                return {
                    success: true,
                    article: {
                        title,
                        author,
                        date,
                        wordCount,
                        body,
                        rawText: textContent,
                        sourceUrl: window.location.href
                    }
                };
            }
        }

        // Fallback: basic extraction
        console.log('[X4] Using fallback extraction');

        // Get main content area
        const mainContent = document.querySelector('article') ||
            document.querySelector('[role="main"]') ||
            document.querySelector('main') ||
            document.body;

        textContent = mainContent.innerText || mainContent.textContent || '';
        wordCount = textContent.split(/\s+/).length;

        if (textContent.length < 400) {
            console.log('[X4] Content too short:', textContent.length);
            return { success: false, reason: 'content_too_short', length: textContent.length };
        }

        // Get metadata
        author = document.querySelector('meta[name="author"]')?.content ||
            document.querySelector('meta[property="article:author"]')?.content ||
            new URL(window.location.href).hostname.replace('www.', '');

        const dateEl = document.querySelector('meta[property="article:published_time"]') ||
            document.querySelector('time[datetime]');
        if (dateEl) {
            const dt = dateEl.getAttribute('content') || dateEl.getAttribute('datetime');
            if (dt) date = dt.split('T')[0];
        }

        // Create simple HTML body
        const paragraphs = textContent.split(/\n\n+/).filter(p => p.trim().length > 0);
        body = paragraphs.map(p => `<p>${p.trim().replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`).join('\n');

        return {
            success: true,
            article: {
                title,
                author,
                date,
                wordCount,
                body,
                rawText: textContent,
                sourceUrl: window.location.href
            }
        };

    } catch (error) {
        console.error('[X4] Extraction error:', error);
        return { success: false, reason: error.message };
    }
}
