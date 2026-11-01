# Webmail (embedded SPA)

The Svelte 5 webmail frontend for [`mailcow-rest-api`](../README.md) — a desktop mail UI plus a mobile/PWA experience at `/webmail/mobile/`. Built into the API image and served at `/webmail/`, so there is nothing to deploy on its own and no version skew between API and frontend.

**Alpha:** public and usable, but still an alpha webmail client. Expect fast changes and rough edges in some workflows.

![Outlook inbox](docs/screenshots/outlook-inbox.png)

## Architecture

```mermaid
flowchart LR
    Browser[Browser / PWA] -->|/webmail/| API[mailcow-rest-api]
    Browser -->|/v1/*| API
    API --> IMAP[mailcow Dovecot IMAP]
    API --> SMTP[mailcow Postfix SMTP]
    API --> DB[mailcow MariaDB]
    API --> SOGo[SOGo CalDAV]
    API --> LLM[LLM provider]
```

Static client-side app — all mailbox and AI processing happens in the API, which also serves the built files. Same origin, so no CORS configuration is involved.

## Appearance

Two skins, each with a **customisable accent colour** plus a custom-CSS box under **Settings → Appearance**:

![Gmail skin inbox](docs/screenshots/gmail-inbox.png)

- **Outlook** — Outlook-on-the-web chrome. The default.
- **Gmail** — a Gmail rip-off: Material list, rounded rows, red Compose button with blue selection (pale in light, desaturated in dark).

The accent colour is a *layer*, not a third palette: it re-derives the accent family over whichever skin is active, so the chrome retints while the surfaces, type and shape stay the skin's own.

**Light/dark** comes from the topbar auto/light/dark toggle and works on both skins. Each skin carries its own dark palette: Outlook's is Fluent's dark neutrals under the familiar blue command bar, Gmail's is Material dark with the darker page and lighter message list. On **auto** the skin follows your OS, including live if you change it while the app is open.

One deliberate carry-over: Outlook's search field stays white with dark text in *both* light and dark, because Outlook-on-the-web does the same. It is not themed like the rest of the surface — see the comment in `skins.svelte.ts` for why swapping it onto the dark input token is a trap.

The two skins differ in one deliberate way: Outlook's header is a sparse blue command bar, so the weather chip and calendar ticker are hidden there by default (**Settings → Appearance → "Weather chip on Outlook themes"** brings the weather chip back). Gmail shows both.

## Settings

Every preference lives in one searchable modal. The left rail groups 19 sections under five headings — **Account**, **General**, **Email**, **Calendar**, **People** — the search box filters across all of them at once, and the panel reopens on whichever section you used last. The two sections that were only ever empty placeholders are gone rather than shown as dead ends.

![Settings](docs/screenshots/settings-groups.png)

## Context menu

Right-click any message for Open / Star / Read / Archive / **Create rule from message** / **Send to external webhook** / Block sender / **Block domain** / **Block root domain** / Trash. The two variable-width items — "Move to…" and "Send to external webhook…" — are submenus rather than inline lists, so the menu stays a fixed handful of actions however many mailboxes or webhooks the account has.

The three block items are one code path differing only in the pattern they apply: the exact address, `*@` the full host, or `*@` the registrable domain (so `deals@mail.promo.example.co.uk` offers `*@mail.promo.example.co.uk` and `*@example.co.uk` — the second is the one that catches a spammer rotating subdomains). Both wider options disappear when there is nothing useful to derive (no From address, an IP literal, or a host that is already its own root). The confirm dialog and the success toast name the exact pattern, because `*@example.co.uk` is a much bigger hammer than a single address.

![Context menu](docs/screenshots/message-context-menu.png)

## Link safety

Clicking a link inside a message never opens it straight away. The destination is looked up first and shown with what the checker actually found, and a link with no verdict is labelled as no verdict rather than as safe:

![Link safety prompt](docs/screenshots/link-safety-prompt.png)

