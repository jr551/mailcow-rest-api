export type SetupCheckStatus = 'pending' | 'ok' | 'warn' | 'fail';

export interface SetupCheck {
    id: string;
    label: string;
    path: string;
    status: SetupCheckStatus;
    detail: string;
    fix: string;
    statusCode?: number;
}

const DEFAULT_CHECKS: SetupCheck[] = [
    {
        id: 'health',
        label: 'API health',
        path: '/health',
        status: 'pending',
        detail: 'Not checked yet.',
        fix: 'Proxy /health to the mailcow-rest-api container or API deployment.'
    },
    {
        id: 'openapi',
        label: 'OpenAPI document',
        path: '/openapi.json',
        status: 'pending',
        detail: 'Not checked yet.',
        fix: 'Proxy /openapi.json to the API so Swagger/debugging stays available.'
    },
    {
        id: 'push',
        label: 'Public API route',
        path: '/v1/push/config',
        status: 'pending',
        detail: 'Not checked yet.',
        fix: 'Proxy /v1/* to the API. Login and mailbox calls use the same route family.'
    }
];

const state = $state<{
    checked: boolean;
    running: boolean;
    lastRunAt: number;
    origin: string;
    checks: SetupCheck[];
}>({
    checked: false,
    running: false,
    lastRunAt: 0,
    origin: typeof window === 'undefined' ? '' : window.location.origin,
    checks: DEFAULT_CHECKS.map((c) => ({ ...c }))
});

export const setupDiagnostics = state;

function isBlocking() {
    if (!state.checked || state.running) return false;
    return state.checks.some((c) => c.id !== 'push' && c.status === 'fail')
        || state.checks.every((c) => c.status === 'fail');
}

export function setupIsBlocking() {
    return isBlocking();
}

function resetChecks() {
    state.checks = DEFAULT_CHECKS.map((c) => ({ ...c }));
}

async function checkEndpoint(check: SetupCheck): Promise<SetupCheck> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5000);
    try {
        const res = await fetch(check.path, {
            cache: 'no-store',
            credentials: 'omit',
            signal: ctl.signal
        });
        const contentType = res.headers.get('content-type') || '';
        if (!res.ok) {
            return {
                ...check,
                status: 'fail',
                statusCode: res.status,
                detail: `${check.path} returned HTTP ${res.status}.`
            };
        }
        if (check.id === 'openapi') {
            try {
                const json = await res.clone().json();
                if (!json.openapi && !json.swagger) {
                    return {
                        ...check,
                        status: 'fail',
                        statusCode: res.status,
                        detail: '/openapi.json answered, but it does not look like an OpenAPI document.'
                    };
                }
            } catch {
                return {
                    ...check,
                    status: 'fail',
                    statusCode: res.status,
                    detail: '/openapi.json answered, but it was not valid JSON.'
                };
            }
        } else if (check.id === 'push' && !contentType.includes('application/json')) {
            return {
                ...check,
                status: 'warn',
                statusCode: res.status,
                detail: '/v1/push/config answered, but the response was not JSON.'
            };
        }
        return {
            ...check,
            status: 'ok',
            statusCode: res.status,
            detail: `${check.path} is reachable.`
        };
    } catch (err) {
        const message = err instanceof DOMException && err.name === 'AbortError'
            ? 'timed out after 5 seconds'
            : err instanceof Error ? err.message : 'request failed';
        return {
            ...check,
            status: 'fail',
            detail: `${check.path} ${message}.`
        };
    } finally {
        clearTimeout(timer);
    }
}

export async function runSetupDiagnostics() {
    if (state.running) return;
    state.running = true;
    state.checked = false;
    state.origin = typeof window === 'undefined' ? '' : window.location.origin;
    resetChecks();
    const results = await Promise.all(state.checks.map(checkEndpoint));
    state.checks = results;
    state.checked = true;
    state.running = false;
    state.lastRunAt = Date.now();
}

let started = false;
export function startSetupDiagnostics() {
    if (started || typeof window === 'undefined') return;
    started = true;
    void runSetupDiagnostics();
}
