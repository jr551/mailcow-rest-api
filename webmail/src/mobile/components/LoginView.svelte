<script lang="ts">
    import { authState, upsertSession, setError, setPending, login as loginCall } from '../../lib/auth.svelte';
    import Icon from '../../components/Icon.svelte';

    let user = $state('');
    let pass = $state('');
    let showPass = $state(false);
    // Mobile always stays signed in — session is persisted to localStorage + cookie.
    let shake = $state(0);

    async function attemptLogin(email: string, password: string) {
        setPending(true);
        setError(null);
        try {
            const session = await loginCall(email, password, { remember: true });
            upsertSession(session);
        } catch (err) {
            const status = (err as { status?: number }).status;
            const msg = status === 401
                ? 'Wrong username or password.'
                : err instanceof Error ? err.message : 'Login failed';
            setError(msg);
            shake++;
        } finally {
            setPending(false);
        }
    }

    async function handleSubmit(e: SubmitEvent) {
        e.preventDefault();
        if (!user.trim() || !pass) return;
        await attemptLogin(user.trim(), pass);
    }

    // The Tauri Android shell injects window.__IMAP_REST_BOOTSTRAP__ before
    // page scripts run when the user has previously logged in. Pre-fill +
    // auto-submit so they only ever see a login screen on first launch.
    $effect(() => {
        const w = window as unknown as { __IMAP_REST_BOOTSTRAP__?: { email?: string; password?: string } };
        const boot = w.__IMAP_REST_BOOTSTRAP__;
        if (!boot?.email || !boot?.password) return;
        // Clear so a manual log-out doesn't loop us back in.
        delete w.__IMAP_REST_BOOTSTRAP__;
        user = boot.email;
        pass = boot.password;
        attemptLogin(boot.email, boot.password);
    });
</script>

<div class="login-page">
    <div class="login-card">
        <div class="login-logo">
            <Icon name="mail" size={32} />
        </div>
        <h1>Webmail</h1>
        <p class="subtitle">Sign in to your account</p>

        <form onsubmit={handleSubmit} class={authState.error ? 'shake' : ''}>
            <div class="field-group">
                <label class="field">
                    <span class="field-label">Email</span>
                    <input
                        type="email"
                        autocomplete="username"
                        placeholder="you@domain.tld"
                        bind:value={user}
                        class:error-field={!!authState.error}
                        required
                    />
                </label>
                <label class="field">
                    <span class="field-label">Password</span>
                    <div class="pass-wrap">
                        <input
                            type={showPass ? 'text' : 'password'}
                            autocomplete="current-password"
                            placeholder="••••••••"
                            bind:value={pass}
                            class:error-field={!!authState.error}
                            required
                        />
                        <button
                            type="button"
                            class="show-pass"
                            onclick={() => showPass = !showPass}
                            aria-label={showPass ? 'Hide password' : 'Show password'}
                        >
                            <Icon name={showPass ? 'eyeOff' : 'eye'} size={18} />
                        </button>
                    </div>
                </label>
            </div>

            {#if authState.error}
                <p class="error-text" role="alert">{authState.error}</p>
            {/if}

            <button
                type="submit"
                class="submit-btn"
                disabled={authState.pending || !user || !pass}
            >
                {#if authState.pending}<span class="spinner" style="width:16px;height:16px"></span>{/if}
                {authState.pending ? 'Signing in…' : 'Sign In'}
            </button>

            <p class="perma-note">You'll stay signed in on this device.</p>
        </form>
    </div>
</div>

<style>
    .login-page {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background: var(--bg-base);
    }
    .login-card {
        width: 100%;
        max-width: 340px;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
    }
    .login-logo {
        width: 72px;
        height: 72px;
        border-radius: 18px;
        background: var(--accent);
        color: var(--text-on-accent);
        display: flex;
        align-items: center;
        justify-content: center;
        margin-bottom: 8px;
        box-shadow: 0 4px 16px color-mix(in srgb, var(--accent) 35%, transparent);
    }
    h1 {
        margin: 0;
        font-size: 28px;
        font-weight: 700;
        letter-spacing: -0.02em;
        color: var(--text-primary);
    }
    .subtitle {
        margin: 0 0 16px;
        color: var(--text-tertiary);
        font-size: 15px;
        font-weight: 400;
    }
    form {
        width: 100%;
        display: flex;
        flex-direction: column;
        gap: 14px;
    }
    .field-group {
        display: flex;
        flex-direction: column;
        background: var(--bg-surface);
        border-radius: 12px;
        overflow: hidden;
        border: 0.5px solid var(--border-soft);
    }
    .field {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: 10px 14px;
    }
    .field:not(:last-child) {
        border-bottom: 0.5px solid var(--border-subtle);
    }
    .field-label {
        font-size: 12px;
        font-weight: 600;
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.03em;
    }
    input {
        width: 100%;
        padding: 4px 0;
        border: none;
        background: transparent;
        font-size: 17px;
        line-height: 1.3;
        color: var(--text-primary);
        outline: none;
        -webkit-appearance: none;
        appearance: none;
    }
    input::placeholder { color: var(--text-tertiary); opacity: 0.6; }
    .pass-wrap {
        display: flex;
        align-items: center;
        gap: 8px;
    }
    .pass-wrap input { flex: 1; }
    .show-pass {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: transparent;
        border: none;
        padding: 4px;
        color: var(--accent-text);
        cursor: pointer;
        flex-shrink: 0;
    }
    .error-field {
        color: var(--danger) !important;
    }
    .error-text {
        margin: -4px 0 0;
        color: var(--danger);
        font-size: 13px;
        font-weight: 500;
        text-align: center;
    }
    .perma-note {
        margin: 0;
        font-size: 13px;
        color: var(--text-tertiary);
        text-align: center;
    }
    .submit-btn {
        width: 100%;
        padding: 14px;
        font-size: 17px;
        font-weight: 600;
        border-radius: 12px;
        border: none;
        background: var(--accent);
        color: var(--text-on-accent);
        cursor: pointer;
        transition: transform 80ms, opacity 120ms;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
    }
    .submit-btn:active:not(:disabled) { transform: scale(0.98); opacity: 0.9; }
    .submit-btn:disabled {
        opacity: 0.45;
        cursor: not-allowed;
    }
    .shake { animation: shake 380ms cubic-bezier(0.36, 0.07, 0.19, 0.97); }
    @keyframes shake {
        10%, 90% { transform: translateX(-1px); }
        20%, 80% { transform: translateX(2px); }
        30%, 50%, 70% { transform: translateX(-4px); }
        40%, 60% { transform: translateX(4px); }
    }
</style>