The check is deliberately hard to misread. **Never scanned** is not an all-clear and says so in words; **not checked** and **check timed out** are distinct from **harmless**; a plain-`http://` destination is called out separately from its verdict; and a malicious hit is labelled as malicious with the count of engines that flagged it. The way through is always there and always says what it does — a link is never trapped, because a prompt you cannot dismiss is just a wall. Cancel closes without opening anything.

The lookup is a server call to `GET /v1/link-check?url=…` (VirusTotal, with the key server-side), so the provider key stays off the browser as with every other AI-backed feature. It needs **Settings → AI → AI features** turned on (off by default in v0.27.0) and **Settings → Junk email → Link safety** enabled; with AI off, links behave like ordinary links.

## Outlook-style mail layout

Recent releases add Outlook-on-the-web behaviour without requiring AI:

- **Focused / Other** — on INBOX only, rule-based tabs (`focused-inbox.ts`); your choice is stored in `settings.inboxTab`. See [`docs/OUTLOOK-PARITY.md`](docs/OUTLOOK-PARITY.md).
- **Conversation stacking** — when **Settings → Mail → Group messages by conversation** is on, the reading pane shows a stacked transcript for multi-message threads (`ConversationStack.svelte`). Collapsed siblings show a paperclip hint; expanding a message lists attachment filenames in the stack. HTML bodies in the stack use the same sanitized iframe rendering as the main reading pane (not plain text only).

![Conversation attachment chips](docs/assets/outlook-slice30/60-conversation-attachment-chips.png)

![Conversation stack HTML body](docs/assets/outlook-slice42/72-conversation-stack-html.png)
- **Reading pane position** — **right** (default), **bottom**, or **hidden** (list full width; opening a message uses a flyout). Change it in **Settings → Mail → Reading pane**, the layout control in the message list header, or with **Alt+Shift+R** (right), **Alt+Shift+B** (bottom), or **Alt+Shift+H** (hidden).
- **Folder Favorites** — pin common folders above the tree (Inbox / Sent / Drafts by default); reorder and edit via the sidebar context menu.
- **Natural-language search (opt-in)** — with **AI features** on and a configured provider, enable **Settings → AI → Natural-language search** to translate plain-language header queries into tag syntax (`from:`, `has:attachment`, …). Tag syntax is always available without AI.
- **Thread summary in AI panel (opt-in)** — enable **Settings → AI → Summarize conversation in AI panel** to send the full grouped thread (not just the selected message) when you click Summarize in the reading-pane AI tools. Off by default.
- **Compose rewrite tones (opt-in)** — enable **Settings → AI → Rewrite selected text in compose** to show tone buttons (Professional, Friendly, Concise, …) when you select text in the rich editor. Uses your configured provider; off by default.

![Compose rewrite bar](docs/assets/outlook-slice28/58-compose-rewrite-bar.png)

- **Smart triage colour categories (opt-in)** — enable **Settings → AI → Apply colour categories from AI triage**. On the **AI sorted** filter, click **Apply colour categories** to map triage buckets (human, marketing, …) to Outlook colour stripes. Off by default; nothing changes until you apply.

![Smart triage apply banner](docs/assets/outlook-slice49/79-ai-smart-triage-apply-banner.png)

- **Quick filter bar** — Outlook-style **Filter** menu (All, Unread, Flagged, To me, Has files, Mentions me) and **Sort** menu on the message list; IMAP tag tokens for supported filters when paging server-side.
- **Colour categories** — right-click **Categorize** on a message row to assign Outlook-style colour categories (IMAP `$Category*` keywords when the server keeps them; local overlay fallback otherwise). A colour stripe appears on the row.
- **AI features off by default** — new profiles load with **Settings → AI → AI features** off. Turn it on when you want the assistant, AI sort, link safety, compose helpers, and related surfaces. The mail UI is fully usable with AI disabled.

