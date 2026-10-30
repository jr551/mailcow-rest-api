import {
    DEFAULT_QUICK_STEPS,
    orderedQuickSteps,
    sanitizeEnabledQuickStepIds,
    type QuickStepDefinition
} from './message-quick-steps';

const STORAGE_KEY = 'webmail.message-quick-steps.v1';

let enabledIds = $state<string[]>(DEFAULT_QUICK_STEPS.map((s) => s.id));

function persist() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ enabled: enabledIds }));
    } catch {
        /* quota / private mode */
    }
}

export function hydrateQuickStepsFromStorage() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw) as { enabled?: unknown };
        enabledIds = sanitizeEnabledQuickStepIds(parsed?.enabled);
    } catch {
        enabledIds = DEFAULT_QUICK_STEPS.map((s) => s.id);
    }
}

export function quickStepsCatalog(): QuickStepDefinition[] {
    return orderedQuickSteps(enabledIds);
}

export function resetQuickStepsToDefault() {
    enabledIds = DEFAULT_QUICK_STEPS.map((s) => s.id);
    persist();
}
