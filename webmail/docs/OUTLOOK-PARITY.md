# Outlook.com web parity plan

Long-term goal: make `/webmail` a **faithful clone of Outlook.com webmail**, with **optional AI** that is **off by default**, enabled only when the user turns it on and configures a provider (referenced by setting name only). The app must work fully without AI (summarise thread, draft/rewrite reply, smart triage, natural-language search are additive, not required).

Work happens on branch **`outlook-clone`**. Changes land via PRs into `outlook-clone` only—not `master`—until the clone is ready to merge.

Testing: mocks/fixtures and Playwright; no live mailcow or real credentials.

---

## Current audit (baseline on `outlook-clone`)

| Outlook.com area | Today | Gap severity |
|------------------|-------|--------------|
| **App chrome / command bar** | Outlook skin default (`skins.svelte.ts`), top search, account menu, app rail (Mail / Calendar / AI / Drive) | Medium: rail is broader than OWA; unify launcher later |
| **Folder pane** | `Sidebar.svelte` tree, drag-drop move, shortcuts row | Medium: no Favorites pin list separate from tree; no groups |
| **Message list** | `MessageList.svelte`, density, filters (All/Unread/Starred/Attachments), optional AI sort | High: no Focused/Other (until slice 1); no quick categories/colour tags |
| **Focused / Other** | Was AI-sort only | **High** — slice 1 adds deterministic Focused/Other tabs on INBOX |
| **Reading pane** | `MessageDetail.svelte`, single message, reply/forward | High: no conversation stack in pane; no pane position (right/bottom/off) |
| **Conversation view** | List grouping via `threads.ts` + expand chevron | High: not OWA-style transcript in reading pane |
| **Compose** | `Compose.svelte` + `FloatingPanel.svelte`, TipTap | Medium: no scheduled send, undo send, sensitivity labels |
| **Search** | Header search + tag syntax; folder vs all scope | Medium: no unified People/Files search; no saved searches |
| **Settings shell** | `Settings.svelte` 3-column Outlook-like modal, 19 sections | Low–medium: content differs; AI defaults still need hard-off-by-default pass |
| **AI features** | Many surfaces; `aiFeatures` currently defaults on in stored settings | **High policy** — flip default off + hide all affordances when off (separate slice) |
| **People / VIP** | VIP list in Settings; local address book | Medium vs OWA People app |
| **Deep links** | Session storage only, no `/mail/...` URLs | Medium |

---

## Prioritised roadmap

### P0 — Layout & mail core (no AI required)

1. **Focused / Other inbox tabs** on INBOX (deterministic rules; optional AI refinement later) — **slice 1 (this PR)**.
2. **Reading-pane conversation view**: stack thread messages in `MessageDetail` when `groupThreads` is on.
3. **Reading pane layout** setting: right (default) / bottom / hidden (OWA “Reading pane”).
4. **Favorites** above folder tree (pinned folders, localStorage).

### P1 — Search & triage

5. **Natural-language search** (only when AI + user provider configured); fallback keeps tag syntax.
6. **Quick filter bar** parity (Has files, Mentions me, etc.) where IMAP/search supports it.
7. **Categories / flags** (user-assigned colours) synced via IMAP keywords or local overlay.

### P2 — Compose & handling

8. Scheduled send, undo send window, explicit Save draft UX.
9. **Sweep** one-click on message row (align with Settings → Sweep).
10. Quick Steps (templated multi-action).

### P3 — AI (opt-in only)

11. Default **`aiFeatures: false`** for new profiles; master switch hides every AI entry point.
12. User-named LLM provider in settings only (no server-side default key in UI copy).
13. Thread summarise, draft/rewrite, smart triage, NL search — each gated on AI + provider.

### P4 — Polish & mobile

14. Mobile: Focused/Other + conversation reader parity.
15. Deep links and shareable message URLs.
16. Accessibility pass (pane landmarks, tab order vs OWA).

---

## Slice 1 (implemented in this PR)

- **`webmail/src/lib/focused-inbox.ts`**: classify messages into Focused vs Other without AI.
- **`MessageList.svelte`**: Outlook-style **Focused | Other** tabs when viewing INBOX (hidden during search or other folders).
- **`settings.inboxTab`**: persisted preference (`focused` | `other`).
- Tests: unit (`focused-inbox.test.mjs`) + Playwright (`outlook-focused-inbox.spec.ts`) against API mocks.
- Screenshots: `webmail/docs/assets/outlook-slice1/26-inbox-focused-tab.png`, `27-inbox-other-tab.png`.

---

## Next planned slice

**Reading-pane conversation view**: when conversation grouping is enabled, show the full thread in the reading pane (newest expanded, older collapsed), matching Outlook’s conversation reading experience—not only a single selected message.

---

## References

- Desktop layout: `webmail/src/components/Layout.svelte`
- List / filters: `webmail/src/components/MessageList.svelte`
- Reading: `webmail/src/components/MessageDetail.svelte`
- Settings: `webmail/src/components/Settings.svelte`
- E2E mocks: `webmail/test/e2e/fixtures.ts`