![Focused inbox tab](docs/assets/outlook-slice1/26-inbox-focused-tab.png)

![Reading pane at bottom](docs/assets/outlook-slice3/30-reading-pane-bottom.png)

![Natural-language search hint](docs/assets/outlook-slice5/34-nl-search-hint.png)

![Quick filter menu](docs/assets/outlook-slice6/35-quick-filter-menu-open.png)

![Message category stripe](docs/assets/outlook-slice7/36-message-category-stripe.png)

![Keyboard shortcuts help](docs/assets/outlook-slice8/37-keyboard-shortcuts-help.png)

- **Pin & snooze** — hover a row for **Pin to top** (stays above the current sort) or right-click **Snooze** (Later today / Tomorrow / Next week). Snoozed mail hides until the reminder time. **Flag for follow-up** uses the star control and `\Flagged` on the server.

![Pinned message row](docs/assets/outlook-slice9/38-pinned-message-row.png)

- **Sweep** — right-click **Sweep** on a message to bulk-handle every message from that sender in the folder: delete all, keep only the latest, or move all to Archive (uses server `from:` search, not just the visible page).

![Sender sweep menu](docs/assets/outlook-slice10/39-sender-sweep-menu.png)

- **Quick steps** — select one or more messages (row checkbox) to show **Quick steps** beside Filter/Sort: **Done** (read + archive), **Mark read & flag**, **Move to Junk**, **Move to Deleted Items**. Each step runs its actions in order via IMAP flags and bulk move.

![Quick steps menu](docs/assets/outlook-slice11/40-quick-steps-menu.png)

- **Undo send** — Settings → Compose → **Delay before sending** (default 5 seconds, 0 to disable). After **Send**, the toast offers **Undo** until the delay ends; **Shift+Send** sends immediately without the window.

![Undo send toast](docs/assets/outlook-slice12/41-undo-send-toast.png)

![Schedule send dialog](docs/assets/outlook-slice13/42-schedule-send-dialog.png)

- **Save draft** — explicit **Save draft** button in compose (and **Ctrl+S**). Appends RFC822 to your IMAP **Drafts** folder with the `\\Draft` flag; works even when SMTP send is disabled on the server.

![Save draft in compose](docs/assets/outlook-slice14/43-save-draft-compose.png)

- **Compose pop-out** — **Open in new window** in the compose title bar moves your draft into a dedicated browser window so you can keep reading mail in the main tab.

![Compose pop-out window](docs/assets/outlook-slice15/44-compose-pop-out.png)

- **Message links** — **Copy link** in the reading pane copies a shareable URL with `#mail?folder=…&uid=…`. Opening that hash (bookmark, paste in address bar) returns to the same folder and message.

![Mail deep link reading pane](docs/assets/outlook-slice16/45-mail-deep-link.png)

- **Landmarks & skip links** — OWA-style regions (**Command bar**, **Mail folders**, **Message list**, **Reading pane**) plus **Skip to message list** and, when a message is open, **Skip to reading pane** (visible on keyboard focus). Documented under **Settings → General → Accessibility**.

![Skip link focused](docs/assets/outlook-slice17/46-skip-link-focused.png)

![Skip to reading pane focused](docs/assets/outlook-slice48/78-skip-reading-pane-focused.png)

- **Reading pane quick reply** — OWA-style inline reply box at the bottom of the message: click **Reply to …**, type, **Send** (respects undo-send delay), **Discard**, or **Open full reply** for the compose window.

![Reading pane quick reply expanded](docs/assets/outlook-slice52/82-reading-pane-quick-reply-expanded.png)

- **Reading pane focus** — opening a message moves keyboard focus to the **Reading pane** landmark (docked pane or hidden-layout slide-over). Press **Esc** to close the message and return focus to the **Message list**. Documented under **Settings → General → Accessibility**.

![Desktop reading pane focused](docs/assets/outlook-slice41/71-desktop-reading-pane-focused.png)

