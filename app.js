(function () {
  const API = (window.THINKNEST_API || 'http://localhost:3000/api').replace(/\/$/, '');
  const MONEY = '₦4,999';
  let token = localStorage.getItem('tn_token'), me = null, hist = [], cur = null;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const main = (h) => { $('#tn-main').innerHTML = h; };
  const bar = (n, v) => `<div class=tn-bar><span>${esc(n)}</span><i><b style="width:${v}%"></b></i><em>${v}%</em></div>`;
  const stat = ([i, v, l]) => `<div class=tn-card><div class=tn-big>${i} ${esc(v)}</div>${l}</div>`;
  const TABS = {
    student: [['home', '🏠 Home'], ['learn', '📚 Learn'], ['tutor', '🤖 Tutor'], ['brain', '🧠 Brain'], ['path', '🎯 My Path']],
    parent: [['kids', '👨‍👩‍👧 My Children']], teacher: [['studio', '🧑‍🏫 Studio']], admin: [['admin', '🛠 Admin']],
  };
  // the header buttons may be missing on an older index.html, so never assume they exist
  const nav = (cta, login) => { const c = $('.nav-cta'), l = $('.nav-login-m'); if (c) c.textContent = cta; if (l) l.textContent = login; };
  let toastT;
  function toast(m) { const t = $('#tn-toast'); t.textContent = m; t.style.display = 'block'; clearTimeout(toastT); toastT = setTimeout(() => (t.style.display = 'none'), 3500); }
  async function api(p, method = 'GET', body) {
    const r = await fetch(API + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { if (r.status === 401 && token) TN.logout(); throw Object.assign(new Error(d.error || 'Something went wrong'), { status: r.status }); }
    return d;
  }
  const upsell = () => main(`<div class="tn-card tn-up">🔒 This is a Premium feature. <button class="tn-btn alt" onclick="TN.pay(${me.id})">Unlock for ${MONEY}/month</button></div>`);
  const pin = (id) => $(id).value;

  const TN = {
    // ── auth & shell
    auth(mode = 'login') {
      const reg = mode === 'register';
      $('#tn-auth').innerHTML = `<div class=tn-box><button class=tn-x onclick="TN.close()">✕</button><h3>${reg ? 'Create your account' : 'Welcome back'}</h3>
        ${reg ? `<input class=tn-in id=an placeholder="Full name"><select class=tn-in id=ar><option value=student>I'm a student</option><option value=parent>I'm a parent</option><option value=teacher>I'm a teacher</option></select><input class=tn-in id=aa type=number placeholder="Age (students)"><input class=tn-in id=ac placeholder="Class (e.g. Primary 5, JSS2)">` : ''}
        <input class=tn-in id=ae type=email placeholder=Email><input class=tn-in id=ap type=password placeholder="Password (8+ characters)">
        <button class=tn-btn style="width:100%" onclick="TN.submitAuth('${mode}')">${reg ? 'Sign up free' : 'Log in'}</button>
        <p class=tn-sw>${reg ? `Have an account? <a href=# onclick="TN.auth('login');return false">Log in</a>` : `New here? <a href=# onclick="TN.auth('register');return false">Sign up</a>`}</p></div>`;
      $('#tn-auth').classList.add('on');
    },
    close() { $('#tn-auth').classList.remove('on'); },
    async submitAuth(mode) {
      const body = { email: pin('#ae'), password: pin('#ap') };
      if (mode === 'register') Object.assign(body, { name: pin('#an'), role: pin('#ar'), age: pin('#aa'), class_level: pin('#ac') });
      const r = await api('/auth/' + mode, 'POST', body);
      token = r.token; me = r.user; localStorage.setItem('tn_token', token);
      TN.close(); TN.open();
    },
    logout() { token = null; me = null; localStorage.removeItem('tn_token'); $('#tn-app').style.display = 'none'; document.body.style.overflow = ''; nav('Get Started', 'Log in'); toast('Logged out'); },
    cta() { me ? TN.open() : TN.auth('register'); },
    loginBtn() { me ? TN.open() : TN.auth('login'); },
    header() { $('#tn-who').innerHTML = `${esc(me.name)} · ⭐ ${me.points} · Lv ${me.level} · 🔥 ${me.streak}`; },
    async refresh() { me = await api('/me'); TN.header(); },
    open() {
      $('#tn-app').style.display = 'block'; document.body.style.overflow = 'hidden'; nav('My Dashboard', 'Dashboard');
      const tabs = TABS[me.role];
      $('#tn-tabs').innerHTML = tabs.map(([k, l]) => `<button id=tab-${k} onclick="TN.go('${k}')">${l}</button>`).join('');
      TN.header(); TN.go(tabs[0][0]);
    },
    hide() { $('#tn-app').style.display = 'none'; document.body.style.overflow = ''; },
    async go(t) {
      window.tnDiagnostic = null;
      document.querySelectorAll('#tn-tabs button').forEach((b) => b.classList.toggle('on', b.id === 'tab-' + t));
      main('<p>Loading…</p>'); await TN['v_' + t]();
    },

    // ── payments (server creates + verifies the Paystack transaction)
    async pay(studentId) { toast('Opening Paystack…'); const r = await api('/payments/initialize', 'POST', { student_id: studentId }); location.href = r.authorization_url; },
    premium() {
      if (!me) return TN.auth('register');
      if (me.role === 'student') return TN.pay(me.id);
      if (me.role === 'parent') { TN.open(); return toast('Choose a child to upgrade'); }
      toast('Premium is for student accounts');
    },

    // ── student
    async v_home() {
      const p = await api('/progress'), u = p.user;
      main(`<div class=tn-grid>${[['⭐', u.points, 'Points'], ['🏅', 'Lv ' + u.level, 'Level'], ['🔥', u.streak, 'Day streak'], ['📖', p.lessons_completed, 'Lessons']].map(stat).join('')}</div>
        ${u.plan === 'free' ? `<div class="tn-card tn-up"><span>Free plan: 5 tutor chats a day.</span><button class="tn-btn alt" onclick="TN.pay(${u.id})">Go Premium ${MONEY}</button></div>` : `<div class=tn-card>${u.all_free ? '🎓 All features are unlocked for you' : '✅ Premium until ' + new Date(u.plan_expires).toLocaleDateString()}</div>`}
        <h4>Subject accuracy</h4>${p.subjects.map((s) => bar(s.subject, s.accuracy)).join('') || '<p>Take a quiz to see your strengths.</p>'}
        <p>Badges: ${p.badges.map((b) => '🏆 ' + esc(b)).join(' · ') || 'none yet'}</p><button class=tn-btn onclick="TN.diag()">Take the diagnostic test</button>`);
    },
    async diag() {
      const q = await api('/quizzes?diagnostic=1');
      if (!q.length) return toast('No diagnostic tests published yet');
      const ordered = ['English', 'Mathematics', 'Basic Science', 'Social Studies'].map((n) => q.find((x) => x.title.toLowerCase().includes(n.toLowerCase())));
      if (ordered.some((x) => !x)) return toast('Four diagnostic quizzes must be published first.');
      TN.startDiagnostic(ordered);
    },
    async v_learn() {
      const s = await api('/subjects');
      main(`<h4>Choose a subject</h4><div class=tn-chips>${s.map((x) => `<button class="tn-btn ghost" onclick="TN.subj(${x.id})">${esc(x.name)}</button>`).join('')}</div><div id=sub></div>`);
    },
    async subj(id) {
      const [l, q] = await Promise.all([api('/lessons?subject_id=' + id), api('/quizzes?subject_id=' + id)]);
      $('#sub').innerHTML = `<h4>Lessons</h4>${l.map((x) => `<div class=tn-card onclick="TN.lesson(${x.id})">📄 ${esc(x.title)} <small>${esc(x.class_level)}</small>${x.premium ? ' 🔒' : ''}</div>`).join('') || '<p>No lessons yet.</p>'}
        <h4>Quizzes</h4>${q.map((x) => `<div class=tn-card onclick="TN.quiz(${x.id})">📝 ${esc(x.title)}</div>`).join('') || '<p>No quizzes yet.</p>'}`;
    },
    async lesson(id) {
      try {
        const l = await api('/lessons/' + id);
        main(`<button class="tn-btn ghost" onclick="TN.go('learn')">← Back</button><h3>${esc(l.title)}</h3><div class=tn-body>${esc(l.body).replace(/\n/g, '<br>')}</div><button class=tn-btn onclick="TN.done(${id})">✅ I finished this lesson</button>`);
      } catch (e) { e.status === 402 ? upsell() : toast(e.message); }
    },
    async done(id) { const r = await api(`/lessons/${id}/complete`, 'POST'); toast(r.points_awarded ? `+${r.points_awarded} points! 🎉` : 'Already completed'); await TN.refresh(); TN.go('learn'); },
    async startDiagnostic(ordered) {
      window.tnDiagnostic = { quizzes: ordered, index: 0, results: [] };
      await TN.quiz(ordered[0].id);
    },
    async quiz(id) {
      const q = await api('/quizzes/' + id); cur = q;
      const d = window.tnDiagnostic;
      const heading = d ? `<h3>Diagnostic Assessment — Subject ${d.index + 1} of ${d.quizzes.length}</h3><h4>${esc(q.title)}</h4>` : `<h3>${esc(q.title)}</h3>`;
      main(`${heading}${q.questions.map((x, i) => `<div class=tn-card><b>${i + 1}. ${esc(x.prompt)}</b><br>${x.options ? x.options.map((o) => `<label><input type=radio name=q${x.id} value="${esc(o)}"> ${esc(o)}</label><br>`).join('') : `<input class=tn-in name=q${x.id} placeholder="Your answer">`}</div>`).join('')}<button class=tn-btn onclick="TN.submit(${id})">Submit</button>`);
    },
    async submit(id) {
      const a = {};
      cur.questions.forEach((x) => { const e = document.querySelector(`[name=q${x.id}]:checked`) || document.querySelector(`input.tn-in[name=q${x.id}]`); a[x.id] = e ? e.value : ''; });
      const r = await api(`/quizzes/${id}/submit`, 'POST', { answers: a });
      const d = window.tnDiagnostic;
      if (d) {
        d.results.push({ title: cur.title, score: r.score, total: r.total });
        d.index++;
        if (d.index < d.quizzes.length) return TN.quiz(d.quizzes[d.index].id);
        const ts = d.results.reduce((s, x) => s + x.score, 0), tq = d.results.reduce((s, x) => s + x.total, 0);
        main(`<h3>Diagnostic Assessment Complete!</h3><h2>${ts}/${tq}</h2><p>Your overall diagnostic score</p>${d.results.map((x) => `<div class=tn-card><b>${esc(x.title)}</b><br>${x.score}/${x.total}</div>`).join('')}<button class=tn-btn onclick="TN.go('learn')">Back to learning</button>`);
        window.tnDiagnostic = null; TN.refresh(); return;
      }
      main(`<h3>You got ${r.score}/${r.total} 🎉</h3><p>+${r.points_awarded} points</p>${r.results.map((x, i) => `<div class=tn-card>${x.correct ? '✅' : '❌'} Question ${i + 1}${x.correct ? '' : ' — answer: ' + esc(x.correct_answer)}</div>`).join('')}<button class=tn-btn onclick="TN.go('learn')">Back to learning</button>`);
      TN.refresh();
    },
    v_tutor() {
      hist = [];
      main(`<div id=chat class=tn-chat><div class=tn-msg>Hi ${esc(me.name)}! What are we learning today? 😊</div></div><div class=tn-row><input id=ci class=tn-in placeholder="Ask me anything…" onkeydown="event.key==='Enter'&&TN.send()"><button class=tn-btn onclick="TN.send()">Send</button></div>`);
    },
    async send() {
      const i = $('#ci'), m = i.value.trim(), c = $('#chat'); if (!m) return; i.value = '';
      c.insertAdjacentHTML('beforeend', `<div class="tn-msg me">${esc(m)}</div>`);
      try {
        const r = await api('/tutor', 'POST', { message: m, history: hist });
        hist.push({ role: 'user', content: m }, { role: 'assistant', content: r.reply });
        c.insertAdjacentHTML('beforeend', `<div class=tn-msg>${esc(r.reply).replace(/\n/g, '<br>')}</div>`);
      } catch (e) { c.insertAdjacentHTML('beforeend', `<div class=tn-msg>⚠️ ${esc(e.message)}</div>`); }
      c.scrollTop = c.scrollHeight;
    },
    async v_brain() {
      const b = await api('/brain/today'); cur = b;
      main(`<h3>Daily Brain Training 🧠</h3>${b.done ? '<p>✅ Done today — points are awarded once a day. Come back tomorrow!</p>' : ''}${b.exercises.map((x) => `<div class=tn-card><b>${esc(x.prompt)}</b>${x.show ? `<div class=tn-big>${esc(x.show)}</div>` : ''}<input class=tn-in name=b${x.id} placeholder=Answer></div>`).join('')}<button class=tn-btn onclick="TN.bsub()">Check answers</button>`);
      setTimeout(() => document.querySelectorAll('.tn-big').forEach((e) => (e.textContent = '• • • • •')), 5000);
    },
    async bsub() {
      const a = {}; cur.exercises.forEach((x) => (a[x.id] = document.querySelector(`input[name=b${x.id}]`).value));
      const r = await api('/brain/submit', 'POST', { answers: a }); toast(`${r.correct}/${r.total} correct · +${r.points_awarded} points`); await TN.refresh();
    },
    async v_path() {
      try {
        const p = await api('/path');
        main(`<h3>Your learning path 🎯</h3>${p.map((x) => `<div class=tn-card onclick="TN.lesson(${x.id})">📄 ${esc(x.title)} <small>${x.focus === 'weak area' ? '⚠️ focus area' : 'keep growing'}</small></div>`).join('') || '<p>Great job — nothing left to do! Check back soon.</p>'}`);
      } catch (e) { e.status === 402 ? upsell() : toast(e.message); }
    },

    // ── parent
    async v_kids() {
      const k = await api('/children');
      main(`<h3>My Children</h3>${k.map((c) => `<div class=tn-card><b>${esc(c.name)}</b> · ${esc(c.class_level || '')} · ${c.all_free ? '🎓 Full access' : c.plan === 'premium' ? '⭐ Premium' : 'Free'}<br><small>${c.points} pts · Lv ${c.level} · ${c.streak} 🔥</small><br>
        <button class="tn-btn ghost" onclick="TN.kid(${c.id})">View progress</button> ${c.plan === 'premium' ? '' : `<button class="tn-btn alt" onclick="TN.pay(${c.id})">Upgrade ${MONEY}</button>`}<div id=k${c.id}></div></div>`).join('') || '<p>No children yet.</p>'}
        <h4>Add a child</h4><input class=tn-in id=kn placeholder="Child's name"><input class=tn-in id=ke type=email placeholder="Child's login email"><input class=tn-in id=kp type=password placeholder="Password (8+ characters)"><input class=tn-in id=ka type=number placeholder=Age><input class=tn-in id=kc placeholder="Class (e.g. JSS1)"><button class=tn-btn onclick="TN.addKid()">Add child</button>`);
    },
    async addKid() { await api('/children', 'POST', { name: pin('#kn'), email: pin('#ke'), password: pin('#kp'), age: pin('#ka'), class_level: pin('#kc') }); toast('Child added'); TN.go('kids'); },
    async kid(id) {
      const p = await api(`/children/${id}/progress`);
      $('#k' + id).innerHTML = `<p>Lessons completed: ${p.lessons_completed}</p>${p.subjects.map((s) => bar(s.subject, s.accuracy)).join('') || '<p>No quizzes yet.</p>'}<p>Strengths: ${esc(p.strengths.join(', ') || '—')}<br>Needs work: ${esc(p.weaknesses.join(', ') || '—')}</p>`;
    },

    // ── teacher
    async v_studio() {
      const [s, l] = await Promise.all([api('/subjects'), api('/lessons?mine=1')]);
      const o = s.map((x) => `<option value=${x.id}>${esc(x.name)}</option>`).join('');
      main(`<h3>Teacher Studio</h3>
        <div class=tn-card><b>New subject</b><input class=tn-in id=sn placeholder="e.g. Computer Studies"><button class=tn-btn onclick="TN.addSubj()">Add subject</button></div>
        <div class=tn-card><b>New lesson</b><select class=tn-in id=ls>${o}</select><input class=tn-in id=lc placeholder="Class (e.g. JSS1)"><input class=tn-in id=lt placeholder=Title><textarea class=tn-in id=lb rows=6 placeholder="Lesson notes…"></textarea><label><input type=checkbox id=lp> Premium content</label><br><button class=tn-btn onclick="TN.addLesson()">Submit for review</button></div>
        <div class=tn-card><b>New quiz</b><select class=tn-in id=qs>${o}</select><input class=tn-in id=qc placeholder=Class><input class=tn-in id=qt placeholder="Quiz title"><label><input type=checkbox id=qd> Diagnostic assessment</label><br><textarea class=tn-in id=qq rows=6 placeholder="One question per line:&#10;Question | option A; option B | correct answer&#10;Short answer: Question | correct answer"></textarea><button class=tn-btn onclick="TN.addQuiz()">Submit for review</button></div>
        <h4>My lessons</h4>${l.map((x) => `<div class=tn-card>${esc(x.title)} <small>${esc(x.status)}</small></div>`).join('') || '<p>None yet.</p>'}`);
    },
    async addSubj() { await api('/subjects', 'POST', { name: pin('#sn') }); toast('Subject added'); TN.go('studio'); },
    async addLesson() {
      const r = await api('/lessons', 'POST', { subject_id: +pin('#ls'), class_level: pin('#lc'), title: pin('#lt'), body: pin('#lb'), premium: $('#lp').checked });
      toast('Lesson ' + r.status); TN.go('studio');
    },
    async addQuiz() {
      const questions = pin('#qq').split('\n').map((x) => x.trim()).filter(Boolean).map((x) => {
        const p = x.split('|').map((s) => s.trim()), [prompt, o, a] = p.length === 2 ? [p[0], '', p[1]] : p;
        const options = (o || '').split(';').map((s) => s.trim()).filter(Boolean);
        return options.length ? { type: 'multiple_choice', prompt, options, answer: a } : { type: 'short_answer', prompt, answer: a };
      });
      const r = await api('/quizzes', 'POST', { subject_id: +pin('#qs'), class_level: pin('#qc'), title: pin('#qt'), questions, is_diagnostic: $('#qd').checked });
      toast('Quiz ' + r.status); TN.go('studio');
    },

    // ── admin
    async v_admin() {
      const [s, p, u] = await Promise.all([api('/admin/stats'), api('/admin/pending'), api('/admin/users')]);
      const pend = [...p.lessons.map((x) => ['lessons', x]), ...p.quizzes.map((x) => ['quizzes', x])];
      main(`<h3>Admin</h3><div class=tn-grid>${[['👥', u.length, 'Users'], ['⭐', s.premium_users, 'Premium'], ['💰', '₦' + s.revenue_ngn.toLocaleString(), 'Revenue'], ['🤖', s.tutor_chats_today, 'Tutor chats today']].map(stat).join('')}</div>
        <h4>Pending review</h4>${pend.map(([t, x]) => `<div class=tn-card>${t === 'lessons' ? '📄' : '📝'} ${esc(x.title)} <small>${esc(x.class_level)}</small> <button class=tn-btn onclick="TN.review('${t}',${x.id},true)">Approve</button> <button class="tn-btn ghost" onclick="TN.review('${t}',${x.id},false)">Reject</button></div>`).join('') || '<p>Nothing pending 🎉</p>'}
        <h4>Users</h4>${u.slice(0, 50).map((x) => `<div class=tn-card>${esc(x.name)} · ${x.role} · ${x.plan}</div>`).join('')}`);
    },
    async review(t, id, ok) { await api(`/admin/review/${t}/${id}`, 'POST', { approve: ok }); toast(ok ? 'Approved' : 'Rejected'); TN.go('admin'); },
  };
  // every handler gets one shared error toast instead of repeating try/catch
  Object.keys(TN).forEach((k) => { const f = TN[k]; TN[k] = (...a) => { try { const r = f(...a); return r && r.catch ? r.catch((e) => toast(e.message)) : r; } catch (e) { toast(e.message); } }; });
  window.TN = TN;

  document.body.insertAdjacentHTML('beforeend', `<div class=tn-modal id=tn-auth></div><div id=tn-toast></div>
    <div id=tn-app><div class=tn-head><b>🪺 ThinkNest</b><span id=tn-who></span><span><button class="tn-btn alt" onclick="TN.hide()">Home site</button> <button class="tn-btn ghost" onclick="TN.logout()">Log out</button></span></div><div class=tn-tabs id=tn-tabs></div><div id=tn-main></div></div>`);
  $('#tn-auth').addEventListener('click', (e) => { if (e.target.id === 'tn-auth') TN.close(); });

  // all-free version: hide the pricing section and its menu link
  fetch(API + '/config').then((r) => r.json()).then((c) => {
    if (!c.all_free) return;
    const p = document.querySelector('#pricing'); if (p) p.remove();
    document.querySelectorAll('a[href="#pricing"]').forEach((l) => (l.closest('li') || l).remove());
  }).catch(() => {});

  (async () => {
    if (!token) return;
    try {
      me = await api('/me');
      const ref = new URLSearchParams(location.search).get('reference');   // Paystack returns here with ?reference=
      if (ref) { const r = await api('/payments/verify/' + encodeURIComponent(ref)); history.replaceState({}, '', location.pathname); toast(r.success ? '🎉 Premium activated!' : 'Payment not confirmed yet'); me = await api('/me'); }
      TN.open();
    } catch (e) { /* not logged in or API offline */ }
  })();
})();
