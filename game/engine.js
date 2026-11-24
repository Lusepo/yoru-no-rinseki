/* 夜の隣席 — mobile browser novel engine. No build step.
   Script: ../script/game_script.json (authoritative). Art: ../art/{bg,cg,standee}/ */
'use strict';
(function () {
  const PATHS = {
    script: '../script/game_script.json',
    bg: (id) => `../art/bg/${id}.jpg`,
    cg: (id) => `../art/cg/${id}.jpg`,
    standee: (c, e) => `../art/standee/${c}_${e}.png`,
  };
  const SAVE_FORMAT = 'yoru-no-rinseki-save';
  const SAVE_VERSION = 1;
  const SLOT_COUNT = 8;
  const LOG_MAX = 150;
  const NS = 'yoru-no-rinseki/v1/';
  const SPEED_CPS = [0, 12, 20, 30, 42, 55, 70, 95, 130, 200, Infinity];
  const VISUAL = new Set(['bg', 'show', 'hide', 'cg', 'cg_hide']);

  const $ = (s) => document.querySelector(s);
  const stage = $('#stage');
  const el = {
    box: $('#box'), name: $('#nameplate'), text: $('#text'), tv: $('#tv'), th: $('#th'), cursor: $('#cursor'),
    measure: $('#measure'), choices: $('#choices'), chars: $('#chars'), loc: $('#loc'), title: $('#title'),
    toast: $('#toast'), boot: $('#boot'),
  };

  /* ---------- storage ---------- */
  const store = {
    get(k, d) { try { const v = localStorage.getItem(NS + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(NS + k, JSON.stringify(v)); return true; } catch (e) { console.warn('storage failed', e); return false; } },
    del(k) { try { localStorage.removeItem(NS + k); } catch (e) { /* ignore */ } },
  };
  const G = Object.assign({ read: {}, endings: {}, cgs: {}, settings: {} }, store.get('global', {}));
  G.settings = Object.assign({ speed: 5, autowait: 5 }, G.settings || {});
  const saveGlobal = () => store.set('global', G);

  /* ---------- data ---------- */
  let DATA = null, SCENES = {}, SCRIPT_HASH = '', CHARNAMES = {}, ENDINGS = [], CGS = [];

  /* ---------- runtime state ---------- */
  let S = null;              // serialisable game state
  let waiting = null;        // 'text' | 'choice' | 'input' | 'ending' | null
  let runToken = 0;
  let line = null;           // {key, pages, page, typing}
  let typeRAF = 0, autoTimer = 0, skipTimer = 0, locTimer = 0;
  let autoOn = false, skipOn = false, uiHidden = false;
  let openPanel = null;

  function freshState() {
    return { scene: null, pc: 0, page: 0, vars: { name: DATA.meta.name_default || 'ハル' }, bg: null, cg: null, chars: {}, log: [], loc: null };
  }
  const clone = (o) => JSON.parse(JSON.stringify(o));
  function hash(str) { let h = 2166136261 >>> 0; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h.toString(16); }
  const subst = (s) => String(s == null ? '' : s).replace(/\{(\w+)\}/g, (m, k) => (S && S.vars[k] != null ? String(S.vars[k]) : m));
  function speakerName(sp) { if (sp == null || sp === '') return null; return subst(CHARNAMES[sp] || sp); }
  function lineBody(c) { const t = subst(c.text); return c.speaker ? `「${t}」` : t; }
  const lineKey = (scene, pc) => `${scene}#${pc}`;

  /* ---------- images ---------- */
  const imgCache = new Map();
  function loadImg(url) {
    if (!imgCache.has(url)) {
      imgCache.set(url, new Promise((res) => {
        const im = new Image();
        im.decoding = 'async';
        im.onload = () => { (im.decode ? im.decode() : Promise.resolve()).catch(() => {}).then(() => res(true)); };
        im.onerror = () => { console.error('画像を読み込めません: ' + url); imgCache.delete(url); res(false); };
        im.src = url;
      }));
    }
    return imgCache.get(url);
  }
  function sceneImages(sc) {
    const out = [];
    if (sc.bg) out.push(PATHS.bg(sc.bg));
    for (const c of sc.commands) {
      if (c.type === 'bg') out.push(PATHS.bg(c.id));
      else if (c.type === 'cg') out.push(PATHS.cg(c.id));
      else if (c.type === 'show') out.push(PATHS.standee(c.char, c.expr));
    }
    return out;
  }
  function successors(sc) {
    const out = [];
    for (const c of sc.commands) {
      if (c.type === 'jump') out.push(c.goto);
      else if (c.type === 'choice') c.options.forEach((o) => out.push(o.goto));
      else if (c.type === 'route_check') out.push(...Object.values(c.routes), c.fallback);
    }
    return out;
  }
  function preloadAround(id) {
    const sc = SCENES[id]; if (!sc) return;
    const urls = sceneImages(sc);
    for (const n of successors(sc)) if (SCENES[n]) urls.push(...sceneImages(SCENES[n]));
    // keep preloading light: dedupe, idle-time
    const run = () => [...new Set(urls)].forEach(loadImg);
    (window.requestIdleCallback || ((f) => setTimeout(f, 60)))(run);
  }

  /* ---------- visual layers ---------- */
  class FadeLayer {
    constructor(root, kind) { this.root = root; this.imgs = [...root.querySelectorAll('img')]; this.front = 0; this.id = null; this.kind = kind; this.seq = 0; }
    async set(id, url) {
      if (id === this.id) return;
      this.id = id; const seq = ++this.seq;
      const f = this.imgs[this.front], b = this.imgs[1 - this.front];
      if (!id) {
        f.classList.add('now'); b.classList.add('now');
        f.classList.remove('on'); b.classList.remove('on');
        delete f.dataset.id; delete b.dataset.id;
        stage.dataset[this.kind] = '';
        return;
      }
      b.classList.remove('on');
      b.src = url; b.dataset.id = id;
      try { await b.decode(); } catch (e) { /* fallthrough: shows whatever loaded */ }
      if (seq !== this.seq) return;
      b.style.zIndex = 2; f.style.zIndex = 1;
      b.classList.remove('now'); f.classList.remove('now');
      b.classList.add('on');
      if (f.classList.contains('on')) f.classList.remove('on'); // fades out after the new one is in (CSS delay)
      delete f.dataset.id;
      this.front = 1 - this.front;
      stage.dataset[this.kind] = id;
    }
  }
  const bgLayer = new FadeLayer($('#bg'), 'bg');
  const cgLayer = new FadeLayer($('#cg'), 'cg');
  const charEls = new Map(); // char -> wrap

  async function setChars(want) {
    const jobs = [];
    for (const [c, v] of Object.entries(want)) {
      let w = charEls.get(c);
      const url = PATHS.standee(c, v.expr);
      if (!w) {
        w = document.createElement('div'); w.className = 'standee';
        w.dataset.char = c; w.dataset.pos = v.pos || 'center'; w.dataset.expr = v.expr;
        const im = new Image(); im.alt = ''; im.draggable = false; im.src = url; w.appendChild(im);
        charEls.set(c, w);
        jobs.push(im.decode().catch(() => {}).then(() => { if (charEls.get(c) === w) { el.chars.appendChild(w); void w.offsetWidth; w.classList.add('on'); } }));
        el.chars.appendChild(w); // attach immediately (opacity 0) so DOM state reflects intent
      } else {
        w.dataset.pos = v.pos || 'center';
        if (w.dataset.expr !== v.expr) {
          w.dataset.expr = v.expr;
          const im = new Image(); im.alt = ''; im.draggable = false; im.className = 'incoming'; im.src = url;
          jobs.push(im.decode().catch(() => {}).then(() => {
            if (w.dataset.expr !== v.expr) return;
            const old = [...w.querySelectorAll('img')];
            w.appendChild(im); void im.offsetWidth; im.classList.remove('incoming');
            const done = () => old.forEach((o) => o.remove());
            if (stage.classList.contains('instant')) done(); else setTimeout(done, 200);
          }));
        }
      }
    }
    for (const [c, w] of [...charEls]) {
      if (!want[c]) {
        charEls.delete(c); w.classList.remove('on'); w.classList.add('leaving');
        if (stage.classList.contains('instant')) w.remove(); else setTimeout(() => w.remove(), 280);
      }
    }
    await Promise.all(jobs);
  }

  async function renderVisuals() {
    const want = { bg: S.bg, cg: S.cg, chars: clone(S.chars) };
    const urls = [];
    if (want.bg) urls.push(PATHS.bg(want.bg));
    if (want.cg) urls.push(PATHS.cg(want.cg));
    for (const [c, v] of Object.entries(want.chars)) urls.push(PATHS.standee(c, v.expr));
    await Promise.all(urls.map(loadImg));
    await Promise.all([
      bgLayer.set(want.bg, want.bg && PATHS.bg(want.bg)),
      cgLayer.set(want.cg, want.cg && PATHS.cg(want.cg)),
      setChars(want.chars),
    ]);
    if (want.cg && !G.cgs[want.cg]) { G.cgs[want.cg] = 1; saveGlobal(); }
  }

  function setInstant(on) { stage.classList.toggle('instant', !!on); }

  /* ---------- location caption ---------- */
  function showLoc(sc) {
    clearTimeout(locTimer);
    if (!sc.location || skipOn) { el.loc.classList.remove('on'); return; }
    el.loc.querySelector('.loc-place').textContent = sc.location;
    el.loc.querySelector('.loc-time').textContent = sc.time || '';
    el.loc.hidden = false; void el.loc.offsetWidth; el.loc.classList.add('on');
    locTimer = setTimeout(() => el.loc.classList.remove('on'), 2600);
  }

  /* ---------- script execution ---------- */
  function enterScene(id) {
    const sc = SCENES[id];
    if (!sc) throw new Error('存在しないシーン: ' + id);
    S.scene = id; S.pc = 0; S.page = 0;
    const first = sc.commands[0];
    if (sc.bg && (!first || first.type !== 'bg') && S.bg !== sc.bg) S.bg = sc.bg;
    if (sc.location && sc.location !== S.loc) { S.loc = sc.location; showLoc(sc); }
    preloadAround(id);
  }

  function routeDest(c) {
    const scores = {};
    for (const h of Object.keys(c.routes)) scores[h] = parseInt(S.vars['aff_' + h] || 0, 10) || 0;
    const vals = Object.values(scores);
    const best = vals.length ? Math.max(...vals) : 0;
    if (best < Number(c.min)) return c.fallback;
    const tied = Object.keys(scores).filter((h) => scores[h] === best);
    for (const h of c.tiebreak || []) if (tied.includes(h)) return c.routes[h];
    return c.fallback;
  }

  function applyEffects(eff) {
    if (!eff) return;
    for (const [k, v] of Object.entries(eff)) {
      if (k.startsWith('aff_')) S.vars[k] = (parseInt(S.vars[k] || 0, 10) || 0) + (parseInt(v, 10) || 0);
      else S.vars[k] = v;
    }
  }

  async function run() {
    const tok = ++runToken;
    waiting = null;
    let guard = 0;
    try {
      while (tok === runToken) {
        if (++guard > 5000) throw new Error('無限ループを検出しました: ' + S.scene);
        const sc = SCENES[S.scene];
        const c = sc.commands[S.pc];
        if (!c) throw new Error(`シーン ${S.scene} の終端に出口がありません`);
        if (VISUAL.has(c.type)) {
          if (c.type === 'bg') S.bg = c.id;
          else if (c.type === 'show') S.chars[c.char] = { expr: c.expr, pos: c.position || 'center' };
          else if (c.type === 'hide') delete S.chars[c.char];
          else if (c.type === 'cg') S.cg = c.id;
          else if (c.type === 'cg_hide') S.cg = null;
          S.pc++; continue;
        }
        switch (c.type) {
          case 'bgm': case 'se': case 'wait': S.pc++; continue; // no audio assets: ignore gracefully
          case 'jump': enterScene(c.goto); continue;
          case 'route_check': await renderVisuals(); if (tok !== runToken) return; enterScene(routeDest(c)); continue;
          case 'text': await renderVisuals(); if (tok !== runToken) return; showLine(c); return;
          case 'choice': await renderVisuals(); if (tok !== runToken) return; showChoice(c); return;
          case 'input_name': await renderVisuals(); if (tok !== runToken) return; showNameInput(c); return;
          case 'ending': await renderVisuals(); if (tok !== runToken) return; showEnding(c); return;
          default: console.warn('未対応のコマンドを無視しました:', c.type); S.pc++; continue;
        }
      }
    } catch (err) {
      console.error(err);
      fatal(String(err && err.message || err));
    }
  }

  /* ---------- text ---------- */
  function fits(str) {
    el.measure.style.width = el.text.clientWidth + 'px';
    el.measure.textContent = str; // + a copy of the page cursor, which must fit too
    const cur = document.createElement('span'); cur.className = 'cursor'; el.measure.appendChild(cur);
    return el.measure.scrollHeight <= el.text.clientHeight + 0.5;
  }
  function paginate(str) {
    if (fits(str)) return [str];
    const pages = []; let rest = str; let safety = 0;
    while (rest.length && safety++ < 50) {
      if (fits(rest)) { pages.push(rest); break; }
      let lo = 1, hi = rest.length;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (fits(rest.slice(0, mid))) lo = mid; else hi = mid - 1; }
      let cut = lo;
      const breakAfter = '。、！？!?」』）…―';
      for (let i = lo; i > Math.max(1, lo - 24); i--) { if (breakAfter.includes(rest[i - 1]) && !breakAfter.includes(rest[i] || '')) { cut = i; break; } }
      while (cut > 1 && '。、」』）！？…'.includes(rest[cut] || '')) cut--; // never start a page with closing punctuation
      pages.push(rest.slice(0, cut)); rest = rest.slice(cut);
    }
    return pages;
  }

  function cps() { return SPEED_CPS[Math.max(1, Math.min(10, G.settings.speed | 0))]; }

  function showLine(c) {
    const key = lineKey(S.scene, S.pc);
    if (skipOn && !G.read[key]) setSkip(false); // skip stops at the first unread line
    const sp = speakerName(c.speaker);
    const body = lineBody(c);
    const last = S.log[S.log.length - 1];
    if (!last || last.key !== key) { S.log.push({ key, who: sp, text: body }); if (S.log.length > LOG_MAX) S.log.splice(0, S.log.length - LOG_MAX); }
    el.box.hidden = false; el.choices.hidden = true;
    el.name.hidden = !sp; el.name.textContent = sp || '';
    const pages = paginate(body);
    const page = Math.min(S.page || 0, pages.length - 1);
    line = { key, pages, page, typing: false, read: !!G.read[key] };
    stage.dataset.line = key;
    waiting = 'text';
    autosave();
    typePage();
  }

  function typePage() {
    cancelAnimationFrame(typeRAF); clearTimeout(autoTimer); clearTimeout(skipTimer);
    S.page = line.page;
    const txt = line.pages[line.page];
    const chars = Array.from(txt);
    el.cursor.hidden = true;
    const speed = skipOn ? Infinity : cps();
    if (speed === Infinity) { el.tv.textContent = txt; el.th.textContent = ''; return pageDone(); }
    line.typing = true;
    el.tv.textContent = ''; el.th.textContent = txt;
    const t0 = performance.now();
    const step = (now) => {
      if (!line || !line.typing) return;
      const n = Math.min(chars.length, Math.floor(((now - t0) / 1000) * speed) + 1);
      el.tv.textContent = chars.slice(0, n).join(''); el.th.textContent = chars.slice(n).join('');
      if (n >= chars.length) { line.typing = false; pageDone(); } else typeRAF = requestAnimationFrame(step);
    };
    typeRAF = requestAnimationFrame(step);
  }
  function completeTyping() {
    cancelAnimationFrame(typeRAF);
    line.typing = false; el.tv.textContent = line.pages[line.page]; el.th.textContent = ''; pageDone();
  }
  function pageDone() {
    const more = line.page < line.pages.length - 1;
    el.cursor.hidden = false; el.cursor.classList.toggle('page', more);
    stage.dataset.typing = '0';
    if (skipOn) { skipTimer = setTimeout(() => { if (waiting === 'text' && skipOn) advance(true); }, 45); return; }
    if (autoOn) scheduleAuto();
  }
  function scheduleAuto() {
    clearTimeout(autoTimer);
    const n = Array.from(line.pages[line.page]).length;
    const w = 11 - (G.settings.autowait | 0); // 1..10 -> slow..fast
    const ms = 600 + w * 180 + n * (25 + w * 9);
    autoTimer = setTimeout(() => { if (autoOn && waiting === 'text' && !openPanel && !uiHidden) advance(true); }, ms);
  }

  function advance(fromMode) {
    if (waiting !== 'text' || !line) return;
    if (line.typing) { completeTyping(); return; }
    if (line.page < line.pages.length - 1) { line.page++; typePage(); return; }
    G.read[line.key] = 1; saveGlobal();
    line = null; S.page = 0; S.pc++;
    run();
  }

  /* ---------- choices ---------- */
  function showChoice(c) {
    setSkip(false);
    clearTimeout(autoTimer);
    waiting = 'choice';
    el.choices.innerHTML = '';
    el.choices.classList.toggle('many', c.options.length > 4);
    el.box.hidden = false;
    c.options.forEach((o, i) => {
      const b = document.createElement('button'); b.type = 'button';
      b.textContent = subst(o.text); b.dataset.goto = o.goto; b.dataset.index = i;
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (waiting !== 'choice') return;
        waiting = null; el.choices.hidden = true;
        S.log.push({ key: lineKey(S.scene, S.pc) + '/c', who: null, text: subst(o.text), pick: true });
        if (S.log.length > LOG_MAX) S.log.splice(0, S.log.length - LOG_MAX);
        applyEffects(o.effects);
        enterScene(o.goto);
        run();
      });
      el.choices.appendChild(b);
    });
    el.choices.hidden = false;
    el.choices.scrollTop = el.choices.scrollHeight;
    stage.dataset.line = lineKey(S.scene, S.pc);
    autosave();
  }

  /* ---------- name input ---------- */
  let nameCmd = null;
  function showNameInput(c) {
    setSkip(false); setAuto(false);
    waiting = 'input'; nameCmd = c;
    const def = c.default || DATA.meta.name_default || 'ハル';
    $('#name-default').textContent = def;
    const inp = $('#name-input');
    const cur = S.vars[c.variable || 'name'];
    inp.value = cur || def;
    $('#name-err').textContent = '';
    showPanel('p-name');
    stage.dataset.line = lineKey(S.scene, S.pc);
    setTimeout(() => { try { inp.focus({ preventScroll: true }); inp.select(); } catch (e) { /* ignore */ } }, 50);
  }
  function validateName(raw) {
    const v = String(raw || '').normalize('NFC').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/g, '').replace(/^[\s\u3000]+|[\s\u3000]+$/g, '');
    const n = Array.from(v).length;
    if (n === 0) return { err: '名前を入力してください。' };
    if (n > 8) return { err: `8文字以内で入力してください（いま${n}文字）。` };
    if (/[{}<>]/.test(v)) return { err: '記号 { } < > は使えません。' };
    return { value: v };
  }
  function submitName() {
    if (waiting !== 'input' || !nameCmd) return;
    const r = validateName($('#name-input').value);
    if (r.err) { $('#name-err').textContent = r.err; return; }
    S.vars[nameCmd.variable || 'name'] = r.value;
    $('#name-input').blur();
    hidePanel(); nameCmd = null; waiting = null;
    S.pc++; run();
  }

  /* ---------- ending ---------- */
  function showEnding(c) {
    setSkip(false); setAuto(false);
    waiting = 'ending';
    G.endings[c.id] = 1; saveGlobal();
    store.del('save/auto');
    const got = ENDINGS.filter((e) => G.endings[e.id]).length;
    $('#end-title').textContent = `「${subst(c.title).replace(/([、。])/g, '$1\u200B')}」`;
    $('#end-progress').textContent = `エンディング ${got} / ${ENDINGS.length}`;
    el.box.hidden = true; el.choices.hidden = true;
    el.loc.classList.remove('on'); el.loc.hidden = true;
    stage.dataset.ending = c.id;
    stage.dataset.line = lineKey(S.scene, S.pc);
    showPanel('p-ending');
  }

  /* ---------- modes ---------- */
  function setAuto(on) {
    autoOn = !!on; $('#mode-auto').hidden = !autoOn;
    document.querySelector('[data-act="auto"]').classList.toggle('active', autoOn);
    clearTimeout(autoTimer);
    if (autoOn && waiting === 'text' && line && !line.typing) scheduleAuto();
  }
  function setSkip(on) {
    skipOn = !!on; $('#mode-skip').hidden = !skipOn;
    document.querySelector('[data-act="skip"]').classList.toggle('active', skipOn);
    setInstant(skipOn);
    clearTimeout(skipTimer);
    if (skipOn) {
      if (waiting === 'text' && line) {
        if (!line.read) { setSkip(false); toast('未読の文章です'); return; }
        if (line.typing) completeTyping(); else skipTimer = setTimeout(() => advance(true), 45);
      }
    }
  }
  /* ---------- save / load ---------- */
  function snapshot() {
    const sc = SCENES[S.scene]; const c = sc.commands[S.pc];
    return {
      format: SAVE_FORMAT, v: SAVE_VERSION, script: SCRIPT_HASH, time: Date.now(),
      check: { type: c.type, text: c.text || null },
      label: { scene: sc.title || S.scene, text: c.type === 'text' ? lineBody(c) : (c.type === 'choice' ? '（選択肢）' : '（名前入力）'), bg: S.cg ? PATHS.cg(S.cg) : (S.bg ? PATHS.bg(S.bg) : '') },
      state: clone(S),
    };
  }
  function canSave() { return S && (waiting === 'text' || waiting === 'choice'); }
  function autosave() { if (canSave()) store.set('save/auto', snapshot()); }
  function validSave(d) {
    if (!d || d.format !== SAVE_FORMAT || d.v !== SAVE_VERSION || !d.state) return 'データの形式が違います。';
    const st = d.state; const sc = SCENES[st.scene];
    if (!sc) return '台本が更新されたため、このデータは読み込めません。';
    const c = sc.commands[st.pc];
    if (!c || !d.check || c.type !== d.check.type || (c.text || null) !== d.check.text) return '台本が更新されたため、このデータは読み込めません。';
    if (!['text', 'choice', 'input_name'].includes(c.type)) return 'データが壊れています。';
    return null;
  }
  async function loadSave(d) {
    const bad = validSave(d);
    if (bad) { await confirmBox(bad, true); return false; }
    stopAll();
    S = clone(d.state);
    S.vars = S.vars || {}; S.chars = S.chars || {}; S.log = Array.isArray(S.log) ? S.log : [];
    closeAllPanels();
    el.title.hidden = true;
    setInstant(true);
    hideScreenBits();
    const sc = SCENES[S.scene];
    preloadAround(S.scene);
    await renderVisuals();
    setInstant(false);
    if (sc.location) showLoc(sc);
    run();
    return true;
  }

  function fmtDate(t) {
    try { return new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(t)); } catch (e) { return new Date(t).toLocaleString(); }
  }
  let slMode = 'save';
  function openSaveLoad(mode) {
    if (mode === 'save' && !canSave()) { toast('いまはセーブできません'); return; }
    slMode = mode;
    $('#sl-title').textContent = mode === 'save' ? 'セーブ' : 'ロード';
    const ul = $('#slots'); ul.innerHTML = '';
    const ids = (mode === 'load' ? ['auto'] : []).concat(Array.from({ length: SLOT_COUNT }, (_, i) => String(i + 1)));
    for (const id of ids) {
      const d = store.get('save/' + id, null);
      const li = document.createElement('li');
      const b = document.createElement('button'); b.type = 'button'; b.className = 'slot'; b.dataset.slot = id;
      const th = document.createElement('div'); th.className = 'thumb';
      if (d && d.label && d.label.bg) th.style.backgroundImage = `url("${d.label.bg}")`;
      const meta = document.createElement('div'); meta.className = 'meta';
      const no = document.createElement('span'); no.className = 'no'; no.textContent = id === 'auto' ? 'オートセーブ' : `スロット ${id}`;
      meta.appendChild(no);
      if (d) {
        const w = document.createElement('span'); w.className = 'when'; w.textContent = `${fmtDate(d.time)}　${d.label ? d.label.scene : ''}`;
        const s = document.createElement('span'); s.className = 'snip'; s.textContent = d.label ? d.label.text : '';
        meta.append(w, s);
      } else {
        const s = document.createElement('span'); s.className = 'when'; s.textContent = '— 空き —'; meta.appendChild(s);
        if (mode === 'load') b.disabled = true;
      }
      b.append(th, meta);
      b.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        if (slMode === 'save') {
          if (d && !(await confirmBox(`スロット ${id} に上書きしますか？`))) return;
          if (store.set('save/' + id, snapshot())) { toast('セーブしました'); openSaveLoad('save'); } else toast('保存に失敗しました（容量不足など）');
        } else {
          if (!d) return;
          if (S && waiting && !(await confirmBox('このデータをロードしますか？\n進行中の内容は失われます。'))) return;
          loadSave(store.get('save/' + id, null));
        }
      });
      li.appendChild(b); ul.appendChild(li);
    }
    showPanel('p-saveload');
  }

  /* ---------- log ---------- */
  function openLog() {
    const ol = $('#log-list'); ol.innerHTML = '';
    for (const e of S.log) {
      const li = document.createElement('li');
      if (e.pick) { li.className = 'pick'; li.textContent = '▶ ' + e.text; } else {
        if (e.who) { const w = document.createElement('span'); w.className = 'who'; w.textContent = e.who; li.appendChild(w); }
        li.appendChild(document.createTextNode(e.text));
      }
      ol.appendChild(li);
    }
    showPanel('p-log');
    const sc = $('#log-scroll'); sc.scrollTop = sc.scrollHeight;
  }

  /* ---------- gallery / endings ---------- */
  function openGallery() {
    const ul = $('#gal-grid'); ul.innerHTML = '';
    let n = 0;
    for (const id of CGS) {
      const li = document.createElement('li'); const b = document.createElement('button'); b.type = 'button'; b.dataset.cg = id;
      if (G.cgs[id]) { n++; b.style.backgroundImage = `url("${PATHS.cg(id)}")`; b.setAttribute('aria-label', id);
        b.addEventListener('click', (ev) => { ev.stopPropagation(); $('#viewer-img').src = PATHS.cg(id); showPanel('p-viewer', true); });
      } else { b.disabled = true; b.textContent = '？'; }
      li.appendChild(b); ul.appendChild(li);
    }
    $('#gal-count').textContent = `${n} / ${CGS.length}`;
    showPanel('p-gallery');
  }
  function openEndings() {
    const ol = $('#end-list'); ol.innerHTML = ''; let n = 0;
    for (const e of ENDINGS) {
      const got = !!G.endings[e.id]; if (got) n++;
      const li = document.createElement('li'); li.className = got ? 'got' : 'locked'; li.dataset.end = e.id;
      const t = document.createElement('span'); t.className = 'ttl'; t.textContent = got ? `「${e.title}」` : '？？？？';
      const w = document.createElement('span'); w.className = 'who'; w.textContent = e.who;
      li.append(t, w); ol.appendChild(li);
    }
    $('#end-count').textContent = `${n} / ${ENDINGS.length}`;
    showPanel('p-endings');
  }

  /* ---------- settings ---------- */
  let previewRAF = 0;
  function openSettings() {
    const sp = $('#speed'), aw = $('#autowait');
    sp.value = G.settings.speed; aw.value = G.settings.autowait;
    updateSettingsLabels();
    showPanel('p-settings');
    previewSpeed();
  }
  function updateSettingsLabels() {
    $('#speed-out').textContent = G.settings.speed >= 10 ? '瞬間' : String(G.settings.speed);
    $('#auto-out').textContent = String(G.settings.autowait);
  }
  function previewSpeed() {
    cancelAnimationFrame(previewRAF);
    const txt = Array.from('夜の街は、まだ眠らない。隣の席に、灯りがひとつ。'); const pv = $('#speed-preview');
    const sp = cps(); if (sp === Infinity) { pv.textContent = txt.join(''); return; }
    const t0 = performance.now();
    const step = (now) => { const n = Math.min(txt.length, Math.floor((now - t0) / 1000 * sp) + 1); pv.textContent = txt.slice(0, n).join(''); if (n < txt.length && openPanel === 'p-settings') previewRAF = requestAnimationFrame(step); };
    previewRAF = requestAnimationFrame(step);
  }

  /* ---------- panels ---------- */
  const panelStack = [];
  function showPanel(id, stack) {
    if (!stack) closeAllPanels(true);
    $('#' + id).hidden = false; panelStack.push(id); openPanel = id;
    clearTimeout(autoTimer);
  }
  function hidePanel() {
    const id = panelStack.pop(); if (id) $('#' + id).hidden = true;
    openPanel = panelStack[panelStack.length - 1] || null;
    if (!openPanel && autoOn && waiting === 'text' && line && !line.typing) scheduleAuto();
  }
  function closeAllPanels(keepName) {
    while (panelStack.length) { const id = panelStack.pop(); if (keepName && id === 'p-name' && waiting === 'input') { panelStack.unshift(id); break; } $('#' + id).hidden = true; }
    openPanel = panelStack[panelStack.length - 1] || null;
  }

  let confirmResolve = null;
  function confirmBox(msg, alertOnly) {
    return new Promise((res) => {
      $('#confirm-msg').textContent = msg;
      $('#confirm-no').hidden = !!alertOnly;
      $('#confirm-yes').textContent = alertOnly ? 'OK' : 'はい';
      $('#p-confirm').hidden = false; confirmResolve = res;
    });
  }
  function confirmDone(v) { $('#p-confirm').hidden = true; const r = confirmResolve; confirmResolve = null; if (r) r(v); }

  let toastTimer = 0;
  function toast(msg) { el.toast.textContent = msg; el.toast.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.toast.hidden = true; }, 1400); }

  function setUiHidden(on) {
    uiHidden = !!on; el.box.classList.toggle('hidden-ui', uiHidden); el.choices.style.visibility = uiHidden ? 'hidden' : '';
    $('#modes').style.visibility = uiHidden ? 'hidden' : '';
    stage.dataset.uihidden = uiHidden ? '1' : '0';
    clearTimeout(autoTimer);
    if (!uiHidden && autoOn && waiting === 'text' && line && !line.typing) scheduleAuto();
  }

  /* ---------- flow control ---------- */
  function stopAll() {
    runToken++;
    cancelAnimationFrame(typeRAF); clearTimeout(autoTimer); clearTimeout(skipTimer);
    setSkip(false); setAuto(false); setUiHidden(false);
    waiting = null; line = null; nameCmd = null;
    delete stage.dataset.ending;
  }
  function hideScreenBits() { el.box.hidden = true; el.choices.hidden = true; el.loc.classList.remove('on'); el.loc.hidden = true; }
  function clearStage() {
    for (const w of charEls.values()) w.remove(); charEls.clear();
    el.chars.innerHTML = '';
    bgLayer.set(null); cgLayer.set(null);
    stage.dataset.bg = ''; stage.dataset.cg = ''; stage.dataset.line = '';
  }
  function toTitle() {
    stopAll(); closeAllPanels(); hideScreenBits(); clearStage(); S = null;
    $('#btn-continue').disabled = !store.get('save/auto', null);
    el.title.hidden = false;
    stage.dataset.screen = 'title';
  }
  async function newGame() {
    stopAll(); closeAllPanels(); clearStage();
    S = freshState();
    el.title.hidden = true; stage.dataset.screen = 'game';
    setInstant(false);
    enterScene(DATA.start || DATA.meta.start);
    run();
  }

  function fatal(msg) {
    stopAll();
    el.boot.hidden = false;
    el.boot.textContent = 'エラーが発生しました：' + msg;
  }

  /* ---------- input wiring ---------- */
  stage.addEventListener('click', (ev) => {
    if (ev.target.closest('button, input, .panel, .screen')) return;
    if (uiHidden) { setUiHidden(false); return; }
    if (skipOn) { setSkip(false); return; }
    if (autoOn) { setAuto(false); return; }
    advance(false);
  });
  $('#p-ending').addEventListener('click', (ev) => { ev.stopPropagation(); if (waiting === 'ending') toTitle(); });
  $('#p-viewer').addEventListener('click', (ev) => { ev.stopPropagation(); hidePanel(); });
  document.addEventListener('keydown', (ev) => {
    if (ev.target && ev.target.id === 'name-input') { if (ev.key === 'Enter' && !ev.isComposing) { ev.preventDefault(); submitName(); } return; }
    if (!$('#p-confirm').hidden) { if (ev.key === 'Escape') confirmDone(false); if (ev.key === 'Enter') confirmDone(true); return; }
    if (ev.key === 'Escape' && openPanel && openPanel !== 'p-name' && openPanel !== 'p-ending') { hidePanel(); return; }
    if ((ev.key === 'Enter' || ev.key === ' ') && !openPanel && S) { ev.preventDefault(); if (uiHidden) setUiHidden(false); else advance(false); }
    else if ((ev.key === 'Enter' || ev.key === ' ') && openPanel === 'p-ending') { ev.preventDefault(); toTitle(); }
  });
  $('#name-ok').addEventListener('click', (ev) => { ev.stopPropagation(); submitName(); });
  $('#confirm-yes').addEventListener('click', (ev) => { ev.stopPropagation(); confirmDone(true); });
  $('#confirm-no').addEventListener('click', (ev) => { ev.stopPropagation(); confirmDone(false); });
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', (ev) => { ev.stopPropagation(); hidePanel(); }));
  $('#speed').addEventListener('input', (e) => { G.settings.speed = +e.target.value; saveGlobal(); updateSettingsLabels(); previewSpeed(); });
  $('#autowait').addEventListener('input', (e) => { G.settings.autowait = +e.target.value; saveGlobal(); updateSettingsLabels(); });

  async function act(a) {
    switch (a) {
      case 'new':
        newGame(); break;
      case 'continue': { const d = store.get('save/auto', null); if (d) loadSave(d); break; }
      case 'load': openSaveLoad('load'); break;
      case 'save': openSaveLoad('save'); break;
      case 'log': if (S) openLog(); break;
      case 'gallery': openGallery(); break;
      case 'endings': openEndings(); break;
      case 'settings': openSettings(); break;
      case 'menu': showPanel('p-menu'); break;
      case 'auto': if (waiting === 'text' || waiting === 'choice') setAuto(!autoOn); break;
      case 'skip': if (waiting === 'text') setSkip(!skipOn); else toast('いまはスキップできません'); break;
      case 'hide': if (S && (waiting === 'text' || waiting === 'choice')) setUiHidden(true); break;
      case 'totitle':
        if (await confirmBox('タイトルへ戻りますか？\nセーブしていない進行は、オートセーブから再開できます。')) toTitle();
        break;
      default: break;
    }
  }
  document.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', (ev) => { ev.stopPropagation(); act(b.dataset.act); }));

  /* ---------- layout ---------- */
  function layout() {
    const sw = stage.clientWidth, sh = stage.clientHeight;
    const fs = Math.max(15, Math.min(22, sw * 0.045));
    stage.style.setProperty('--fs', fs.toFixed(2) + 'px');
    stage.style.setProperty('--tb-fs', Math.max(10, Math.min(12.5, sw * 0.032)).toFixed(2) + 'px');
    const wasHidden = el.box.hidden; if (wasHidden) { el.box.style.visibility = 'hidden'; el.box.hidden = false; }
    const boxH = el.box.offsetHeight; const boxTop = sh - el.box.offsetTop;
    if (wasHidden) { el.box.hidden = true; el.box.style.visibility = ''; }
    const bottom = Math.max(0, boxTop - boxH * 0.28);
    const avail = sh - bottom - sh * 0.035;
    const stH = Math.min(sw * 1152 / 864, avail);
    stage.style.setProperty('--st-h', stH.toFixed(1) + 'px');
    stage.style.setProperty('--st-w', (stH * 864 / 1152).toFixed(1) + 'px');
    stage.style.setProperty('--st-bottom', bottom.toFixed(1) + 'px');
    stage.style.setProperty('--choice-bottom', (boxTop + 8).toFixed(1) + 'px');
    if (waiting === 'text' && line) {
      const full = line.pages.join(''); const pages = paginate(full);
      const before = line.pages.slice(0, line.page).join('').length;
      let acc = 0, p = 0; for (; p < pages.length - 1; p++) { if (acc + pages[p].length > before) break; acc += pages[p].length; }
      line.pages = pages; line.page = p; completeTyping();
    }
  }
  let rzT = 0;
  window.addEventListener('resize', () => { clearTimeout(rzT); rzT = setTimeout(layout, 80); });
  window.addEventListener('orientationchange', () => setTimeout(layout, 250));
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('touchmove', (e) => { if (!e.target.closest('.scroll')) e.preventDefault(); }, { passive: false });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { clearTimeout(autoTimer); if (skipOn) setSkip(false); } else if (autoOn && waiting === 'text' && line && !line.typing) scheduleAuto(); });

  /* ---------- boot ---------- */
  async function boot() {
    let text;
    try {
      const r = await fetch(PATHS.script, { cache: 'no-cache' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      text = await r.text();
      DATA = JSON.parse(text);
    } catch (e) {
      console.error(e);
      el.boot.textContent = location.protocol === 'file:'
        ? 'ファイルを直接開くと動きません。renai-game フォルダでローカルサーバーを起動して /game/ を開いてください。'
        : '台本データを読み込めませんでした。';
      return;
    }
    SCRIPT_HASH = hash(text);
    for (const s of DATA.scenes) SCENES[s.id] = s;
    CHARNAMES = DATA.characters || {};
    for (const s of DATA.scenes) for (const c of s.commands) {
      if (c.type === 'ending' && !ENDINGS.some((e) => e.id === c.id)) {
        const h = c.id.replace(/^end_/, '');
        ENDINGS.push({ id: c.id, title: c.title, who: CHARNAMES[h] ? `${CHARNAMES[h]}エンド` : 'ノーマルエンド' });
      }
      if (c.type === 'cg' && !CGS.includes(c.id)) CGS.push(c.id);
    }
    // ノーマルは最後に
    ENDINGS.sort((a, b) => (a.who === 'ノーマルエンド') - (b.who === 'ノーマルエンド'));
    document.title = DATA.meta.title || document.title;
    layout();
    toTitle();
    setInstant(false);
    el.boot.hidden = true;
    loadImg(PATHS.bg(SCENES[DATA.start || DATA.meta.start].bg || ''));
  }

  // read-only debug view for automated tests
  Object.defineProperty(window, '__VN', { value: Object.freeze({
    state: () => (S ? clone(S) : null),
    get waiting() { return waiting; },
    get typing() { return !!(line && line.typing); },
    get pages() { return line ? line.pages.slice() : null; },
    get page() { return line ? line.page : null; },
    get skip() { return skipOn; },
    get auto() { return autoOn; },
    global: () => clone(G),
  }) });

  boot();
})();
