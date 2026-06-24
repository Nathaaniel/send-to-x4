/**
 * Article extraction logic
 * This function is stringified and injected into the page, so it must be self-contained.
 */
// Note: This function is stringified, so no imports allowed!
export function extractArticle() {
    try {
        console.log('[X4] Extracting article...');
        const hostname = window.location.hostname;

        // --- Image helpers (self-contained; this function is stringified & injected) ---

        // Find a cover image for the EPUB from page metadata.
        const getMetaCover = () => {
            const selectors = [
                'meta[property="og:image:secure_url"]',
                'meta[property="og:image"]',
                'meta[name="twitter:image"]',
                'meta[name="twitter:image:src"]',
                'link[rel="image_src"]'
            ];
            for (const sel of selectors) {
                const el = document.querySelector(sel);
                const val = el && (el.getAttribute('content') || el.getAttribute('href'));
                if (val) {
                    try { return new URL(val, window.location.href).href; } catch (e) { return val; }
                }
            }
            return null;
        };

        // Normalize <img> tags in extracted HTML: resolve lazy-loaded sources to a
        // real absolute src, drop tracking pixels, and strip noisy attributes so the
        // background service worker can fetch + embed them reliably.
        const normalizeImages = (html) => {
            try {
                const doc = new DOMParser().parseFromString(html, 'text/html');
                doc.querySelectorAll('img').forEach(img => {
                    let src = img.getAttribute('src') || img.getAttribute('data-src') ||
                        img.getAttribute('data-original') || img.getAttribute('data-lazy-src') || '';
                    if (!src) {
                        const ss = img.getAttribute('srcset') || img.getAttribute('data-srcset');
                        if (ss) src = ss.split(',')[0].trim().split(/\s+/)[0];
                    }
                    if (!src) { img.remove(); return; }
                    // Drop tiny tracking pixels declared via width/height attributes
                    const w = parseInt(img.getAttribute('width') || '0', 10);
                    const h = parseInt(img.getAttribute('height') || '0', 10);
                    if ((w && w <= 2) || (h && h <= 2)) { img.remove(); return; }
                    try { src = new URL(src, window.location.href).href; } catch (e) { /* keep as-is */ }
                    const alt = img.getAttribute('alt') || '';
                    Array.from(img.attributes).forEach(a => img.removeAttribute(a.name));
                    img.setAttribute('src', src);
                    if (alt) img.setAttribute('alt', alt);
                });
                return doc.body.innerHTML;
            } catch (e) {
                console.warn('[X4] normalizeImages failed:', e);
                return html;
            }
        };

        // Remove leftover clutter Readability sometimes keeps: newsletter/share/
        // related/promo widgets and asides. Conservative: only obvious matches.
        const stripJunk = (html) => {
            try {
                const doc = new DOMParser().parseFromString(html, 'text/html');
                const junk = /(^|[\s_-])(newsletter|subscribe|signup|sign-up|share|social|related|recirc|promo|sponsor|advert|cookie|comment)([\s_-]|$)/i;
                doc.querySelectorAll('aside, [role="complementary"]').forEach(el => el.remove());
                doc.querySelectorAll('*').forEach(el => {
                    const sig = ((el.getAttribute('class') || '') + ' ' + (el.getAttribute('id') || '')).trim();
                    if (sig && junk.test(sig)) el.remove();
                });
                return doc.body.innerHTML;
            } catch (e) {
                console.warn('[X4] stripJunk failed:', e);
                return html;
            }
        };

        // Strip a trailing " | Site Name" / " - Site" / " — Site" suffix from the title.
        const cleanTitle = (title) => {
            if (!title) return title;
            const siteName = document.querySelector('meta[property="og:site_name"]')?.content || '';
            const host = window.location.hostname.replace(/^www\./, '').split('.').slice(-2, -1)[0] || '';
            const candidates = [siteName, host].filter(Boolean).map(s => s.toLowerCase());
            const m = title.match(/^(.*\S)\s+[|\-–—·:]{1,2}\s+([^|\-–—·:]+)$/);
            if (m && m[1].length >= 15) {
                const tail = m[2].trim().toLowerCase();
                if (candidates.some(c => tail === c || tail.includes(c) || c.includes(tail))) {
                    return m[1].trim();
                }
            }
            return title.trim();
        };

        // Document language for EPUB metadata (helps device hyphenation/TTS).
        const getDocLang = () => {
            const l = (document.documentElement.getAttribute('lang') ||
                document.querySelector('meta[http-equiv="content-language"]')?.content || '').trim();
            return l ? l.split(',')[0].trim() : 'en';
        };

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
                        const photoUrls = Array.from(photoEls).map(img => img.src);

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

                        let tweetHtml = `<div class="tweet" style="border-bottom: 1px solid #ccc; padding: 10px 0;">`;
                        if (isArticle && title) {
                            tweetHtml += `<h2>${escapeXml(title)}</h2>`;
                        }
                        if (text) tweetHtml += `<div>${text}</div>`; // Articles often have complex HTML structure, so use div

                        // Inline tweet images (downloaded + optimized later by the EPUB builder)
                        photoUrls.forEach(url => {
                            if (url) tweetHtml += `<img src="${escapeXml(url)}" />`;
                        });
                        tweetHtml += `</div>`;

                        threadContent.push(tweetHtml);
                    }
                });
                console.log('[X4] Thread content items:', threadContent.length);

                if (threadContent.length > 0) {
                    const finalTitle = `${authorHandle} on X: "${title.replace(/"/g, "'")}"`;
                    // Date from first time element
                    const dateEl = document.querySelector('time');
                    const date = dateEl ? dateEl.getAttribute('datetime').split('T')[0] : new Date().toISOString().split('T')[0];

                    // Use first image found as cover
                    let coverUrl = null;
                    const firstTweetPhotos = tweets[0].querySelectorAll('[data-testid="tweetPhoto"] img');
                    if (firstTweetPhotos.length > 0) {
                        coverUrl = firstTweetPhotos[0].src;
                    }

                    return {
                        success: true,
                        article: {
                            title: finalTitle,
                            author: `X (${authorHandle})`,
                            date,
                            coverUrl,
                            lang: getDocLang(),
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
                title = cleanTitle(article.title || document.title);
                author = article.byline || article.siteName || '';
                body = normalizeImages(stripJunk(article.content));
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
                        coverUrl: getMetaCover(),
                        lang: getDocLang(),
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
                title: cleanTitle(title),
                author,
                date,
                coverUrl: getMetaCover(),
                lang: getDocLang(),
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
