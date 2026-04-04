# Privacy policy — Tabby

**Last updated:** April 5, 2026

Tabby (“the Extension”) helps you manage browser tabs: find duplicate tabs by URL, export links, and optionally organize tabs using page metadata. This policy describes how the Extension handles information on your device.

## Summary

- Tabby **does not sell** your personal information.
- Tabby **does not run analytics or telemetry** to external servers for tracking purposes.
- Processing needed for deduplication, export, and organization happens **locally in your browser**, except as noted below.

## Information the Extension uses

To provide its features, the Extension may access:

- **Tab and window information** — Tab IDs, URLs, titles, and window membership. Used to detect duplicates, export links, move tabs, and show counts in the popup.
- **Page content (limited, optional)** — When you use **organize by category** and choose to allow **optional** site access in Chrome’s prompt, the Extension injects a **bundled script** into web pages you already have open to read public metadata (for example Open Graph and JSON-LD) and hostname signals. If you decline, organization uses **URL-based signals only** (no page injection). The Extension does **not** read passwords, form fields, or cookies.
- **Local storage (`chrome.storage.session`)** — Short-lived data to coordinate multi-step organize operations and progress UI (for example job state). This data stays on your device and is not synced to our servers (we do not operate servers for Tabby).

Exported files (for example `.txt` link lists) are **saved where you choose** on your device; the Extension does not upload them.

## Permissions (why they exist)

- **Tabs / Windows** — Operate on tabs and windows as described above.
- **Scripting** — Inject the Extension’s own packaged script into pages, only for category metadata when you use that feature.
- **Optional host access (http/https)** — Requested at runtime when you run **Preview layout**, only if you want full page metadata for categories. You can refuse and still use organize with URL-only classification. The Extension does **not** fetch and execute remote code from the internet.

## Children

Tabby is not directed at children under 13, and we do not knowingly collect personal information from children.

## Changes

We may update this policy when the Extension’s behavior changes. The “Last updated” date will change accordingly. Continued use of the Extension after changes means you accept the updated policy.

## Contact

For privacy questions about Tabby, contact: bk@m-mooga.com


