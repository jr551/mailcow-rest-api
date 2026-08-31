<script lang="ts">
    import { authState, upsertSession, setError, setPending, setAddingAccount, login as loginCall } from '../lib/auth.svelte';
    import { rememberedUsers, recallCreds } from '../lib/keychain';
    import Icon from './Icon.svelte';
    import ThemeToggle from './ThemeToggle.svelte';

    let user = $state('');
    let pass = $state('');
    let showPass = $state(false);
    let remember = $state(true); // default ON — most users expect persistence
    let userInput: HTMLInputElement | undefined = $state();
    let cardEl: HTMLElement | undefined = $state();
    let shake = $state(0); // bumped on each error so the keyed div re-mounts
    // Pre-flag autoLoggingIn before the first paint when we have any
    // remembered credential AND we weren't just signed out — that way
    // the form never even flashes for return visitors. The actual
    // login attempt still runs in the $effect below; this just hides
    // the form proactively.
    function hasRememberedReturnUser(): boolean {
        try {
            // Same gate wasRecentlyLoggedOut() uses below — if the user
            // explicitly signed out within the last 5s, don't auto-flip.
            const raw = sessionStorage.getItem('webmail.logout.recent');
            if (raw) {
                const ts = Number(raw);
                if (Number.isFinite(ts) && Date.now() - ts < 5000) return false;
            }
            const users = rememberedUsers();
            return users.length > 0;
        } catch { return false; }
    }
    let autoLoggingIn = $state(hasRememberedReturnUser());
    let autoTried = false; // gate so we only attempt once per mount

    // Lightweight bot deterrent. After 2 failed attempts (or page-load
    // detection of suspicious automation) we surface a 5-second-old math
    // problem the user must answer before another submit will fire. The
    // count + answer live in sessionStorage so a refresh doesn't reset it.
    const FAILS_KEY = 'webmail.login.fails';
    function readFails(): number {
        try { return parseInt(sessionStorage.getItem(FAILS_KEY) || '0', 10) || 0; } catch { return 0; }
    }
    function writeFails(n: number) {
        try { sessionStorage.setItem(FAILS_KEY, String(n)); } catch { /* noop */ }
    }
    let failCount = $state(readFails());
    function newCaptcha(): { a: number; b: number; op: '+' | '−'; answer: number } {
        const a = Math.floor(Math.random() * 9) + 2;
        const b = Math.floor(Math.random() * 9) + 1;
        // Always positive results — keeps the prompt readable.
        const op: '+' | '−' = Math.random() < 0.5 ? '+' : '−';
        const lo = Math.min(a, b), hi = Math.max(a, b);
        const x = op === '+' ? a : hi;
        const y = op === '+' ? b : lo;
        return { a: x, b: y, op, answer: op === '+' ? x + y : x - y };
    }
    let captcha = $state(newCaptcha());
    let captchaInput = $state('');
    // The simplest form of "bot detected": browsers without an interactive
    // pointer event by the time the form mounts are likely automated.
    let interacted = $state(false);
    function markInteracted() { interacted = true; }
    let captchaRequired = $derived(failCount >= 2 || (!interacted && failCount >= 1));

    // True when this Login is shown over an existing inbox to add a second account.
    const isAddAccountMode = $derived(authState.addingAccount && authState.sessions.length > 0);

    function wasRecentlyLoggedOut(): boolean {
        try {
            const raw = sessionStorage.getItem('webmail.logout.recent');
            if (!raw) return false;
            const ts = parseInt(raw, 10);
            return Date.now() - ts < 5000; // 5-second grace period
        } catch { return false; }
    }

    async function tryAutoLogin() {
        if (autoTried || authState.activeUser || authState.addingAccount || authState.pending) return;
        if (wasRecentlyLoggedOut()) return;
        const users = rememberedUsers();
        if (!users.length) return;
        autoTried = true;
        autoLoggingIn = true;
        setPending(true);
        setError(null);
        const targetUser = users[0];
        const creds = recallCreds(targetUser);
        if (!creds) {
            autoLoggingIn = false;
            setPending(false);
            return;
        }
        try {
            const session = await loginCall(creds.user, creds.pass, { remember: true });
            upsertSession(session);
        } catch (err) {
            const status = (err as { status?: number }).status;
            const msg = status === 401
                ? 'Saved credentials are no longer valid. Please sign in again.'
                : err instanceof Error ? err.message : 'Auto-login failed';
            setError(msg);
            shake++;
            // Only wipe the keychain when the server *definitively* rejected
            // the password (401). Network errors, captive-portal 502s, or a
            // briefly-flaky IMAP backend would otherwise erase the user's
            // stored creds on the very next cold start — which is exactly
            // what was kicking PWA users to manual sign-in repeatedly.
            if (status === 401) {
                import('../lib/keychain').then((k) => k.forgetCreds(targetUser));
            }
        } finally {
            autoLoggingIn = false;
            setPending(false);
        }
    }

    async function handleSubmit(e: SubmitEvent) {
        e.preventDefault();
        if (!user.trim() || !pass) return;
        if (captchaRequired) {
            const expected = captcha.answer;
            // <input type="number"> binds as a number in Svelte 5 — coerce
            // through String() so .trim() works whether bind returns
            // string or number.
            const got = parseInt(String(captchaInput).trim(), 10);
            if (Number.isNaN(got) || got !== expected) {
                setError('Captcha answer is wrong — try again.');
                captcha = newCaptcha();
                captchaInput = '';
                shake++;
                return;
            }
        }
        setPending(true);
        setError(null);
        try {
            const session = await loginCall(user.trim(), pass, { remember });
            upsertSession(session);
            // Reset bot-deterrent state on success.
            writeFails(0);
            failCount = 0;
            captchaInput = '';
        } catch (err) {
            const status = (err as { status?: number }).status;
            const msg = status === 401
                ? 'Wrong username or password.'
                : err instanceof Error ? err.message : 'Login failed';
            setError(msg);
            shake++;
            failCount = failCount + 1;
            writeFails(failCount);
            captcha = newCaptcha();
            captchaInput = '';
            // Focus the email field so the user can retype.
            queueMicrotask(() => userInput?.focus());
        } finally {
            setPending(false);
        }
    }

    function cancelAdd() {
        setAddingAccount(false);
    }

    // Auto-login when remembered credentials exist and no session is active.
    $effect(() => {
        if (!autoTried && !authState.activeUser && !authState.addingAccount) {
            tryAutoLogin();
        }
    });
