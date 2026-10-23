// File: public/app.js · plain browser JS + Parse JS SDK (CDN). No build step.
// Everything that matters happens in Cloud functions; this file only signs in, calls them and renders.
/* global Parse */
(() => {
  const cfg = window.APP_CONFIG || {};
  Parse.initialize(cfg.appId, cfg.jsKey);
  Parse.serverURL = cfg.serverUrl;

  const LEVEL = 1;
  const $ = (id) => document.getElementById(id);
  const log = (msg, obj) => {
    const line = `${new Date().toLocaleTimeString()} ${msg}${obj === undefined ? '' : ' ' + JSON.stringify(obj)}`;
    $('log').textContent = (line + '\n' + $('log').textContent).slice(0, 20000);
  };
  const show = (id, text, ok) => { const el = $(id); el.textContent = text; el.className = 'result ' + (ok ? 'ok' : 'err'); };

  // Cloud functions throw Parse.Error(code, '{"code":"STALE_SAVE",...}'): unwrap the JSON envelope.
  function parseCloudError(err) {
    const out = { parseCode: err && err.code, code: 'PARSE_' + (err && err.code), message: (err && err.message) || String(err) };
    if (typeof out.message === 'string' && out.message.startsWith('{')) {
      try { Object.assign(out, JSON.parse(out.message)); } catch { /* plain message */ }
    }
    return out;
  }
  async function run(name, params) {
    try {
      const result = await Parse.Cloud.run(name, params);
      log(`${name} ok`, result);
      return { ok: true, result };
    } catch (err) {
      const e = parseCloudError(err);
      log(`${name} failed`, e);
      return { ok: false, error: e };
    }
  }

  let player = null;        // from ensurePlayer
  let nextCounter = 1;      // monotonic per player: last accepted + 1
  let lastSubmission = null; // for the replay demo
  let saveVersion = 0;      // version of slot 0 as last loaded/saved

  async function refreshAccount() {
    const user = Parse.User.current();
    const signedIn = !!user;
    $('btn-guest').hidden = signedIn;
    $('form-login').hidden = signedIn;
    $('btn-logout').hidden = !signedIn;
    $('form-upgrade').hidden = !(signedIn && Parse.AnonymousUtils.isLinked(user));
    $('form-profile').hidden = !signedIn;
    for (const id of ['btn-play', 'btn-cheat-ceiling', 'btn-cheat-replay', 'btn-load', 'btn-save']) $(id).disabled = !signedIn;
    if (!signedIn) { $('who').textContent = 'Not signed in.'; player = null; return; }
    const r = await run('ensurePlayer', {});
    if (!r.ok) { $('who').textContent = 'ensurePlayer failed: ' + r.error.message; return; }
    player = r.result;
    nextCounter = player.lastSessionCounter + 1;
    $('who').textContent = `${Parse.AnonymousUtils.isLinked(user) ? 'Guest' : 'Account ' + user.getUsername()} · ${player.displayName}${player.country ? ' (' + player.country + ')' : ''} · user ${user.id}`;
    $('profile-name').value = player.displayName;
    $('profile-country').value = player.country;
    await refreshBoard();
    await loadSave(true);
  }

  async function refreshBoard() {
    const scope = $('scope').value;
    const top = await run('leaderboard', { level: LEVEL, scope, limit: 10 });
    const me = Parse.User.current();
    const ol = $('top10');
    ol.innerHTML = '';
    if (top.ok) {
      for (const e of top.result.entries) {
        const li = document.createElement('li');
        li.innerHTML = `<span class="rank">${e.rank}.</span><span class="name ${me && e.playerId === me.id ? 'me' : ''}"></span><span class="score">${e.score}</span>`;
        li.querySelector('.name').textContent = e.playerName;
        ol.appendChild(li);
      }
      if (!top.result.entries.length) ol.innerHTML = '<li class="muted">No scores yet.</li>';
    }
    if (me) {
      const r = await run('myRank', { level: LEVEL, scope });
      $('myrank').textContent = r.ok ? (r.result.rank === null ? 'unranked' : `#${r.result.rank} with ${r.result.score}`) : r.error.message;
    } else {
      $('myrank').textContent = '—';
    }
  }

  async function submit(score, replay) {
    const params = replay && lastSubmission ? lastSubmission : { level: LEVEL, score, sessionCounter: nextCounter, clientNonce: crypto.randomUUID() };
    const r = await run('submitScore', params);
    if (r.ok) {
      if (!r.result.replay) { lastSubmission = params; nextCounter = params.sessionCounter + 1; }
      show('submit-result', `${r.result.replay ? 'Replay recognised: counted once' : 'Accepted'} · score ${r.result.score} · best ${r.result.best.score} (week ${r.result.best.week}: ${r.result.best.weekScore}) · ${r.result.rateLimit ? r.result.rateLimit.used + '/' + r.result.rateLimit.max + ' this minute' : ''}`, true);
    } else {
      // Counters are consumed on most rejections; keep the client in step with the server.
      if (r.error.code === 'COUNTER_NOT_MONOTONIC') nextCounter = r.error.lastSessionCounter + 1;
      else if (r.error.code === 'CEILING_EXCEEDED') nextCounter = params.sessionCounter + 1;
      show('submit-result', `Rejected: ${r.error.code} — ${r.error.message}`, false);
    }
    await refreshBoard();
  }

  async function loadSave(quiet) {
    const r = await run('getSave', { slot: 0 });
    if (!r.ok) { show('save-result', r.error.message, false); return; }
    saveVersion = r.result.version;
    $('save-version').textContent = `version: ${saveVersion}`;
    if (r.result.blob !== null) $('save-blob').value = r.result.blob;
    if (!quiet) show('save-result', r.result.blob === null ? 'Slot 0 is empty.' : `Loaded version ${saveVersion} (${r.result.bytes} bytes).`, true);
  }

  async function putSave() {
    const blob = $('save-blob').value;
    try { JSON.parse(blob); } catch { show('save-result', 'The blob must be valid JSON.', false); return; }
    const r = await run('putSave', { slot: 0, baseVersion: saveVersion, blob });
    if (r.ok) {
      saveVersion = r.result.version;
      $('save-version').textContent = `version: ${saveVersion}`;
      show('save-result', `Saved version ${saveVersion} (${r.result.bytes} bytes).`, true);
    } else if (r.error.code === 'STALE_SAVE') {
      show('save-result', `STALE_SAVE: the server has version ${r.error.currentVersion}, you loaded ${saveVersion}. Load, merge, save again.`, false);
    } else {
      show('save-result', `${r.error.code}: ${r.error.message}`, false);
    }
  }

  $('btn-guest').onclick = async () => {
    try { await Parse.AnonymousUtils.logIn(); log('anonymous sign-in ok', { id: Parse.User.current().id }); }
    catch (err) { log('anonymous sign-in failed', parseCloudError(err)); }
    await refreshAccount();
  };
  $('btn-logout').onclick = async () => { await Parse.User.logOut(); lastSubmission = null; await refreshAccount(); };
  $('form-login').onsubmit = async (ev) => {
    ev.preventDefault();
    try { await Parse.User.logIn($('login-username').value, $('login-password').value); log('login ok'); }
    catch (err) { log('login failed', parseCloudError(err)); alert('Sign-in failed: ' + err.message); }
    $('login-password').value = '';
    await refreshAccount();
  };
  $('form-upgrade').onsubmit = async (ev) => {
    ev.preventDefault();
    const user = Parse.User.current();
    user.setUsername($('upgrade-username').value);
    user.setPassword($('upgrade-password').value);
    try {
      await user.signUp(); // on an anonymous user the SDK sends username+password and authData.anonymous=null
      log('upgrade ok', { id: user.id, username: user.getUsername() });
    } catch (err) {
      log('upgrade failed', parseCloudError(err));
      alert('Upgrade failed: ' + err.message);
    }
    $('upgrade-password').value = '';
    await refreshAccount();
  };
  $('form-profile').onsubmit = async (ev) => {
    ev.preventDefault();
    const r = await run('ensurePlayer', { displayName: $('profile-name').value, country: $('profile-country').value });
    if (!r.ok) alert(r.error.message);
    await refreshAccount();
  };
  $('btn-play').onclick = () => submit(Math.floor(Math.random() * 10000 * LEVEL));
  $('btn-cheat-ceiling').onclick = () => submit(10000 * LEVEL + 1);
  $('btn-cheat-replay').onclick = () => (lastSubmission ? submit(0, true) : show('submit-result', 'Play a round first.', false));
  $('btn-refresh').onclick = refreshBoard;
  $('scope').onchange = refreshBoard;
  $('btn-load').onclick = () => loadSave(false);
  $('btn-save').onclick = putSave;

  $('ceiling').textContent = String(10000 * LEVEL);
  refreshAccount();
})();
