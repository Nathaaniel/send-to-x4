# Image support (fork)

This fork re-enables **inline article images** and an **EPUB cover image**, both
optimized for the Xteink X4's 480×800 e-ink screen.

## What it does

- **Cover image** — taken from the page's `og:image` / `twitter:image` meta tags
  (or the first photo of an X/Twitter thread). It is shaped into a **portrait
  480×800 (3:5) cover** that matches the X4 screen: scaled to *fill* the frame and
  **center-cropped** (object-fit: cover), then grayscale + JPEG. So the X4 library
  shows a proper full-frame thumbnail instead of a letterboxed banner.
- **Inline images** — every `<img>` in the extracted article is:
  1. **downloaded** (in the background service worker, which has the `<all_urls>`
     host permission, so cross-origin images are allowed),
  2. **optimized** for e-ink — converted to **grayscale** (with a slight gamma lift
     so photos aren't muddy) and **downscaled** to a max of 800px on the longest
     side, re-encoded as JPEG (quality 0.7),
  3. **embedded** inside the EPUB (`OEBPS/images/imgN.jpg`),
  4. **rewritten** so the article references the local copy instead of a remote URL.

  Without step 3–4 the images would only be remote `<img src="https://…">` links,
  which never load on an offline e-reader. Duplicate URLs are stored once, and
  failed/oversized/tracking-pixel images are skipped.

## Where the code lives

| Concern | File |
|---|---|
| Fetch / grayscale / downscale / embed | `src/epub/image_utils.js` *(new)* |
| Cover + inline wiring into the build | `src/epub/epub_builder.js` |
| Manifest `<item>` entries + cover href + image CSS | `src/epub/epub_templates.js` |
| Capture cover, normalize lazy-loaded `<img>`, X/Twitter photos | `src/popup/modules/extraction_logic.js` |
| Load `image_utils.js` first | `manifest.json`, `src/background/service_worker.js` |

## Tuning

Edit `ImageUtils.config` in `src/epub/image_utils.js`:

```js
config: {
    grayscale: true,          // set false to keep colour (the X4 renders grey anyway)
    grayscaleGamma: 0.85,     // <1 lightens midtones (keeps pure black/white); 1 = no change
    maxDimension: 800,        // longest side in px for inline images; X4 panel is 480×800
    coverSize: { width: 480, height: 800 }, // portrait cover frame, 3:5 (crop-to-fill)
    jpegQuality: 0.7,         // 0–1; lower = smaller files
    maxImages: 50,            // safety cap per article
    fetchTimeoutMs: 15000
}
```

- **Lighter images:** lower `grayscaleGamma` further (e.g. `0.8` or `0.75`) for a
  brighter look; raise toward `1` to keep them as-is.
- **Cover shape:** change `coverSize` (e.g. `{ width: 533, height: 800 }` for a 2:3
  cover). The image is always scaled to fill and center-cropped to that frame.

## Important: download timing & WiFi

Images are fetched **at send time**, in the background service worker. Because the
extension must switch you to the X4 WiFi hotspot to upload, **stay on internet WiFi
until the EPUB is built** — i.e. press **Send** while still online. The build (with
image downloads) happens first, then the upload step uses the X4 hotspot. If an
image can't be fetched (paywalled, hotlink-protected, already offline) it's simply
skipped and the rest of the article still sends.

## How to load this fork

Test on desktop first (same codebase, easier to debug):

**Chrome / Edge**
1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this folder (the one with `manifest.json`)
3. Open an article, click the extension, **Send** / **Download EPUB**

**Firefox**
1. `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on** → pick `manifest.json`

**Quetta (Android)** — the browser you use
1. Quetta **Settings → Extensions** → enable **Developer mode**
2. **Load unpacked** and point it at the extracted folder containing `manifest.json`
   (Quetta's extension support is in beta; if "Load unpacked" isn't available,
   zip this folder and use Quetta's add-from-file option, then select the folder
   after it unpacks.)
3. The forked **Send to X4** appears alongside / instead of the store version.

## How to verify the images are really embedded

An `.epub` is just a zip. After sending, grab the file and:

```bash
unzip -l "Your Article - ….epub"      # should list OEBPS/images/cover.jpg, img1.jpg, …
```

Open `OEBPS/content.opf` — each image has an `<item …/>` in `<manifest>`, and the
cover has `<meta name="cover" content="cover-image"/>`. Open `OEBPS/content.xhtml`
— every `<img>` points at `images/…`, not `http(s)://…`.