![Message list focused after Esc](docs/assets/outlook-slice43/73-message-list-focused-after-esc.png)

- **Compose focus return** — closing compose with **Discard** (or after send) moves keyboard focus back to the **Message list** landmark for a new message, or to the **Reading pane** when you were replying or forwarding (pairs with mobile slice 46).

![Message list focused after closing compose](docs/assets/outlook-slice45/75-compose-close-message-list-focused.png)

- **Follow-up flags** — right-click **Flag** to set **Today**, **Tomorrow**, **This week**, or **No date**; the list shows a follow-up hint (e.g. “Follow up today”). Due dates stay in this browser; `\Flagged` syncs with IMAP.

![Follow-up today on message row](docs/assets/outlook-slice18/47-follow-up-today-row.png)

- **Mobile Focused / Other** — the `/webmail/mobile/` inbox uses the same deterministic Focused vs Other split as desktop (shared `inboxTab` setting). Tabs hide during search and outside INBOX.

![Mobile inbox Focused tab](docs/assets/outlook-slice19/48-mobile-inbox-focused-tab.png)

- **Mobile conversation stack** — with **Group threads** on, opening a multi-message thread on `/webmail/mobile/` shows the same Outlook-style transcript as desktop (**Show message** on older siblings). Single messages keep the normal reader.

![Mobile conversation stack](docs/assets/outlook-slice20/50-mobile-conversation-stack.png)

- **Mobile theme (dark mode)** — **Settings → Appearance → Theme** picks Auto, Light, or Dark (same `webmail.theme` key as desktop). Message bodies render with a dark iframe background when the app is in dark mode.

![Mobile Settings dark theme](docs/assets/outlook-slice22/52-mobile-settings-dark-theme.png)

- **Tablet reading pane** — at **768px+** width, `/webmail/mobile/` docks the message list and reading pane side-by-side (or stacked when **Reading pane → Bottom**), using the same **`readingPaneLayout`** setting as desktop. **Hide** keeps phone-style full-screen reading.

![Tablet split reading pane](docs/assets/outlook-slice24/54-tablet-split-reading-pane.png)

