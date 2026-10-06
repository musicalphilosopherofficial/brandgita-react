    (function () {
      var p     = new URLSearchParams(window.location.search);
      var code  = p.get('code');
      var error = p.get('error');
      var state = {};
      try { state = JSON.parse(p.get('state') || '{}'); } catch (_) {}
      var port  = state.port || 9878;

      // Web connection: the state was minted by /api/tiktok/auth-url ("w1." prefix). Finish the
      // exchange server-side with the licence saved in this browser, then go back to the app.
      var rawState = p.get('state') || '';
      if (rawState.indexOf('w1.') === 0) {
        var t = document.getElementById('title'), st = document.getElementById('subtitle'), bt = document.getElementById('open-btn');
        bt.style.display = 'none';
        t.textContent = 'Finishing up…'; st.textContent = '';
        var lic = ''; try { lic = localStorage.getItem('bg_licence') || ''; } catch (_) {}
        if (!code || !lic) {
          t.textContent = 'Not connected.';
          st.innerHTML = 'Open <a href="/app/tiktok/">Publish to TikTok</a> and try again.';
          return;
        }
        fetch('/api/tiktok/exchange', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + lic }, body: JSON.stringify({ code: code, state: rawState }) })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (!d.ok) throw new Error(d.error || 'failed');
            t.textContent = 'TikTok connected.'; st.textContent = 'Taking you back…';
            setTimeout(function () { location.replace('/app/tiktok/'); }, 800);
          })
          .catch(function (e) { t.textContent = 'Could not connect.'; st.innerHTML = (e.message || 'Try again') + ' — <a href="/app/tiktok/">go back</a>.'; });
        return;
      }

      if (!code && !error) return;

      var btn      = document.getElementById('open-btn');
      var title    = document.getElementById('title');
      var subtitle = document.getElementById('subtitle');

      btn.addEventListener('mousedown', function (e) {
        var r = document.createElement('span');
        r.className = 'ripple';
        var rect = btn.getBoundingClientRect();
        r.style.left = (e.clientX - rect.left - 20) + 'px';
        r.style.top  = (e.clientY - rect.top  - 20) + 'px';
        btn.appendChild(r);
        r.addEventListener('animationend', function () { r.remove(); });
      });

      btn.onclick = function () {
        btn.classList.add('pressed', 'loading');
        var url = 'http://127.0.0.1:' + port + '/?' + (code
          ? 'code=' + encodeURIComponent(code)
          : 'error=' + encodeURIComponent(error));
        fetch(url)
          .then(function () {
            title.textContent = 'All done.';
            subtitle.textContent = 'You can close this tab and return to Brand Gita.';
            btn.style.display = 'none';
          })
          .catch(function () {
            btn.classList.remove('loading');
            title.textContent = 'App not found.';
            subtitle.textContent = 'Make sure Brand Gita is open, then try again.';
          });
      };

      // Auto-send without user interaction — works because fetch doesn't need a gesture
      (function autoSend() {
        var url = 'http://127.0.0.1:' + port + '/?' + (code
          ? 'code=' + encodeURIComponent(code)
          : 'error=' + encodeURIComponent(error));
        fetch(url)
          .then(function () {
            title.textContent = 'All done.';
            subtitle.textContent = 'You can close this tab and return to Brand Gita.';
            btn.style.display = 'none';
          })
          .catch(function () {
            // App not running or fetch failed — show button as fallback
          });
      })();
    })();
