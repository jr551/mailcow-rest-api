(function () {
    'use strict';
    // Adds a "New webmail" button to the mailcow sign-in page. It exchanges the
    // credentials already typed into mailcow's own form for a session token on
    // the API, then hands that token to the SPA in the URL fragment.
    //
    // Injected by the host nginx (sub_filter) rather than added to mailcow's
    // tree, because mailcow's update.sh resets its own working copy.
    var API = 'https://userapi.delivering.email';
    var APP = API + '/webmail/';

    function ready(fn) {
        if (document.readyState !== 'loading') fn();
        else document.addEventListener('DOMContentLoaded', fn);
    }

    ready(function () {
        var user = document.getElementById('login_user');
        var pass = document.getElementById('pass_user');
        if (!user || !pass) return;               // not the login page
        if (document.getElementById('wm-handoff')) return;

        var form = user.form || document.querySelector('form[method="post"]');
        if (!form) return;

        var btn = document.createElement('button');
        btn.id = 'wm-handoff';
        btn.type = 'button';
        // Match the FIDO2 button that already sits under "or login with".
        btn.className = 'btn btn-xs-lg btn-secondary w-100 mt-2';
        btn.style.maxWidth = '400px';
        btn.innerHTML = '<i class="bi bi-envelope-fill"></i> New webmail';

        var note = document.createElement('div');
        note.className = 'text-muted mt-1';
        note.style.cssText = 'font-size:.8rem;max-width:400px;text-align:center;display:none';

        function fail(msg) {
            note.textContent = msg;
            note.style.display = '';
            btn.disabled = false;
            btn.innerHTML = '<i class="bi bi-envelope-fill"></i> New webmail';
        }

        btn.addEventListener('click', function () {
            var u = (user.value || '').trim();
            var p = pass.value || '';
            if (!u || !p) {
                fail('Enter your email address and password first.');
                (u ? pass : user).focus();
                return;
            }
            note.style.display = 'none';
            btn.disabled = true;
            btn.textContent = 'Signing in…';

            // btoa() is Latin1-only, so encode as UTF-8 bytes first — otherwise
            // a non-ASCII password throws instead of signing in.
            var bytes = new TextEncoder().encode(u + ':' + p);
            var bin = '';
            for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);

            fetch(API + '/v1/auth/session', {
                method: 'POST',
                headers: { authorization: 'Basic ' + btoa(bin) }
            }).then(function (res) {
                if (res.status === 401) { fail('That email address or password was not accepted.'); return null; }
                if (!res.ok) { fail('The webmail service is not reachable right now.'); return null; }
                return res.json();
            }).then(function (data) {
                if (!data || !data.token) return;
                // The fragment is never sent to a server and the app clears it
                // from the address bar as soon as it has read it.
                location.href = APP + '#wm_token=' + encodeURIComponent(data.token) +
                    '&wm_user=' + encodeURIComponent(u);
            }).catch(function () {
                fail('Could not reach the webmail service.');
            });
        });

        var fido = document.getElementById('fido2-login');
        var host = fido && fido.parentNode ? fido.parentNode : null;
        if (host) {
            host.appendChild(btn);
            host.appendChild(note);
        } else {
            var wrap = document.createElement('div');
            wrap.className = 'd-flex flex-column align-items-center';
            wrap.appendChild(btn);
            wrap.appendChild(note);
            form.parentNode.insertBefore(wrap, form.nextSibling);
        }
    });
})();