</script>

<div class="page" class:add-mode={isAddAccountMode} data-testid="login-page">
    <div class="topbar">
        <ThemeToggle />
    </div>

    <main class="card-wrap" aria-labelledby="login-title">
        <aside class="brand-panel" aria-hidden="true">
            <div class="brand-mark">
                <Icon name="mail" size={32} />
            </div>
            <h2 class="brand-title">Your inbox, reimagined.</h2>
            <p class="brand-tagline">A fast, private webmail for mailcow with AI summaries and draft replies built in.</p>
            <ul class="brand-bullets">
                <li><span class="dot"></span> End-to-end Basic / Bearer auth — no third-party identity</li>
                <li><span class="dot"></span> Pluggable AI: Mistral, OpenAI, Anthropic, Ollama, your own</li>
                <li><span class="dot"></span> Polished dark mode that actually has contrast</li>
            </ul>
        </aside>

        <section bind:this={cardEl} class="card fade-in" data-shake-key={shake}>
            <header class="card-head">
                <div class="logo" aria-hidden="true">
                    <Icon name="mail" size={22} />
                </div>
                <h1 id="login-title">{isAddAccountMode ? 'Add another account' : 'Sign in to webmail'}</h1>
                <p class="muted">
                    {#if isAddAccountMode}
                        Sign in with a second mailcow account — switch between them from the account dropdown.
                    {:else}
                        Use your mailcow account or an app password.
                    {/if}
                </p>
            </header>

            {#if autoLoggingIn}
                <div class="auto-login" data-testid="login-auto">
                    <span class="spinner"></span>
                    <p class="muted">Welcome back — signing you in…</p>
                </div>
            {:else}
            <form
                onsubmit={handleSubmit}
                onpointerdown={markInteracted}
                onkeydown={markInteracted}
                novalidate
                class={authState.error ? 'shake' : ''}
            >
                <label class="field">
                    <span class="lbl">Email</span>
                    <input
                        bind:this={userInput}
                        type="email"
                        autocomplete="username"
                        spellcheck="false"
                        autocapitalize="off"
                        placeholder="you@your-domain.tld"
                        bind:value={user}
                        class:error-field={!!authState.error}
                        required
                        data-testid="login-user"
                    />
                </label>

                <label class="field">
                    <span class="lbl">
                        Password
                        <button
                            type="button"
                            class="toggle-pass"
                            aria-label={showPass ? 'Hide password' : 'Show password'}
                            onclick={() => (showPass = !showPass)}
                        >
                            <Icon name="eye" size={14} />
                            <span>{showPass ? 'Hide' : 'Show'}</span>
                        </button>
                    </span>
                    <input
                        type={showPass ? 'text' : 'password'}
                        autocomplete="current-password"
                        placeholder="••••••••"
                        bind:value={pass}
                        class:error-field={!!authState.error}
                        required
                        data-testid="login-pass"
                    />
                </label>

                {#if authState.error}
                    <div class="error" role="alert" data-testid="login-error">
                        <span class="error-icon" aria-hidden="true">
                            <Icon name="info" size={14} />
                        </span>
                        <span>{authState.error}</span>
                    </div>
                {/if}

                {#if captchaRequired}
                    <label class="field captcha-field" data-testid="login-captcha">
                        <span class="lbl">
                            <Icon name="shield" size={12} /> Quick check
                        </span>
                        <div class="captcha-row">
                            <span class="captcha-q">
                                What is <strong>{captcha.a}</strong> {captcha.op} <strong>{captcha.b}</strong> ?
                            </span>
                            <input
                                type="number"
                                inputmode="numeric"
                                placeholder="?"
                                bind:value={captchaInput}
                                class="captcha-input"
                                data-testid="login-captcha-input"
                            />
                        </div>
                        <span class="muted small">
                            We're seeing repeat sign-in failures from this browser. Solve to continue.
                        </span>
                    </label>
                {/if}

                <label class="remember">
                    <input
                        type="checkbox"
                        bind:checked={remember}
                        data-testid="login-remember"
                    />
                    <span>
                        <strong>Stay signed in</strong>
                        <span class="muted">
                            — keeps your session alive past 1 hour. Stores credentials in
                            this browser only; turn off on shared devices.
                        </span>
                    </span>
                </label>

                <button
                    type="submit"
                    class="btn btn-primary submit"
                    disabled={authState.pending || !user || !pass}
                    data-testid="login-submit"
                >
                    {#if authState.pending}<span class="spinner"></span>{/if}
                    {authState.pending ? 'Signing in…' : isAddAccountMode ? 'Add account' : 'Sign in'}
                </button>

                {#if isAddAccountMode}
                    <button
                        type="button"
                        class="btn btn-ghost cancel-add"
                        onclick={cancelAdd}
                        data-testid="login-cancel-add"
                    >Cancel</button>
                {/if}

                <p class="hint muted">
                    Two-factor accounts: use an
                    <a href="https://docs.mailcow.email/manual-guides/SOGo/u_e-sogo-app_password/" target="_blank" rel="noopener">
                        app password
                    </a>.
                </p>
            </form>
            {/if}
        </section>
    </main>
</div>

<style>
    .page {
        min-height: 100vh;
        display: flex;
        flex-direction: column;
        background:
            linear-gradient(135deg,
                color-mix(in srgb, var(--accent) 8%, var(--bg-base)),
                var(--bg-base) 70%);
    }
    /* When adding an account on top of an existing inbox, overlay only — no
     * full-bleed background. The card stays centered. */
    .page.add-mode {
        position: fixed;
        inset: 0;
        background: var(--bg-overlay);
        backdrop-filter: blur(3px);
        z-index: 80;
    }
    .page.add-mode .topbar { display: none; }
    .page.add-mode .brand-panel { display: none; }
    .page.add-mode :global(.card-wrap) { grid-template-columns: 1fr; }
    .topbar {
        display: flex;
        justify-content: flex-end;
        padding: 16px 20px;
    }
    .card-wrap {
        flex: 1;
        display: grid;
        grid-template-columns: 1fr 1fr;
        max-width: 1080px;
        width: calc(100% - 40px);
        margin: auto;
        padding: 0 20px 40px;
        gap: 56px;
        align-items: center;
    }
    @media (max-width: 860px) {
        .card-wrap { grid-template-columns: 1fr; gap: 24px; }
        .brand-panel { display: none; }
    }
    .brand-panel {
        display: flex;
        flex-direction: column;
        gap: 14px;
        padding: 20px 24px 20px 0;
    }
    .brand-mark {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 52px;
        height: 52px;
        border-radius: var(--radius-lg);
        background: linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 55%, #c47bff));
        color: var(--text-on-accent);
        box-shadow: 0 8px 22px color-mix(in srgb, var(--accent) 28%, transparent);
        margin-bottom: 4px;
    }
    .brand-title {
        margin: 4px 0 0;
        font-size: 26px;
        line-height: 1.18;
        letter-spacing: -0.02em;
        font-weight: 700;
        color: var(--text-primary);
    }
    .brand-tagline {
        margin: 0;
        font-size: 14.5px;
        line-height: 1.55;
        color: var(--text-secondary);
        max-width: 36ch;
    }
    .brand-bullets {
        list-style: none;
        margin: 8px 0 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 10px;
    }
    .brand-bullets li {
        display: flex;
        align-items: center;
        gap: 10px;
        font-size: 13px;
        color: var(--text-secondary);
    }
    .brand-bullets .dot {
        width: 6px; height: 6px;
        border-radius: 50%;
        background: var(--accent);
        flex: 0 0 auto;
    }
    .card {
        width: min(420px, 100%);
        margin-left: auto;
        background: var(--bg-surface);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-xl);
        padding: 32px 32px 28px;
        box-shadow: var(--shadow-lg);
    }
    .card-head {
        text-align: left;
        margin-bottom: 22px;
    }
    .logo {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 40px;
        height: 40px;
        border-radius: var(--radius-md);
        background: var(--accent-soft);
        color: var(--accent-text);
        margin-bottom: 12px;
    }
    h1 {
        margin: 0 0 4px;
        font-size: 20px;
        letter-spacing: -0.015em;
        font-weight: 700;
    }
    .field { display: block; margin-bottom: 14px; }
    .captcha-field .captcha-row {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 12px;
        background: color-mix(in srgb, var(--warning, #d18c1d) 10%, var(--bg-base));
        border: 1px solid color-mix(in srgb, var(--warning, #d18c1d) 35%, var(--border-subtle));
        border-radius: var(--radius-sm);
    }
    .captcha-q {
        flex: 1;
        font-size: 14px;
        color: var(--text-primary);
        user-select: none;
    }
    .captcha-q strong { font-weight: 700; font-size: 16px; }
    .captcha-input {
        width: 70px;
        padding: 6px 8px;
        text-align: center;
        font-size: 14px;
        font-weight: 600;
    }
    .captcha-field .muted { display: block; margin-top: 4px; }
    .lbl {
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: 12px;
        font-weight: 600;
        color: var(--text-secondary);
        margin-bottom: 6px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
    }
    .toggle-pass {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-size: 11px;
        color: var(--text-tertiary);
        text-transform: none;
        letter-spacing: normal;
        padding: 2px 6px;
        border-radius: var(--radius-xs);
        font-weight: 500;
    }
    .toggle-pass:hover { background: var(--bg-hover); color: var(--text-primary); }
    input { width: 100%; padding: 11px 12px; }
    .error {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        background: var(--danger-soft);
        color: var(--danger-strong, var(--danger));
        border: 1px solid color-mix(in srgb, var(--danger) 35%, var(--border-subtle));
        border-radius: var(--radius-sm);
        padding: 10px 12px;
        font-size: 13px;
        margin-bottom: 14px;
        font-weight: 500;
    }
    .error-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 18px;
        height: 18px;
        border-radius: 50%;
        background: var(--danger);
        color: #ffffff;
        flex: 0 0 auto;
        margin-top: 1px;
    }
    .submit {
        width: 100%;
        padding: 13px;
        margin-top: 6px;
        font-size: 14px;
        font-weight: 600;
        box-shadow: 0 6px 18px color-mix(in srgb, var(--accent) 38%, transparent);
    }
    .submit:disabled { box-shadow: none; }
    .cancel-add { width: 100%; margin-top: 8px; }
    .remember {
        display: grid;
        grid-template-columns: 18px 1fr;
        gap: 10px;
        align-items: flex-start;
        padding: 8px 0 12px;
        font-size: 12.5px;
        color: var(--text-secondary);
        line-height: 1.45;
        cursor: pointer;
    }
    .remember input { margin-top: 2px; accent-color: var(--accent); }
    .remember strong { color: var(--text-primary); font-weight: 600; }
    .hint {
        margin-top: 18px;
        font-size: 12px;
        text-align: center;
    }
    .auto-login {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 14px;
        padding: 40px 0;
        text-align: center;
    }
    .auto-login .spinner {
        width: 28px; height: 28px;
        border: 3px solid var(--border-subtle);
        border-top-color: var(--accent);
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
</style>
