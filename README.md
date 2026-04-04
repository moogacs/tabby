<h1>
  <img src="icons/icon128.png" width="48" height="48" alt="" style="vertical-align: middle; margin-right: 12px;" />
  Tabby
</h1>

**Tabs, tidied.** A Chrome extension (Manifest V3) for **too many tabs**: dedupe by full URL, export links, and organize tabs into smart category batches with preview and safe limits.

## Preview

<p align="center">
  <img src="screenshots/tabby-cws-screenshot-1280x800.png" width="640" alt="Tabby popup — Chrome Web Store screenshot (1280×800)" />
</p>

<p align="center">
  <em>Chrome Web Store listing asset (<code>screenshots/tabby-cws-screenshot-1280x800.png</code>). Raw popup capture: <code>screenshots/screenshot-popup.png</code>; smaller asset: <code>screenshots/tabby-cws-screenshot-640x400.png</code>.</em>
</p>

## Features

- **Duplicate detection** — Matches duplicates by full URL (scheme, host, path, query). See counts before you change anything.
- **Close duplicates** — Keeps one tab per URL per group (by window and tab order), closes the rest.
- **Export** — Save all unique tab links as a `.txt` file.
- **Organize by category** — Uses Open Graph, JSON-LD, and hostname hints to group tabs; preview layout before moving tabs; large applies run in batches (see `limits.js`).


## Privacy

How Tabby uses permissions and on-device data is described in **[privacy-policy.md](privacy-policy.md)**.

## License

See [LICENSE](LICENSE).