- **Mobile keyboard shortcuts (external keyboard)** — press **?** in the inbox (or **Settings → Keyboard shortcuts**) for an OWA-style chord list. **J** / **K**, **Enter**, **N**, **E**, **/**, and reply keys work on tablet or phone with a Bluetooth keyboard; touch-only use is unchanged.

![Mobile keyboard shortcuts help](docs/assets/outlook-slice25/55-mobile-keyboard-shortcuts-help.png)

- **Mobile Snooze & Sweep** — long-press a message for **Snooze** presets (same local overlay as desktop) or **Sweep** bulk actions for the sender (delete all / keep latest / archive all).

![Mobile snooze menu](docs/assets/outlook-slice26/56-mobile-snooze-menu.png)

- **Mobile Filter / Sort bar** — Outlook-style **Filter** and **Sort** menus on `/webmail/mobile/` share **`settings.listFilter`** and **`settings.listSort`** with desktop (All, Unread, Flagged, To me, Has files, Mentions me; full sort list). Optional **AI sort** chip when AI features are on.

![Mobile quick filter menu](docs/assets/outlook-slice27/57-mobile-quick-filter-menu.png)

- **Saved searches** — save a header search (folder or **Search all folders** scope) with a name; reopen from the search dropdown (localStorage only, no AI required). On mobile, the same saved list appears when you focus the inbox search field.

![Saved searches menu](docs/assets/outlook-slice29/59-saved-searches-menu.png)

- **Search refiners** — while a search is active, OWA-style chips under the message list header toggle tag refiners (`has:attachment`, `is:unread`, …) on the query without retyping.

![Search refiners](docs/assets/outlook-slice50/80-search-refiners-active.png)

- **Search categories (Mail / People / Files)** — OWA-style tabs under the header search. **People** searches your address book and opens compose to the contact you pick. **Files** runs the same mail search scoped to **`has:attachment`** (shows an **Attachments only** chip in the list).

![Search category Files](docs/assets/outlook-slice51/81-search-category-files.png)

![Mobile saved searches panel](docs/assets/outlook-slice31/61-mobile-saved-searches-panel.png)

- **Mobile colour categories** — long-press a message for **Categorize** (same OWA colour categories and `webmail.message-categories.v1` overlay as desktop). Rows show a left colour stripe when categorized.

![Mobile category stripe](docs/assets/outlook-slice32/62-mobile-category-green-row.png)

- **Mobile landmarks & skip link** — OWA-style **Command bar**, **App navigation**, **Message list**, and **Reading pane** regions on `/webmail/mobile/`, plus **Skip to message list** (keyboard focus). Documented under mobile **Settings → Accessibility**.

![Mobile skip link focused](docs/assets/outlook-slice33/63-mobile-skip-link-focused.png)

- **Mobile reading & list focus** — opening a message moves focus to the **Reading pane** landmark; **Esc** (or back) from full-screen reading returns focus to the **Message list** landmark (tablet split unchanged). Documented under mobile **Settings → Accessibility**.

![Mobile message list focused after Esc](docs/assets/outlook-slice44/74-mobile-message-list-focused-after-esc.png)

- **Mobile compose focus return** — closing compose from the inbox (close, back, or **Discard**) returns keyboard focus to the **Message list** landmark; replying from a full-screen message returns focus to the **Reading pane**. Documented under mobile **Settings → Accessibility**.

![Mobile message list focused after closing compose](docs/assets/outlook-slice46/76-mobile-compose-close-message-list-focused.png)

- **Mobile pin to top** — long-press a message and choose **Pin to top** (same `webmail.message-pin-snooze.v1` overlay as desktop). Pinned rows show a pin icon and stay at the top of the list.

![Mobile pinned row](docs/assets/outlook-slice34/64-mobile-pinned-row.png)

- **Mobile undo send** — same delayed-send window as desktop (`settings.undoSendSeconds`). After **Send**, the toast offers **Undo** to restore the compose draft. Configure under mobile **Settings → Compose**.

![Mobile undo send toast](docs/assets/outlook-slice35/65-mobile-undo-send-toast.png)

- **Mobile schedule send** — **Send** chevron → **Schedule send** (same `webmail.scheduled-sends.v1` queue and presets as desktop slice 13). The message stays on-device until the chosen time.

![Mobile schedule send dialog](docs/assets/outlook-slice36/66-mobile-schedule-send-dialog.png)

- **Mobile save draft** — explicit **Save draft** in compose (and **Ctrl+S** with a hardware keyboard). Appends RFC822 to IMAP **Drafts** with the `\\Draft` flag; works when SMTP send is disabled.

![Mobile save draft compose](docs/assets/outlook-slice37/67-mobile-save-draft-compose.png)

- **Mobile compose accessibility** — labelled **Compose message**, **Message fields**, and **Compose actions** regions; focus moves to **To** when compose opens. Documented under mobile **Settings → Accessibility**.

![Mobile compose To field focused](docs/assets/outlook-slice38/68-mobile-compose-to-focused.png)

- **Mobile compose discard confirmation** — closing compose or pressing hardware back with unsaved changes shows **Keep editing**, **Save draft**, and **Discard** (same overlay stack as other mobile sheets).

![Mobile compose discard sheet](docs/assets/outlook-slice39/69-mobile-compose-discard-sheet.png)

## Keyboard shortcuts (mail)

Global shortcuts are listed under **Settings → General → Keyboard shortcuts** (press **?** in the inbox for the same list). Reading-pane placement:

| Chord | Action |
|-------|--------|
| **↑ / ↓** or **J / K** | Previous / next message |
| **N** | New message |
| **R** | Reply |
| **Shift+R** | Reply all |
| **Shift+F** | Forward |
| **E** | Archive |
| **Delete** | Move to Trash |
| **Q** / **U** | Mark read / unread |
| **Insert** | Flag or unflag |
| **/** | Focus search |
| **?** | Show shortcuts |
| **Ctrl+Z** | Undo last move or delete |
| **Alt+Shift+R** | Reading pane on the **right** |
| **Alt+Shift+B** | Reading pane at the **bottom** |
| **Alt+Shift+H** | **Hide** reading pane (flyout when a message is open) |

