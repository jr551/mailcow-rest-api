# Outlook.com web parity plan

Long-term goal: make `/webmail` a **faithful clone of Outlook.com webmail**, with **optional AI** that is **off by default**, enabled only when the user turns it on and configures a provider (referenced by setting name only). The app must work fully without AI (summarise thread, draft/rewrite reply, smart triage, natural-language search are additive, not required).

Work lands via PRs into `master` (Outlook parity slices #83–#86 merged in v0.27.0).

Testing: mocks/fixtures and Playwright; no live mailcow or real credentials.

---

## Current audit (baseline on `outlook-clone`)

| Outlook.com area | Today | Gap severity |
|------------------|-------|--------------|
| **App chrome / command bar** | Outlook skin default (`skins.svelte.ts`), top search, account menu, app rail (Mail / Calendar / AI / Drive) | Medium: rail is broader than OWA; unify launcher later |
| **Folder pane** | `Sidebar.svelte` tree, **Favorites** pin list, drag-drop move, shortcuts row | Medium: no folder groups |
| **Message list** | `MessageList.svelte`, density, **Outlook Filter / Sort** menus, **colour categories**, **pin / snooze**, **Sweep**, **Quick steps** on selection | Low–medium: richer row chrome |
| **Focused / Other** | `focused-inbox.ts` + INBOX tabs | Low–medium: optional AI refinement later |
| **Reading pane** | `MessageDetail.svelte`, reply/forward, conversation stack when grouped | Low–medium: richer HTML parity; pane position done (slice 3) |
| **Conversation view** | List grouping via `threads.ts`; reading-pane stack via `conversation-view.ts` + `ConversationStack.svelte` | Low–medium: richer HTML parity |
| **Compose** | `Compose.svelte` + `FloatingPanel.svelte`, TipTap | Medium: sensitivity labels; **undo send** (slice 12), **scheduled send** (#100), **Save draft** (slice 14) |
| **Search** | Header search + tag syntax; **saved searches** (local) on desktop and mobile; optional **natural-language** translation when AI + provider configured | Medium: no unified People/Files search |
| **Settings shell** | `Settings.svelte` 3-column Outlook-like modal, 19 sections | Low–medium: content differs |
| **AI features** | Master switch **`aiFeatures`**; defaults **off** for new profiles; every AI entry point hidden when off | Low — opt-in provider config remains in Settings |
| **People / VIP** | VIP list in Settings; local address book | Medium vs OWA People app |
| **Deep links** | `#mail?folder=…&uid=…` hash URLs + **Copy link** in reading pane | Low–medium: no server-side permalink API yet |
| **Accessibility** | Landmark regions + skip link (slice 17); mobile landmarks + skip link (slice 33); mobile compose landmarks + initial focus (slice 38); mobile reading-pane focus on open (slice 40) | Low–medium: deeper mobile focus-order polish |

---

## Prioritised roadmap

### P0 — Layout & mail core (no AI required)

1. **Focused / Other inbox tabs** on INBOX (deterministic rules; optional AI refinement later) — **slice 1 (done)**.
2. **Reading-pane conversation view**: stack thread messages in `MessageDetail` when `groupThreads` is on — **slice 2 (done)**.
3. **Reading pane layout** setting: right (default) / bottom / hidden (OWA “Reading pane”) — **slice 3 (this PR)**.
4. **Favorites** above folder tree (pinned folders, localStorage) — **slice 4 (this PR)**.

### P1 — Search & triage

5. **Natural-language search** (only when AI + user provider configured); fallback keeps tag syntax — **slice 5 (done)**.
6. **Quick filter bar** parity (Filter: All / Unread / Flagged / To me / Has files / Mentions; Sort menu) — **slice 6 (done in #93)**.
7. **Categories / flags** (user-assigned colours) synced via IMAP keywords or local overlay — **slice 7 (done in #94)**.
8. **Global mail keyboard shortcuts** (OWA chords + **?** help) — **slice 8 (this PR)**.

### P2 — Compose & handling

9. **Sweep** one-click on message row (align with Settings → Sweep) — **slice 10 (done in #97)**.
10. **Quick Steps** templated multi-action shortcuts on selected mail — **slice 11 (#98)**.
11. **Undo send** delay with toast — **slice 12 (this PR)**.
12. Scheduled send, explicit Save draft UX — **scheduled send (slice 13, this PR)**; undo send done in slice 12 (#99).

### P3 — AI (opt-in only)

11. Default **`aiFeatures: false`** for new profiles; master switch hides every AI entry point — **done (v0.27.0)**.
12. User-named LLM provider in settings only (no server-side default key in UI copy).
13. Thread summarise, draft/rewrite, smart triage, NL search — each gated on AI + provider.

### P4 — Polish & mobile

14. Mobile: Focused/Other + conversation reader parity.
15. Deep links and shareable message URLs.
16. Accessibility pass (pane landmarks, tab order vs OWA).

---

## Slice 1 (merged)

- **`webmail/src/lib/focused-inbox.ts`**: classify messages into Focused vs Other without AI.
- **`MessageList.svelte`**: Outlook-style **Focused | Other** tabs when viewing INBOX (hidden during search or other folders).
- **`settings.inboxTab`**: persisted preference (`focused` | `other`).
- Tests: unit (`focused-inbox.test.mjs`) + Playwright (`outlook-focused-inbox.spec.ts`) against API mocks.
- Screenshots: `webmail/docs/assets/outlook-slice1/26-inbox-focused-tab.png`, `27-inbox-other-tab.png` (regenerate with `npm run docs:screenshots` in `webmail/`).

---

## Slice 2 (done)

- **`webmail/src/lib/conversation-view.ts`**: thread lookup, chronological order, expand/collapse rules.
- **`ConversationStack.svelte`**: Outlook-style transcript in the reading pane (selected message expanded, older siblings collapsed with “Show message”).
- **`Layout.svelte`**: loads sibling message bodies when `groupThreads` is on and the selection is part of a multi-message thread.
- **`store.svelte.ts`**: `conversationStack`, `conversationDetails`, `conversationLoading`.
- Tests: unit (`conversation-view.test.mjs`) + Playwright (`outlook-conversation-view.spec.ts`) with threaded fixtures.
- Screenshots: `webmail/docs/assets/outlook-slice2/28-conversation-stack-collapsed.png`, `29-conversation-stack-expanded.png`.

---

## Slice 3 (done)

- **`webmail/src/lib/reading-pane-layout.ts`**: layout type, sanitise, keyboard chords (Alt+Shift+R/B/H).
- **`settings.readingPaneLayout`**: persisted `right` | `bottom` | `hidden` (default right).
- **`Layout.svelte`**: grid layouts for right/bottom; hidden mode uses full-width list + slide-over flyout when a message is open; resizable list height in bottom mode.
- **`Settings.svelte`** + **`MessageList.svelte`**: Outlook-style layout picker and quick header control.
- Tests: unit (`reading-pane-layout.test.mjs`) + Playwright (`outlook-reading-pane-layout.spec.ts`) against API mocks.
- Screenshots: `webmail/docs/assets/outlook-slice3/30-reading-pane-bottom.png`, `31-reading-pane-hidden-flyout.png`.

---

## Slice 4 (implemented in this PR)

- **`webmail/src/lib/folder-favorites.ts`**: sanitize, OWA default favorites (Inbox / Sent / Drafts), reorder, remap on rename.
- **`webmail/src/lib/folder-favorites.svelte.ts`**: `webmail.folder-favorites.v1` localStorage persistence.
- **`Sidebar.svelte`**: **Favorites** section above the folder tree; context menu **Add to / Remove from Favorites**; drag to reorder; message drop targets.
- **`Layout.svelte`**: keep favorites in sync when folders are renamed or deleted.
- Tests: unit (`folder-favorites.test.mjs`) + Playwright (`outlook-folder-favorites.spec.ts`) against API mocks.
- Screenshots: `webmail/docs/assets/outlook-slice4/32-folder-favorites-default.png`, `33-folder-favorites-custom.png`.

---

## Slice 5 (done)

- **`webmail/src/lib/natural-language-search.ts`**: tag-syntax detection, response parsing, sanitization.
- **`webmail/src/lib/natural-language-search.client.ts`**: opt-in translation via configured provider (`cachedChatCompletion`, scope `nl-search`).
- **`settings.naturalLanguageSearch`**: default **off**; toggle in Settings → AI (only when `aiFeatures` is on).
- **`Layout.svelte`**: debounced NL translation before IMAP search; shows `search-nl-hint` with the tag query used.
- Tests: unit (`natural-language-search.test.mjs`) + Playwright (`outlook-nl-search.spec.ts`) against API mocks.
- Screenshot: `webmail/docs/assets/outlook-slice5/34-nl-search-hint.png`.

---

## Slice 6 (done)

- **`webmail/src/lib/list-quick-filters.ts`**: Outlook Filter menu values, To me / Mentions heuristics, Sort comparators, IMAP filter tokens.
- **`MessageList.svelte`**: **Filter** and **Sort** dropdowns (replaces chip row); `settings.listSort` persisted.
- **`Layout.svelte`**: server-side search tokens for To me (`to:`) and Mentions (`body:@localpart`).
- Tests: unit (`list-quick-filters.test.mjs`) + Playwright (`outlook-quick-filter-bar.spec.ts`) against API mocks.
- Screenshot: `webmail/docs/assets/outlook-slice6/35-quick-filter-menu-open.png`.

---

## Slice 7 (done)

- **`webmail/src/lib/message-categories.ts`**: OWA colour categories, `$Category*` IMAP keywords, flag merge helpers.
- **`webmail/src/lib/message-categories.svelte.ts`**: `webmail.message-categories.v1` local overlay when the server drops custom keywords.
- **`MessageList.svelte`**: list colour stripe + **Categorize** context submenu; **`Layout.svelte`**: persists via `modifyFlags` with overlay fallback.
- Tests: unit (`message-categories.test.mjs`) + Playwright (`outlook-message-categories.spec.ts`) against API mocks.
- Screenshot: `webmail/docs/assets/outlook-slice7/36-message-category-stripe.png`.

---

## Slice 8 (done)

- **`webmail/src/lib/mail-keyboard-shortcuts.ts`**: OWA-style global mail chords (navigation, compose, reply, archive, delete, read/unread, flag, search, help, undo).
- **`MailShortcutHelp.svelte`**: **?** shortcut reference dialog; **Settings → General → Keyboard shortcuts** lists the same table.
- **`Layout.svelte`**: wires shortcuts when focus is not in an input (reading-pane Alt+Shift chords unchanged).
- Tests: unit (`mail-keyboard-shortcuts.test.mjs`, `web-shell.test.mjs`) + Playwright (`outlook-mail-keyboard-shortcuts.spec.ts`) against API mocks.
- Screenshot: `webmail/docs/assets/outlook-slice8/37-keyboard-shortcuts-help.png`.

---

## Slice 9 (done)

- **`webmail/src/lib/message-pin-snooze.ts`**: pin-to-top ordering, snooze presets, local overlay (`webmail.message-pin-snooze.v1`).
- **`message-pin-snooze.svelte.ts`**: hydrate, toggle pin, snooze until wake time.
- **`MessageList.svelte`**: row **Pin** control, **Snooze** context submenu, follow-up flag wording; snoozed rows hidden until due.
- Tests: unit (`message-pin-snooze.test.mjs`) + Playwright (`outlook-pin-snooze.spec.ts`) against API mocks.
- Screenshot: `webmail/docs/assets/outlook-slice9/38-pinned-message-row.png`.

---

## Slice 10 (done)

- **`webmail/src/lib/message-sender-sweep.ts`**: OWA **Sweep** actions (delete all / keep latest / archive all) scoped to the current folder via `from:` search.
- **`message-sender-sweep-fetch.ts`**: loads matches with `listMessages` + `from:` token before selection.
- **`MessageList.svelte`**: **Sweep** context submenu on rows with a From address; bulk move through existing `bulkMove` helper.
- Tests: unit (`message-sender-sweep.test.mjs`) + Playwright (`outlook-sender-sweep.spec.ts`) against API mocks (search + move routes in `fixtures.ts`).
- Screenshot: `webmail/docs/assets/outlook-slice10/39-sender-sweep-menu.png`.

---

## Slice 11 (done in #98)

- **`webmail/src/lib/message-quick-steps.ts`**: built-in OWA-style steps (**Done**, **Mark read & flag**, **Move to Junk**, **Move to Deleted Items**) as ordered multi-actions.
- **`message-quick-steps.svelte.ts`**: `webmail.message-quick-steps.v1` enabled-step persistence.
- **`MessageList.svelte`**: **Quick steps** dropdown in the list toolbar when one or more rows are selected; runs `modifyFlags` + `bulkMove` in sequence.
- Tests: unit (`message-quick-steps.test.mjs`) + Playwright (`outlook-quick-steps.spec.ts`) against API mocks.
- Screenshot: `webmail/docs/assets/outlook-slice11/40-quick-steps-menu.png`.

---

## Slice 12 (done in #99)

- **`webmail/src/lib/undo-send.ts`**: undo-send delay sanitization (0–30s, default 5).
- **`undo-send.svelte.ts`**: queues `sendStub` until the window expires; **Undo** restores compose from a snapshot.
- **`settings.undoSendSeconds`**: Settings → Compose; **Shift+Send** bypasses the delay.
- **`Compose.svelte`**: schedules delayed send; **`Layout.svelte`**: toast **Undo** button.
- Tests: unit (`undo-send.test.mjs`) + Playwright (`outlook-undo-send.spec.ts`) against API mocks.
- Screenshot: `webmail/docs/assets/outlook-slice12/41-undo-send-toast.png`.

---

## Slice 13 (done in #100)

- **`webmail/src/lib/scheduled-send.ts`**: OWA-style schedule presets, send-at sanitization (1 minute – 30 days).
- **`scheduled-send.svelte.ts`**: `webmail.scheduled-sends.v1` local queue; **`Layout.svelte`** flushes due sends via `sendStub`.
- **`Compose.svelte`**: **Send** split menu → **Schedule send** dialog (presets + datetime picker).
- Tests: unit (`scheduled-send.test.mjs`) + Playwright (`outlook-scheduled-send.spec.ts`) against API mocks.
- Screenshot: `webmail/docs/assets/outlook-slice13/42-schedule-send-dialog.png`.

---

## Slice 14 (done in #101)

- **`webmail/src/lib/compose-draft.ts`**: RFC822 builder + Drafts folder resolution for IMAP APPEND.
- **`compose-draft.svelte.ts`**: **`saveComposeDraftToImap`** via `/v1/mailboxes/:path/messages?flags=Draft`.
- **`Compose.svelte`**: explicit **Save draft** button, **Ctrl+S**, and working save when SMTP is disabled.
- **`Settings.svelte`**: Compose section documents save behaviour.
- Tests: unit (`compose-draft.test.mjs`) + Playwright (`outlook-save-draft.spec.ts`) against API mocks.
- Screenshot: `webmail/docs/assets/outlook-slice14/43-save-draft-compose.png`.

---

## Slice 15 (done in #102)

- **`webmail/src/lib/compose-popout.ts`**: sessionStorage hand-off, pop-out URL builder, `window.open` helper.
- **`ComposePopoutShell.svelte`** + **`App.svelte`**: `?composePopout=1&sid=…` route renders compose-only shell.
- **`FloatingPanel.svelte`**: **Open in new window** title-bar control; hidden in the pop-out itself.
- **`Compose.svelte`**: snapshots in-progress fields into the session before opening the child window.
- Tests: unit (`compose-popout.test.mjs`) + Playwright (`outlook-compose-popout.spec.ts`) against API mocks.
- Screenshot: `webmail/docs/assets/outlook-slice15/44-compose-pop-out.png`.

---

## Slice 16 (done in #103)

- **`webmail/src/lib/mail-deep-link.ts`**: parse/build `#mail?folder=…&uid=…` hash links; clipboard helper.
- **`Layout.svelte`**: syncs hash on message selection; applies hash on load and `hashchange`.
- **`MessageDetail.svelte`**: **Copy link** button in the reading-pane toolbar.
- **`Settings.svelte`**: General section documents shareable message URLs.
- Tests: unit (`mail-deep-link.test.mjs`) + Playwright (`outlook-mail-deep-link.spec.ts`) against API mocks.
- Screenshot: `webmail/docs/assets/outlook-slice16/45-mail-deep-link.png`.

---

## Slice 17 (done in #104)

- **`webmail/src/lib/mail-landmarks.ts`**: OWA-aligned region labels and skip-link target ids.
- **`Layout.svelte`**: **Skip to message list** link, `banner` command bar, folder **`navigation`**, message list **`region`**, reading pane **`main`** landmark; flyout reading pane uses the same label.
- **`Settings.svelte`**: **General → Accessibility** documents landmarks and tab order.
- Tests: unit (`mail-landmarks.test.mjs`) + Playwright (`outlook-mail-landmarks.spec.ts`) against API mocks.
- Screenshot: `webmail/docs/assets/outlook-slice17/46-skip-link-focused.png`.

---

## Slice 18 (done in #105)

- **`webmail/src/lib/message-follow-up.ts`**: OWA-style follow-up due presets (Today / Tomorrow / This week / No date).
- **`message-follow-up.svelte.ts`**: `webmail.message-follow-up.v1` local due-date overlay; `\Flagged` on the server.
- **`MessageList.svelte`**: **Flag** context submenu; row hint (e.g. “Follow up today”).
- **`Layout.svelte`**: applies presets via `modifyFlags` + overlay; star toggle clears due dates.
- **`Settings.svelte`**: General section documents follow-up flags.
- Tests: unit (`message-follow-up.test.mjs`) + Playwright (`outlook-follow-up-flag.spec.ts`) against API mocks.
- Screenshot: `webmail/docs/assets/outlook-slice18/47-follow-up-today-row.png`.

---

## Slice 19 (done in #106)

- **`webmail/src/mobile/components/InboxView.svelte`**: **Focused | Other** tabs on mobile INBOX (same rules as desktop via `focused-inbox.ts`); `data-testid` row ids for e2e.
- **`settings.inboxTab`**: shared with desktop; persists across form factors.
- Tests: Playwright (`outlook-mobile-focused-inbox.spec.ts`) against API mocks.
- Screenshot: `webmail/docs/assets/outlook-slice19/48-mobile-inbox-focused-tab.png`.

---

## Slice 20 (done in #107)

- **`webmail/src/mobile/components/InboxView.svelte`**: loads sibling bodies when **Group threads** is on (same rules as desktop).
- **`webmail/src/mobile/components/MessageView.svelte`**: reuses **`ConversationStack.svelte`** with mobile state overrides.
- **`webmail/src/lib/conversation-view.ts`**: **`shouldShowConversationStack`** gate shared with desktop/mobile.
- **`ConversationStack.svelte`**: optional props for mobile message list + conversation details.
- Tests: unit (`conversation-view.test.mjs`) + Playwright (`outlook-mobile-conversation-view.spec.ts`) against API mocks.
- Screenshot: `webmail/docs/assets/outlook-slice20/50-mobile-conversation-stack.png`.

---

## Slice 21 (done in #108)

- **`webmail/src/mobile/components/MessageActionSheet.svelte`**: **Flag for follow-up** submenu (Today / Tomorrow / This week / No date), same presets as desktop.
- **`webmail/src/mobile/components/InboxView.svelte`**: follow-up due hints on rows (shared `message-follow-up` overlay).
- Tests: Playwright (`outlook-mobile-follow-up-flag.spec.ts`) against API mocks.
- Screenshot: `webmail/docs/assets/outlook-slice21/51-mobile-follow-up-today-row.png`.

---

## Slice 22 (done in #109)

- **`webmail/src/lib/mobile-appearance.ts`**: mobile theme mode list + **`messageIframeTheme`** helper (uses `effectiveTheme()`, not `html.dark`).
- **`SettingsView.svelte`**: **Theme** segmented control (Auto / Light / Dark), shared `webmail.theme` with desktop.
- **`MessageView.svelte`**: message-body iframe follows the resolved app theme in dark mode.
- Tests: unit (`mobile-appearance.test.mjs`) + Playwright (`outlook-mobile-dark-mode.spec.ts`) against API mocks.
- Screenshot: `webmail/docs/assets/outlook-slice22/52-mobile-settings-dark-theme.png`.

---

## Slice 23 (done in #110)

- **`webmail/src/lib/thread-ai-summarize.ts`**: build single-message or full-thread text for `/v1/ai/summarize`.
- **`settings.aiThreadSummary`**: default **off**; toggle in Settings → AI (requires `aiFeatures` + configured provider).
- **`AiPanel.svelte`**: **Summarize thread** when grouping + toggle are on and the reading pane shows a multi-message stack.
- Tests: unit (`thread-ai-summarize.test.mjs`) + Playwright (`outlook-ai-thread-summary.spec.ts`) against API mocks.
- Screenshot: `webmail/docs/assets/outlook-slice23/53-ai-thread-summary-panel.png`.

---

## Slice 24 (done in #111)

- **`webmail/src/lib/mobile-tablet-reading-pane.ts`**: tablet split breakpoint (768px+) and **`settings.readingPaneLayout`** axis (right = horizontal, bottom = vertical, hidden = phone full-screen).
- **`TabletMailShell.svelte`**: list + reading pane on tablet widths; **`MessageView`** **`embedded`** mode hides back navigation.
- **`App.svelte`**: viewport-aware shell; phone ↔ tablet transitions preserve selection.
- Tests: unit (`mobile-tablet-reading-pane.test.mjs`) + Playwright (`outlook-mobile-tablet-reading-pane.spec.ts`) against API mocks.
- Screenshot: `webmail/docs/assets/outlook-slice24/54-tablet-split-reading-pane.png`.

---

## Slice 25 (done in #112)

- **`webmail/src/lib/mobile-mail-keyboard-shortcuts.ts`**: OWA-style chords for `/webmail/mobile/` with an external keyboard; **`Enter`** opens the highlighted row.
- **`MobileMailShortcutHelp.svelte`**: bottom-sheet help (**?** or **Settings → Keyboard shortcuts**).
- **`InboxView.svelte`** / **`MessageView.svelte`**: handler bridge for list navigation, search focus, archive, reply, and related actions.
- Tests: unit (`mobile-mail-keyboard-shortcuts.test.mjs`) + Playwright (`outlook-mobile-keyboard-shortcuts.spec.ts`) against API mocks.
- Screenshot: `webmail/docs/assets/outlook-slice25/55-mobile-keyboard-shortcuts-help.png`.

---

## Slice 26 (done in #113)

- **`MessageActionSheet.svelte`**: **Snooze** and **Sweep** submenus on the mobile long-press sheet (same presets and sender sweep actions as desktop).
- **`InboxView.svelte`**: snooze overlay filtering + sender sweep via `resolveSenderSweepTargets` / `bulkMove`.
- Tests: Playwright (`outlook-mobile-snooze-sweep.spec.ts`) against API mocks.
- Screenshot: `webmail/docs/assets/outlook-slice26/56-mobile-snooze-menu.png`.

---

## Slice 27 (done in #114)

- **`MobileQuickFilterBar.svelte`**: mobile **Filter** / **Sort** menus (same `list-quick-filters.ts` options as desktop).
- **`InboxView.svelte`**: uses **`settings.listFilter`** / **`settings.listSort`** via `filterMessagesByOutlookFilter` and `sortWithPinnedFirst`; removes legacy segment chips.
- Tests: unit (`list-quick-filters.test.mjs` menu parity) + Playwright (`outlook-mobile-quick-filter-bar.spec.ts`) against API mocks.
- Screenshot: `webmail/docs/assets/outlook-slice27/57-mobile-quick-filter-menu.png`.

---

## Slice 28 (done in #115)

- **`webmail/src/lib/compose-ai-rewrite.ts`**: tone presets, prompt builder, selection eligibility.
- **`compose-ai-rewrite.client.ts`**: opt-in rewrite via configured provider (`cachedChatCompletion`, scope `compose-rewrite`).
- **`settings.aiRewriteCompose`**: default **off**; toggle in Settings → AI (requires `aiFeatures` + configured provider).
- **`RichEditor.svelte`** / **`Compose.svelte`**: selection handle + rewrite bar above the editor.
- Tests: unit (`compose-ai-rewrite.test.mjs`) + Playwright (`outlook-ai-compose-rewrite.spec.ts`) against API mocks.
- Screenshot: `webmail/docs/assets/outlook-slice28/58-compose-rewrite-bar.png`.

---

## Slice 29 (done in #116)

- **`saved-mail-searches.ts`** / **`saved-mail-searches.svelte.ts`**: named queries in `webmail.saved-searches.v1` (folder or all-folders scope).
- **`Layout.svelte`**: search dropdown lists saved searches, **Save this search**, remove control; reapplies scope when run.
- Tests: unit (`saved-mail-searches.test.mjs`) + Playwright (`outlook-saved-searches.spec.ts`) against API mocks.
- Screenshot: `webmail/docs/assets/outlook-slice29/59-saved-searches-menu.png`.

---

## Slice 30 (done in #117)

- **`conversation-attachments.ts`**: attachment hints from list metadata or loaded message bodies.
- **`ConversationStack.svelte`**: paperclip hint on collapsed siblings; filename chips when expanded (desktop + mobile stack).
- Tests: unit (`conversation-attachments.test.mjs`) + Playwright (`outlook-conversation-attachments.spec.ts`) against API mocks.
- Screenshot: `webmail/docs/assets/outlook-slice30/60-conversation-attachment-chips.png`.

---

## Slice 31 (done in #118)

- **`mobile-saved-search-panel.ts`**: panel visibility rules shared with unit tests.
- **`InboxView.svelte`**: mobile search panel lists saved searches, **Save this search**, and remove controls (shared `webmail.saved-searches.v1` with desktop).
- Tests: unit (`mobile-saved-search-panel.test.mjs`) + Playwright (`outlook-mobile-saved-searches.spec.ts`) against API mocks.
- Screenshot: `webmail/docs/assets/outlook-slice31/61-mobile-saved-searches-panel.png`.

---

## Slice 32 (done in #119)

- **`mobile-message-category.ts`**: row category resolution for all-folder search rows (shared with desktop overlay).
- **`MessageActionSheet.svelte`**: **Categorize** submenu (same colour categories as desktop slice 7).
- **`InboxView.svelte`**: list colour stripe + `modifyFlags` / local overlay when assigning categories on mobile.
- Tests: unit (`mobile-message-category.test.mjs`) + Playwright (`outlook-mobile-message-categories.spec.ts`) against API mocks.
- Screenshot: `webmail/docs/assets/outlook-slice32/62-mobile-category-green-row.png`.

---

## Slice 33 (done in #120)

- **`mobile-mail-landmarks.ts`**: mobile region labels, shared list landmark id, skip-link focus helper.
- **`InboxView.svelte`**: **Skip to message list** link, command bar + message list landmarks.
- **`MessageView.svelte`**: reading pane **`main`** landmark; **`BottomNav.svelte`**: **App navigation** label.
- **`SettingsView.svelte`**: **Accessibility** section documents landmarks and tab order.
- Tests: unit (`mobile-mail-landmarks.test.mjs`) + Playwright (`outlook-mobile-mail-landmarks.spec.ts`) against API mocks.
- Screenshot: `webmail/docs/assets/outlook-slice33/63-mobile-skip-link-focused.png`.

---

## Slice 34 (done)

- **`mobile-message-pin.ts`**: row mailbox path + pin state for all-folder search rows (shared `message-pin-snooze` overlay).
- **`MessageActionSheet.svelte`**: **Pin to top** / **Unpin** on the long-press sheet.
- **`InboxView.svelte`**: pin icon on rows, `data-pinned`, sort-with-pinned-first (same as desktop slice 9).
- Tests: unit (`mobile-message-pin.test.mjs`) + Playwright (`outlook-mobile-message-pin.spec.ts`) against API mocks.
- Screenshot: `webmail/docs/assets/outlook-slice34/64-mobile-pinned-row.png`.

---

## Slice 35 (done in #122)

- **`mobile-compose-undo.ts`**: toast copy helper shared with unit tests.
- **`compose-undo-send.svelte.ts`**: queues `sendStub` on mobile with **`mobileState.sendUndo`** + compose restore snapshot.
- **`ComposeView.svelte`**: honours **`settings.undoSendSeconds`** (same as desktop slice 12).
- **`App.svelte`**: **Undo** on the mobile toast; **`SettingsView.svelte`**: Compose **Undo send** seconds.
- Tests: unit (`mobile-compose-undo.test.mjs`) + Playwright (`outlook-mobile-undo-send.spec.ts`) against API mocks.
- Screenshot: `webmail/docs/assets/outlook-slice35/65-mobile-undo-send-toast.png`.

---

## Slice 36 (done in #123)

- **`mobile-compose-schedule.ts`**: queued-send toast copy for mobile.
- **`compose-schedule-send.svelte.ts`**: enqueue into shared scheduled-send queue with mobile toasts; background flush on mobile app mount.
- **`scheduled-send.svelte.ts`**: `enqueueScheduledSend` + injectable notify for mobile flush toasts.
- **`ComposeView.svelte`**: **Send** split button → **Schedule send** sheet (presets + datetime, same test ids as desktop); immediate **Send** still honours undo send (slice 35).
- **`App.svelte`**: 30s scheduled-send flusher while signed in.
- Tests: unit (`mobile-compose-schedule.test.mjs`) + Playwright (`outlook-mobile-scheduled-send.spec.ts`) against API mocks.
- Screenshot: `webmail/docs/assets/outlook-slice36/66-mobile-schedule-send-dialog.png`.

---

## Slice 37 (done in #124)

- **`mobile-compose-save-draft.ts`**: toast copy + plain-text → draft HTML helper.
- **`compose-save-draft.svelte.ts`**: **`saveMobileComposeDraft`** via shared `buildComposeDraftRfc822` / `appendRawMessage` (same as desktop slice 14).
- **`ComposeView.svelte`**: **Save draft** in the compose header, **Ctrl+S**, SMTP-off hint, **Send** split (slice 36) when SMTP is enabled.
- **`SettingsView.svelte`**: Compose **Save draft** documentation.
- Tests: unit (`mobile-compose-save-draft.test.mjs`) + Playwright (`outlook-mobile-save-draft.spec.ts`) against API mocks.
- Screenshot: `webmail/docs/assets/outlook-slice37/67-mobile-save-draft-compose.png`.

---

## Slice 38 (done in #125)

- **`mobile-compose-landmarks.ts`**: compose landmark id, OWA-style region labels, focus helpers.
- **`ComposeView.svelte`**: **Compose message** `<main>` landmark, labelled field/action regions, initial focus on **To**, focus moves into Send options / Schedule send sheets.
- **`SettingsView.svelte`**: Accessibility docs for compose regions.
- Tests: unit (`mobile-compose-landmarks.test.mjs`) + Playwright (`outlook-mobile-compose-a11y.spec.ts`) against API mocks.
- Screenshot: `webmail/docs/assets/outlook-slice38/68-mobile-compose-to-focused.png`.

---

## Slice 39 (done in #126)

- **`mobile-compose-discard.ts`**: unsaved-change detection, OWA-style discard copy.
- **`ComposeView.svelte`**: **Keep editing**, **Save draft**, and **Discard** sheet when closing compose or hardware back with unsaved content; shares overlay stack with other mobile sheets.
- **`SettingsView.svelte`**: Compose section documents discard confirmation.
- Tests: unit (`mobile-compose-discard.test.mjs`) + Playwright (`outlook-mobile-compose-discard.spec.ts`) against API mocks.
- Screenshot: `webmail/docs/assets/outlook-slice39/69-mobile-compose-discard-sheet.png`.

---

## Slice 40 (this PR)

- **`mobile-mail-landmarks.ts`**: **`focusMobileReadingPaneLandmark`** helper; reading-pane row copy mentions initial focus.
- **`MessageView.svelte`**: **Reading pane** `<main>` is focusable; full-screen message view moves focus there when a message loads (tablet embedded split unchanged).
- **`SettingsView.svelte`**: Accessibility docs for reading-pane focus on open.
- Tests: unit (`mobile-mail-landmarks.test.mjs`) + Playwright (`outlook-mobile-reading-focus.spec.ts`) against API mocks.
- Screenshot: `webmail/docs/assets/outlook-slice40/70-mobile-reading-pane-focused.png`.

---

## Next planned slice

**Smart triage / categorise** (opt-in AI), richer conversation HTML parity, or desktop reading-pane initial focus on message open.

---

## References

- Desktop layout: `webmail/src/components/Layout.svelte`
- List / filters: `webmail/src/components/MessageList.svelte`
- Reading: `webmail/src/components/MessageDetail.svelte`, `ConversationStack.svelte`
- Thread grouping: `webmail/src/lib/threads.ts`
- Settings: `webmail/src/components/Settings.svelte`
- E2E mocks: `webmail/test/e2e/fixtures.ts`
