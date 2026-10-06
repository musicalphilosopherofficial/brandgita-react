(function () {
  var $ = function (id) { return document.getElementById(id); };
  var LS = 'bg_licence';
  var MUSIC = 'https://www.tiktok.com/legal/page/global/music-usage-confirmation/en';
  var BRANDED = 'https://www.tiktok.com/legal/page/global/bc-policy/en';
  var licence = '';
  try { licence = localStorage.getItem(LS) || ''; } catch (e) {}
  var creator = null;
  var file = null;

  var LABELS = { PUBLIC_TO_EVERYONE: 'Everyone', MUTUAL_FOLLOW_FRIENDS: 'Friends', FOLLOWER_OF_CREATOR: 'Followers', SELF_ONLY: 'Only me' };

  function api(action, opts) {
    opts = opts || {};
    var q = opts.query ? '?' + opts.query : '';
    return fetch('/api/tiktok/' + action + q, {
      method: opts.method || 'GET',
      headers: Object.assign({ Authorization: 'Bearer ' + licence }, opts.headers || {}, opts.json ? { 'Content-Type': 'application/json' } : {}),
      body: opts.json ? JSON.stringify(opts.json) : opts.body,
    }).then(function (r) { return r.json().then(function (d) { d._status = r.status; return d; }); });
  }
  function show(id, on) { $(id).hidden = !on; }
  function say(msg, bad) { var s = $('status'); s.textContent = msg; s.className = 'status' + (bad ? ' err' : ''); }

  function boot() {
    if (!licence) { show('licence-panel', true); return; }
    api('me').then(function (d) {
      if (d._status === 401 || d._status === 402) { try { localStorage.removeItem(LS); } catch (e) {} licence = ''; show('licence-panel', true); return; }
      if (!d.connected) { show('connect-panel', true); return; }
      creator = d.creator || {};
      $('nickname').textContent = creator.creator_nickname || d.display_name || 'your TikTok account';
      var sel = $('privacy');
      (creator.privacy_level_options || []).forEach(function (v) {
        var o = document.createElement('option'); o.value = v; o.textContent = LABELS[v] || v; sel.appendChild(o);
      });
      $('allow-comment').disabled = !!creator.comment_disabled;
      $('allow-duet').disabled = !!creator.duet_disabled;
      $('allow-stitch').disabled = !!creator.stitch_disabled;
      show('post-panel', true);
      refresh();
    }).catch(function () { show('licence-panel', true); say('Could not reach Brand Gita. Try again.', true); });
  }

  $('save-licence').onclick = function () {
    licence = $('licence').value.trim();
    if (!licence) return;
    try { localStorage.setItem(LS, licence); } catch (e) {}
    show('licence-panel', false); boot();
  };
  $('connect').onclick = function () {
    api('auth-url').then(function (d) { if (d.url) location.href = d.url; else say(d.error || 'Could not start TikTok sign-in', true); });
  };
  $('disconnect').onclick = function () {
    api('disconnect', { method: 'POST' }).then(function () { location.reload(); });
  };

  $('file').onchange = function () {
    file = this.files[0] || null;
    var v = $('preview');
    v.onerror = function () { v.hidden = true; $('duration-note').textContent = 'Selected: ' + (file ? file.name : '') + ' — preview unavailable in this browser.'; };
    if (file) { v.src = URL.createObjectURL(file); v.hidden = false; $('duration-note').textContent = ''; } else { v.hidden = true; }
    refresh();
  };
  ['privacy', 'disclose', 'brand-organic', 'brand-content', 'title'].forEach(function (id) { $(id).oninput = $(id).onchange = refresh; });

  function refresh() {
    var disclosed = $('disclose').checked;
    show('disclose-options', disclosed);
    var organic = $('brand-organic').checked, branded = $('brand-content').checked;
    var priv = $('privacy').value;
    var label = '';
    if (disclosed && branded) label = 'Your post will be labelled “Paid partnership”.';
    else if (disclosed && organic) label = 'Your post will be labelled “Promotional content”.';
    $('disclose-label').textContent = label;

    var brandedPrivate = branded && priv === 'SELF_ONLY';
    var needsType = disclosed && !organic && !branded;
    $('consent').innerHTML = branded
      ? 'By posting, you agree to TikTok&rsquo;s <a href="' + BRANDED + '" target="_blank" rel="noopener">Branded Content Policy</a> and <a href="' + MUSIC + '" target="_blank" rel="noopener">Music Usage Confirmation</a>.'
      : 'By posting, you agree to TikTok&rsquo;s <a href="' + MUSIC + '" target="_blank" rel="noopener">Music Usage Confirmation</a>.';
    if (brandedPrivate) say('Branded content cannot be posted as “Only me”. Choose a different visibility.', true);
    else if ($('status').className.indexOf('err') !== -1 && /Branded content cannot/.test($('status').textContent)) say('');
    $('post').disabled = !(file && priv && !needsType && !brandedPrivate);
  }

  var CHUNK = 20 * 1024 * 1024;
  $('post').onclick = function () {
    if (!file) return;
    $('post').disabled = true;
    var size = file.size;
    var chunk = size <= CHUNK ? size : CHUNK;
    var total = size <= CHUNK ? 1 : Math.floor(size / CHUNK);
    say('Starting…');
    api('post', { method: 'POST', json: {
      kind: 'video', title: $('title').value, privacy_level: $('privacy').value,
      disable_comment: !$('allow-comment').checked, disable_duet: !$('allow-duet').checked, disable_stitch: !$('allow-stitch').checked,
      brand_organic_toggle: $('disclose').checked && $('brand-organic').checked,
      brand_content_toggle: $('disclose').checked && $('brand-content').checked,
      video_size: size, chunk_size: chunk, total_chunk_count: total,
    } }).then(function (d) {
      if (!d.publish_id || !d.upload_url) throw new Error(d.error || 'TikTok did not accept the post');
      return upload(d.upload_url, size, chunk, total).then(function () { return poll(d.publish_id); });
    }).catch(function (e) { say(e.message || 'Something went wrong', true); $('post').disabled = false; $('progress').hidden = true; });
  };

  function upload(target, size, chunk, total) {
    var p = $('progress'); p.hidden = false; p.value = 0;
    var i = 0;
    function next() {
      if (i >= total) return Promise.resolve();
      var start = i * chunk, end = i === total - 1 ? size : start + chunk;
      var blob = file.slice(start, end);
      return fetch('/api/tiktok/upload?target=' + encodeURIComponent(target), {
        method: 'PUT',
        headers: { Authorization: 'Bearer ' + licence, 'Content-Range': 'bytes ' + start + '-' + (end - 1) + '/' + size, 'X-Content-Type': file.type || 'video/mp4' },
        body: blob,
      }).then(function (r) { return r.json(); }).then(function (d) {
        if (!d.ok) throw new Error('Upload to TikTok failed. Try again.');
        i++; p.value = Math.round((i / total) * 100); say('Uploading… ' + p.value + '%');
        return next();
      });
    }
    return next();
  }

  function poll(id, n) {
    n = n || 0;
    return api('status', { query: 'publish_id=' + encodeURIComponent(id) }).then(function (d) {
      var s = d.status || '';
      if (s === 'PUBLISH_COMPLETE') { say('Posted to TikTok. It may take a moment to appear on your profile.'); $('progress').hidden = true; return; }
      if (s === 'FAILED') throw new Error('TikTok could not publish this video' + (d.fail_reason ? ' (' + d.fail_reason + ')' : '') + '.');
      if (n > 40) { say('TikTok is still processing your video. Check your TikTok app shortly.'); return; }
      say('TikTok is processing your video…');
      return new Promise(function (r) { setTimeout(r, 3000); }).then(function () { return poll(id, n + 1); });
    });
  }

  boot();
})();