## Screenshots

| | |
|---|---|
| ![AI panel](docs/screenshots/desktop-ai-panel.png) AI assistant panel (opt-in) | ![Compose](docs/screenshots/desktop-compose.png) Compose |
| ![Message](docs/screenshots/desktop-message-dark.png) Message reading (dark) | ![Mobile](docs/screenshots/mobile-inbox.png) Mobile/PWA inbox |
| ![Link safety](docs/screenshots/link-safety-prompt.png) Link-safety prompt | ![Inbox](docs/screenshots/outlook-inbox.png) Outlook inbox, light |

## What it includes

- Desktop mailbox UI: folders, search, filters, **Focused / Other** INBOX tabs, message detail, **conversation stacking**, **reading pane layout** (right / bottom / hidden), attachments, compose, reply, forward, right-click context menu and multi-select.
- Calendar and drive views backed by the REST API.
- Optional AI workflows (off by default): summarising, drafting, inbox sorting, action extraction, translation, phishing checks, link-safety checks and TTS when you enable **AI features** in Settings and configure a provider.
- Tracking, sender policy, blocked recipients, shortcuts, density, theme, and PWA install surfaces.
- Mobile entry point with an iOS Mail-inspired layout for inbox, message reading, compose, folders and settings.

## AI and key privacy

The browser never receives a provider API key. AI requests go to `POST /v1/ai/llm/chat/completions` on the API, authenticated with the session token the client already holds; the server attaches the provider key and forwards the request. `GET /v1/ai/config` reports `proxied: true` and a same-origin base URL, so the client treats it like any other OpenAI-compatible endpoint.

This replaces an earlier design that brokered per-user scoped keys through LiteLLM and shipped them to the browser — handing a key to a public static frontend means anyone who can read the page can use it. Browser-local user keys still work for personal use (Settings → AI), but they are not a safe way to distribute one shared key to all users.

## Development

```sh
npm install
VITE_DEV_API_TARGET=http://localhost:3001 npm run dev
npm run check
npm run build          # writes webmail/dist/, excluded from the Docker context
```

Run these from this `webmail/` directory. `VITE_DEV_API_TARGET` points the Vite dev proxy at a local API; in production the API serves the built files directly and no proxy is involved.

To refresh committed README screenshots (mock API only, fixed 1440×900 / 390×844 viewports):

```sh
npm run docs:screenshots
```

`npm run check` is `svelte-check --tsgo`: it type-checks with the native Go
compiler instead of `tsc`. That needs two TypeScript installs side by side —
`typescript` stays on the 6.x line because svelte-check peers `^5 || ^6`, and
`@typescript/native-preview` supplies the `tsgo` binary svelte-check shells out
to. (The stable `typescript@7` package ships the same native compiler under a
`tsc` bin name; installing it as an npm alias is the alternative recipe, but
its `tsc` bin would then shadow the real TypeScript 6 `tsc` in
`node_modules/.bin`, so the preview package is used instead.) `tsc` in
`node_modules/.bin` therefore still reports 6.x; `tsgo` reports the 7.x
nightly. `--tsgo` writes its transpiled overlay into `.svelte-check/`
(gitignored).


To test a build the way production serves it, point the API at it:

```sh
cd .. && WEBMAIL_DIST=./webmail/dist npm start
# then open http://localhost:3001/webmail/
```

The API Swagger UI lives at `/` on the API service, or `/mailcow-rest-api/` if you use the public API setup script from the API repo.
