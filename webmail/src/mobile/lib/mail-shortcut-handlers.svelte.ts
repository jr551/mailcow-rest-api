import type { MailShortcutAction } from '../../lib/mail-keyboard-shortcuts';

export type MobileMailShortcutExtra = 'open-message';

type Handler = () => void | Promise<void>;

const handlers: Partial<Record<MailShortcutAction | MobileMailShortcutExtra, Handler>> = {};

export function setMobileMailShortcutHandler(
    action: MailShortcutAction | MobileMailShortcutExtra,
    fn: Handler | null,
) {
    if (fn) handlers[action] = fn;
    else delete handlers[action];
}

export async function dispatchMobileMailShortcut(
    action: MailShortcutAction | MobileMailShortcutExtra,
): Promise<boolean> {
    const h = handlers[action];
    if (!h) return false;
    await h();
    return true;
}
