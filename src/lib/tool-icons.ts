// Friendly emoji + verb for the AI tool calls we surface in the chat
// stream. Users see the label as "✨ {label}…", so it must read like
// plain English. Never expose raw tool names — unknown tools fall back
// to a generic "Working on it…" rather than leaking snake_case symbols.

export interface ToolDisplay {
    emoji: string;
    /** Present-tense verb shown while the call is running. */
    label: string;
    /** When true, suppress the chip entirely (internal/no-op tools). */
    hidden?: boolean;
}

const TABLE: Record<string, ToolDisplay> = {
    // Mail
    list_mailboxes:           { emoji: '📂', label: 'Browsing folders' },
    list_messages:            { emoji: '📬', label: 'Reading inbox' },
    get_message:              { emoji: '✉️', label: 'Opening email' },
    search_messages:          { emoji: '🔎', label: 'Searching mail' },
    move_message:             { emoji: '➡️', label: 'Moving message' },
    delete_message:           { emoji: '🗑️', label: 'Deleting message' },
    flag_message:             { emoji: '⭐', label: 'Flagging message' },
    mark_read:                { emoji: '👁️', label: 'Marking read' },
    summarize:                { emoji: '📝', label: 'Summarising' },
    summarise_email:          { emoji: '📝', label: 'Summarising email' },
    send_message:             { emoji: '📤', label: 'Sending email' },
    // Calendar
    list_calendars:           { emoji: '📅', label: 'Listing calendars' },
    list_events:              { emoji: '📅', label: 'Reading events' },
    get_event:                { emoji: '📅', label: 'Opening event' },
    create_event:             { emoji: '➕', label: 'Creating event' },
    delete_event:             { emoji: '🗑️', label: 'Deleting event' },
    list_calendar_subscriptions: { emoji: '🔔', label: 'Listing subscriptions' },
    // Rules / blocks
    list_mail_rules:          { emoji: '🧰', label: 'Reading rules' },
    add_mail_rule:            { emoji: '➕', label: 'Adding rule' },
    remove_mail_rule:         { emoji: '🗑️', label: 'Removing rule' },
    block_sender:             { emoji: '🚫', label: 'Blocking sender' },
    list_blocked_senders:     { emoji: '🚫', label: 'Listing blocks' },
    // Settings / look
    get_settings:             { emoji: '⚙️', label: 'Reading settings' },
    set_setting:              { emoji: '⚙️', label: 'Updating settings' },
    set_skin:                 { emoji: '🎨', label: 'Changing theme' },
    set_folder_icon:          { emoji: '🎨', label: 'Updating folder icon' },
    list_folder_icons:        { emoji: '🎨', label: 'Reading folder icons' },
    // Navigation
    set_app_surface:          { emoji: '🧭', label: 'Switching app' },
    // Web
    web_search:               { emoji: '🦁', label: 'Searching with Brave' },
    start_background_task:    { emoji: '🛎️', label: 'Starting background task' },
    // Internal — never show in the stream. They are no-ops the model
    // sometimes calls (legacy capability gate, etc.) and surfacing them
    // confuses non-technical users.
    request_permission:       { emoji: '✨', label: 'Working on it', hidden: true }
};

export function toolDisplay(name: string): ToolDisplay {
    return TABLE[name] || { emoji: '✨', label: 'Working on it' };
}
