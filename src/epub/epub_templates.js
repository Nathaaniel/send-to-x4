/**
 * EPUB Templates
 * Standard templates for EPUB structure
 */
const EpubTemplates = {
  /**
   * Generate mimetype file content
   */
  mimetype: 'application/epub+zip',

  /**
   * Generate container.xml
   */
  containerXml: `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,

  /**
   * Generate content.opf
   * @param {Object} metadata - { title, author, date, uuid, coverMediaType }
   */
  contentOpf(metadata) {
    const { title, author, date, uuid, coverMediaType, coverHref, images, lang } = metadata;
    const creatorLine = author
      ? `    <dc:creator>${this.escapeXml(author)}</dc:creator>`
      : '';
    const dateLine = date
      ? `    <dc:date>${this.escapeXml(date)}</dc:date>`
      : '';

    // Cover metadata
    const coverMeta = coverMediaType
      ? `    <meta name="cover" content="cover-image" />`
      : '';

    const coverItem = coverMediaType
      ? `    <item id="cover-image" href="${coverHref || 'images/cover.jpg'}" media-type="${coverMediaType}"/>`
      : '';

    // Inline image manifest items
    const imageItems = (images && images.length)
      ? images.map(i => `    <item id="${i.id}" href="${i.href}" media-type="${i.mediaType}"/>`).join('\n')
      : '';

    return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>${this.escapeXml(title)}</dc:title>
${creatorLine}
${dateLine}
${coverMeta}
    <dc:identifier id="bookid">urn:uuid:${uuid}</dc:identifier>
    <dc:language>${this.escapeXml(lang || 'en')}</dc:language>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="content" href="content.xhtml" media-type="application/xhtml+xml"/>
${coverItem}
${imageItems}
  </manifest>
  <spine toc="ncx">
    <itemref idref="content"/>
  </spine>
</package>`;
  },

  /**
   * Render a QR code for `url` as a self-contained inline SVG (no external file,
   * no canvas). Returns '' if the QR library is unavailable or encoding fails.
   * @param {string} url
   */
  qrSvg(url, opts = {}) {
    if (typeof qrcode === 'undefined' || !url) return '';
    try {
      const qr = qrcode(0, opts.ec || 'L'); // type 0 = auto-pick smallest version
      qr.addData(url);
      qr.make();
      const count = qr.getModuleCount();
      const margin = opts.margin != null ? opts.margin : 4; // quiet zone (modules)
      const size = count + margin * 2;
      const px = opts.px || 132;
      let rects = '';
      for (let r = 0; r < count; r++) {
        for (let c = 0; c < count; c++) {
          if (qr.isDark(r, c)) {
            rects += `<rect x="${c + margin}" y="${r + margin}" width="1" height="1"/>`;
          }
        }
      }
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#ffffff"/><g fill="#000000">${rects}</g></svg>`;
    } catch (e) {
      console.warn('[EpubTemplates] QR generation failed:', e.message);
      return '';
    }
  },

  /**
   * Flatten <a> tags to their inner content (drop the link, keep text/children).
   * Inline links are dead weight on the X4, so we strip them everywhere.
   * @param {string} html
   */
  flattenLinks(html) {
    if (!html) return html;
    let out = html, prev;
    // Loop to unwrap any (rare) nested anchors as well.
    do {
      prev = out;
      out = out.replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, '$1');
    } while (out !== prev);
    return out;
  },

  /**
   * Scan the body for <h1>-<h3> headings, give each a stable id, and return the
   * (possibly modified) body plus a flat heading list used to build the TOC.
   * @param {string} body
   * @returns {{ body: string, headings: Array<{id:string,text:string,level:number}> }}
   */
  buildToc(body) {
    if (!body) return { body: '', headings: [] };
    const headings = [];
    let counter = 0;

    const out = body.replace(/<(h[1-3])\b([^>]*)>([\s\S]*?)<\/\1>/gi, (full, tag, attrs, inner) => {
      const text = this.decodeBasicEntities(inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
      if (!text) return full; // skip empty headings

      let id = (attrs.match(/\bid\s*=\s*("([^"]*)"|'([^']*)')/i) || [])[2];
      let newAttrs = attrs;
      if (!id) {
        id = 'sec-' + (++counter);
        newAttrs = `${attrs} id="${id}"`;
      }
      headings.push({ id, text, level: parseInt(tag[1], 10) });
      return `<${tag}${newAttrs}>${inner}</${tag}>`;
    });

    return { body: out, headings };
  },

  /**
   * Generate toc.ncx
   * @param {Object} metadata - { title, uuid, headings }
   */
  tocNcx(metadata) {
    const { title, uuid, headings } = metadata;

    // First nav point is always the whole document.
    let navPoints = `    <navPoint id="navpoint-0" playOrder="1">
      <navLabel>
        <text>${this.escapeXml(title)}</text>
      </navLabel>
      <content src="content.xhtml"/>
    </navPoint>`;

    let depth = 1;
    if (headings && headings.length) {
      const tree = this.headingsToTree(headings);
      const order = { n: 1 }; // playOrder counter (1 already used by the doc nav point)
      const rendered = this.renderNavPoints(tree, order, 1);
      navPoints += '\n' + rendered.xml;
      depth = Math.max(1, rendered.depth);
    }

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:${uuid}"/>
    <meta name="dtb:depth" content="${depth}"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle>
    <text>${this.escapeXml(title)}</text>
  </docTitle>
  <navMap>
${navPoints}
  </navMap>
</ncx>`;
  },

  /** Build a nested tree from a flat heading list using heading levels. */
  headingsToTree(headings) {
    const root = { children: [] };
    const stack = [{ node: root, level: 0 }];
    for (const h of headings) {
      const node = { id: h.id, text: h.text, children: [] };
      while (stack.length > 1 && h.level <= stack[stack.length - 1].level) {
        stack.pop();
      }
      stack[stack.length - 1].node.children.push(node);
      stack.push({ node, level: h.level });
    }
    return root.children;
  },

  /** Recursively render navPoints, assigning playOrder in document order. */
  renderNavPoints(nodes, order, currentDepth) {
    let xml = '';
    let depth = currentDepth;
    const indent = '    '.repeat(currentDepth);
    for (const node of nodes) {
      order.n += 1;
      const playOrder = order.n;
      let inner = '';
      if (node.children.length) {
        const child = this.renderNavPoints(node.children, order, currentDepth + 1);
        inner = '\n' + child.xml;
        depth = Math.max(depth, child.depth);
      }
      xml += `${indent}<navPoint id="navpoint-${node.id}" playOrder="${playOrder}">
${indent}  <navLabel>
${indent}    <text>${this.escapeXml(node.text)}</text>
${indent}  </navLabel>
${indent}  <content src="content.xhtml#${node.id}"/>${inner}
${indent}</navPoint>\n`;
    }
    return { xml: xml.replace(/\n$/, ''), depth: Math.max(depth, currentDepth + 1) };
  },

  /** Decode the handful of HTML entities that show up in heading text. */
  decodeBasicEntities(text) {
    if (!text) return '';
    return text
      .replace(/&nbsp;/gi, ' ')
      .replace(/&#0*39;/g, "'").replace(/&apos;/gi, "'")
      .replace(/&#0*34;/g, '"').replace(/&quot;/gi, '"')
      .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
      .replace(/&amp;/gi, '&')
      .trim();
  },

  /**
   * Generate content.xhtml for longpost
   * @param {Object} data - { title, author, date, body, url }
   */
  contentXhtml(data) {
    const { title, author, date, body, wordCount, lang } = data;
    const url = data.url || data.sourceUrl;

    // Build metadata line: author • date • N min read • Source
    const metaParts = [];
    if (author) metaParts.push(this.escapeXml(author));
    if (date) metaParts.push(this.escapeXml(date));
    const minutes = wordCount ? Math.max(1, Math.round(wordCount / 200)) : 0;
    if (minutes) metaParts.push(`${minutes} min read`);
    if (url) metaParts.push(`<a href="${this.escapeXml(url)}">Source</a>`);
    const metaLine = metaParts.length > 0
      ? `<p class="meta">${metaParts.join(' • ')}</p>`
      : '';

    // Convert HTML body to XHTML (properly close self-closing tags)
    const xhtmlBody = this.htmlToXhtml(body);
    const langAttr = this.escapeXml(lang || 'en');

    // Source footer: scannable QR of the article URL (you can't tap links on the X4)
    const qr = url ? this.qrSvg(url) : '';
    const sourceFooter = url
      ? `<div class="source-footer">
    ${qr}
    <p class="source-url">${this.escapeXml(url)}</p>
  </div>`
      : '';

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${langAttr}">
<head>
  <meta http-equiv="Content-Type" content="application/xhtml+xml; charset=utf-8"/>
  <title>${this.escapeXml(title)}</title>
  <style type="text/css">
    body {
      margin: 1.5em;
      line-height: 1.7;
      font-family: Georgia, "Times New Roman", serif;
    }
    h1 {
      font-size: 1.5em;
      margin-bottom: 0.3em;
      line-height: 1.3;
    }
    h2 {
      font-size: 1.2em;
      line-height: 1.3;
      margin: 1.2em 0 0.3em;
    }
    h3 {
      font-size: 1.05em;
      line-height: 1.3;
      margin: 1em 0 0.3em;
    }
    .meta {
      color: #666;
      font-size: 0.85em;
      margin-bottom: 1.5em;
      padding-bottom: 1em;
      border-bottom: 1px solid #ddd;
    }
    .meta a {
      color: #666;
    }
    p {
      margin: 0.9em 0;
      text-align: left;
    }
    blockquote {
      margin: 1em 1.5em;
      padding-left: 1em;
      border-left: 3px solid #ccc;
      font-style: italic;
    }
    img {
      max-width: 100%;
      height: auto;
      display: block;
      margin: 1em auto;
    }
    figure {
      margin: 1em 0;
    }
    figcaption {
      font-size: 0.8em;
      color: #666;
      text-align: center;
      margin-top: 0.4em;
    }
    pre {
      white-space: pre-wrap;
      word-wrap: break-word;
      overflow-wrap: break-word;
      font-size: 0.8em;
      background: #f4f4f4;
      padding: 0.6em;
      border-radius: 4px;
    }
    code {
      word-wrap: break-word;
      overflow-wrap: break-word;
    }
    table {
      width: 100%;
      table-layout: fixed;
      word-wrap: break-word;
      border-collapse: collapse;
      font-size: 0.85em;
    }
    td, th {
      border: 1px solid #ccc;
      padding: 0.3em;
      vertical-align: top;
    }
    hr {
      border: none;
      border-top: 1px solid #ccc;
      margin: 1.5em 0;
    }
    .source-footer {
      margin-top: 2.5em;
      padding-top: 1em;
      border-top: 1px solid #ddd;
      text-align: center;
    }
    .source-footer svg {
      width: 132px;
      height: 132px;
    }
    .source-url {
      font-size: 0.7em;
      color: #666;
      word-break: break-all;
      margin: 0.5em 0 0;
    }
  </style>
</head>
<body>
  <h1>${this.escapeXml(title)}</h1>
  ${metaLine}
  <div class="content">
    ${xhtmlBody}
  </div>
  ${sourceFooter}
</body>
</html>`;
  },

  /**
   * Escape XML special characters
   * @param {string} text
   */
  escapeXml(text) {
    if (!text) return '';
    const map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&apos;'
    };
    return String(text).replace(/[&<>"']/g, m => map[m]);
  },

  /**
   * Convert HTML to XHTML by properly closing self-closing tags
   * @param {string} html
   */
  htmlToXhtml(html) {
    if (!html) return '';

    // List of void/self-closing elements in HTML that must be self-closed in XHTML
    const voidElements = [
      'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
      'link', 'meta', 'param', 'source', 'track', 'wbr'
    ];

    // Pattern to match void elements that are not already self-closed
    // Matches: <tag ...> but not <tag ... /> or <tag .../>
    const pattern = new RegExp(
      `<(${voidElements.join('|')})([^>]*?)(?<!/)>`,
      'gi'
    );

    // Replace with self-closing version
    // Also ensures we don't double-close if the regex is too greedy, but (?<!/) handles the check.
    return html.replace(pattern, '<$1$2 />');
  }
};
