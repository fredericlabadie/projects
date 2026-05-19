// SMM Question Rewriter — vanilla JS, dedicated SMM API backed rewrite tool
// Renders into a target container. Uses window.SMM_GAPS and window.SMM_REWRITES from smm-data.js.
// The gap labels are course practitioner labels, not a canonical Dervin taxonomy.

(function() {
  'use strict';

  const API_BASE = 'https://smm-api.fredericlabadie.com';
  const REWRITE_URL = API_BASE + '/api/rewrite';
  const FEEDBACK_URL = API_BASE + '/api/feedback';

  const GAPS_BY_ID = {};
  (window.SMM_GAPS || []).forEach(g => { GAPS_BY_ID[g.id] = g; });

  function classifyGap(text) {
    const t = (text || '').toLowerCase();
    // Note: 'or\b' was removed \u2014 it matched "for" in nearly every sentence.
    if (/choose|decide|which|pick|option|between|vs\./.test(t)) return 'decision';
    if (/can\u2019?t|cannot|blocked|stuck|access|locked|won\u2019?t let/.test(t)) return 'barrier';
    if (/role|supposed to|expected|how do i|new here|onboard/.test(t)) return 'role';
    if (/lost|no idea|where to start|overwhelm|disorient/.test(t)) return 'spinout';
    if (/clear|helpful|useful|inform|recommend|likely|nps|satisfy/.test(t)) return 'washout';
    if (/wrong|off|something|weird|odd/.test(t)) return 'problematic';
    return 'washout';
  }

  function findLocalRewrite(input) {
    const t = (input || '').trim().toLowerCase();
    if (!t) return null;
    const samples = window.SMM_REWRITES || [];
    const match = samples.find(s => {
      const o = s.original.toLowerCase();
      const tokens = o.replace(/[^a-z\s]/g, '').split(/\s+/).filter(w => w.length > 4);
      if (tokens.length < 3) return false;
      const hits = tokens.filter(w => t.includes(w)).length;
      // Require 75% of qualifying tokens to match AND at least 3 hits.
      // The old 40% threshold caused false positives (e.g. "recommend" + "friend"
      // in an unrelated question matching the NPS example).
      return hits >= Math.max(3, Math.ceil(tokens.length * 0.75));
    });
    return match || null;
  }

  function buildFallbackRewrite(input) {
    const gapId = classifyGap(input);
    const gap = GAPS_BY_ID[gapId] || { label: gapId };
    return {
      id: 'synth',
      domain: 'Offline heuristic rewrite',
      source: 'offline_heuristic',
      original: input.trim(),
      diagnosis: [
        'Asks for an evaluation rather than situating a moment.',
        'Reads as a possible ' + gap.label.toLowerCase() + '-oriented practitioner gap picture — but the stop is not surfaced in the participant\u2019s own terms, so the data may not resolve cleanly.',
        'Does not invite both helps and hurts.',
      ],
      rewrite: 'Walk me through a specific moment when this came up for you. What were you trying to do, what did you reach for, and what got in the way?',
      gap: gapId,
      why: 'Anchors the question in a specific micro-moment, leaves room for any bridge type the user actually used, and probes for hurts as well as helps. The gap label is a practitioner prompt for analysis, not a substitute for the participant\u2019s own account of the discontinuity.',
      diff: [
        { kind: 'cut', text: input.trim() },
        { kind: 'add', text: 'Walk me through a specific moment when this came up for you.' },
        { kind: 'add', text: 'What were you trying to do, what did you reach for, and what got in the way?' },
      ],
      meta: { source: 'offline_heuristic' },
    };
  }

  function sanitizeErrorMessage(err) {
    const msg = String(err && err.message ? err.message : err || 'Unknown error');
    if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return 'network/CORS/preflight failure';
    if (/BAD_JSON|Could not parse response/i.test(msg)) return 'API returned invalid JSON';
    if (/HF_UNAUTHORIZED/i.test(msg)) return 'Hugging Face token/provider permission error';
    const status = msg.match(/Rewriter API error:\s*(\d{3})/i);
    if (status) return 'API returned HTTP ' + status[1];
    return 'API/model error';
  }

  async function callRewriteApi(question) {
    const res = await fetch(REWRITE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: question }),
    });

    let payload;
    try {
      payload = await res.json();
    } catch {
      throw new Error('BAD_JSON: Rewriter API returned non-JSON response.');
    }

    if (!res.ok || payload.ok === false) {
      const code = payload && payload.error && payload.error.code ? payload.error.code : 'API_ERROR';
      const provider = payload && payload.meta && payload.meta.provider_message ? ' — ' + payload.meta.provider_message : '';
      throw new Error('Rewriter API error: ' + res.status + ' ' + code + provider);
    }

    if (!payload.result) throw new Error('BAD_JSON: Rewriter API returned no result.');
    return {
      original: question,
      diagnosis: payload.result.diagnosis || [],
      rewrite: payload.result.rewrite || '',
      gap: payload.result.gap || 'washout',
      why: payload.result.why || '',
      diff: payload.result.diff || [{ kind: 'cut', text: question }, { kind: 'add', text: payload.result.rewrite || '' }],
      source: payload.source || 'ai',
      meta: payload.meta || {},
    };
  }

  async function submitFeedback(result, type, comment) {
    const payload = {
      type: type,
      category: type,  // mirrors type so the category index is queryable
      question: result.original || '',
      rewrite: result.rewrite || '',
      gap: result.gap || '',
      comment: comment || '',
      model: result.meta && result.meta.model ? result.meta.model : '',
      prompt_version: result.meta && result.meta.prompt_version ? result.meta.prompt_version : '',
      page: window.location.href,
      source: result.source || (result.meta && result.meta.source) || '',
    };

    const res = await fetch(FEEDBACK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      const msg = data && data.error && data.error.message ? data.error.message : 'Feedback request failed.';
      throw new Error(msg);
    }
    return data;
  }

  const EXAMPLES = [
    { label: 'Pricing clarity', text: 'Did you find the pricing information clear?' },
    { label: 'NPS', text: 'How likely are you to recommend us to a friend?' },
    { label: 'Adoption', text: 'Why don\u2019t users adopt the new export feature?' },
    { label: 'Engagement', text: 'Do you have the information you need to do your job?' },
    { label: 'Onboarding', text: 'Was the onboarding helpful?' },
  ];

  function el(tag, cls, attrs) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (attrs) Object.keys(attrs).forEach(k => {
      if (k === 'text') e.textContent = attrs[k];
      else e.setAttribute(k, attrs[k]);
    });
    return e;
  }

  window.initSMMRewriter = function(containerId) {
    const root = document.getElementById(containerId);
    if (!root) return;

    const shell = el('div', 'rewriter-shell');
    const inputWrap = el('div');
    inputWrap.style.cssText = 'display:flex;flex-direction:column;gap:8px';
    const label = el('span', 'rewriter-label', { text: '01 — Paste a research question' });
    const textarea = el('textarea', 'rewriter-textarea');
    textarea.placeholder = 'e.g. Did you find the pricing information clear?';
    textarea.rows = 3;

    const controls = el('div', 'rewriter-controls');
    const btnRun = el('button', 'btn-primary-smm', { text: 'Rewrite with SMM' });
    btnRun.disabled = true;
    const btnClear = el('button', 'btn-ghost-smm', { text: 'Clear' });
    const btnCopy = el('button', 'btn-ghost-smm', { text: 'Copy as markdown' });
    btnCopy.style.display = 'none';
    controls.append(btnRun, btnClear, btnCopy);

    const chipWrap = el('div', 'example-chips');
    const chipLabel = el('span', 'rewriter-label', { text: 'or try —' });
    chipLabel.style.fontSize = '10px';
    chipWrap.appendChild(chipLabel);
    EXAMPLES.forEach(ex => {
      const c = el('button', 'chip', { text: ex.label });
      c.onclick = () => { textarea.value = ex.text; textarea.dispatchEvent(new Event('input')); runRewrite(); };
      chipWrap.appendChild(c);
    });

    inputWrap.append(label, textarea, controls, chipWrap);

    const output = el('div', 'rewriter-output');
    output.id = 'rewriter-output';

    shell.append(inputWrap, output);
    root.appendChild(shell);

    textarea.addEventListener('input', () => { btnRun.disabled = !textarea.value.trim(); });
    textarea.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') runRewrite();
    });
    btnRun.onclick = runRewrite;
    btnClear.onclick = () => {
      textarea.value = '';
      btnRun.disabled = true;
      btnCopy.style.display = 'none';
      output.innerHTML = '';
    };

    let lastResult = null;

    async function runRewrite() {
      const q = textarea.value.trim();
      if (!q) return;
      output.innerHTML = '';
      btnCopy.style.display = 'none';
      btnRun.disabled = true;
      btnRun.textContent = 'ANALYZING…';

      let result;
      try {
        const local = findLocalRewrite(q);
        if (local) {
          result = Object.assign({}, local, { source: 'local_example', meta: { source: 'local_example' } });
        } else {
          result = await callRewriteApi(q);
        }
      } catch (err) {
        console.error('Rewriter error:', err);
        result = buildFallbackRewrite(q);
        const reason = sanitizeErrorMessage(err);
        const errHint = el('div', 'rewriter-label', { text: 'Using offline heuristic mode. Reason: ' + reason + '.' });
        errHint.style.cssText = 'color:#7c2424;font-size:10px;margin-bottom:8px';
        output.appendChild(errHint);
      }

      lastResult = result;
      btnRun.textContent = 'REWRITE WITH SMM';
      btnRun.disabled = false;
      btnCopy.style.display = 'inline-block';
      renderResult(result);
    }

    btnCopy.onclick = () => {
      if (!lastResult) return;
      const gap = GAPS_BY_ID[lastResult.gap];
      const md = [
        '# SMM Rewrite', '',
        '**Original**', '> ' + lastResult.original, '',
        '**Diagnosis**', ...lastResult.diagnosis.map(d => '- ' + d), '',
        '**Rewrite**', '> ' + lastResult.rewrite, '',
        '**Practitioner gap label:** ' + (gap ? gap.label : lastResult.gap) + (gap ? ' — ' + gap.desc : ''), '',
        '**Why this works**', lastResult.why,
      ].join('\n');
      navigator.clipboard.writeText(md).then(() => {
        btnCopy.textContent = 'Copied ✓';
        setTimeout(() => { btnCopy.textContent = 'Copy as markdown'; }, 1800);
      });
    };

    function renderFeedback(r) {
      const wrap = el('div', 'reveal-step');
      const head = el('div', 'step-head');
      head.append(el('span', 'step-n', { text: '06 · Feedback' }), el('span', 'step-title', { text: 'Help improve the tool' }));

      const note = el('p', null, { text: 'Feedback is optional. If you submit it, the original question, rewrite, label, and your comment are sent to the SMM API for review and may be stored in the feedback database. Do not include personal or sensitive information.' });
      note.style.cssText = 'font-family:var(--serif);font-size:13px;line-height:1.5;color:var(--muted);margin:0 0 10px';

      const buttons = el('div', 'rewriter-controls');
      const useful = el('button', 'btn-ghost-smm', { text: 'Useful' });
      const inaccurate = el('button', 'btn-ghost-smm', { text: 'Inaccurate' });
      const issue = el('button', 'btn-ghost-smm', { text: 'Report issue' });
      buttons.append(useful, inaccurate, issue);

      const form = el('div');
      form.style.cssText = 'display:none;flex-direction:column;gap:8px;margin-top:10px';
      const comment = el('textarea', 'rewriter-textarea');
      comment.rows = 2;
      comment.placeholder = 'What seems wrong? For example: label is wrong, rewrite is too leading, academic framing overstates Dervin, etc.';
      const submit = el('button', 'btn-primary-smm', { text: 'Submit feedback' });
      const cancel = el('button', 'btn-ghost-smm', { text: 'Cancel' });
      const formControls = el('div', 'rewriter-controls');
      formControls.append(submit, cancel);
      form.append(comment, formControls);

      const status = el('div', 'rewriter-label');
      status.style.cssText = 'font-size:10px;margin-top:8px;color:var(--muted)';

      let selectedType = null;
      function openForm(type) {
        selectedType = type;
        form.style.display = 'flex';
        comment.focus();
        status.textContent = '';
      }

      useful.onclick = async () => {
        status.textContent = 'Sending…';
        try {
          await submitFeedback(r, 'useful', '');
          status.textContent = 'Thanks — feedback recorded.';
        } catch (err) {
          status.textContent = 'Feedback could not be sent.';
        }
      };
      inaccurate.onclick = () => openForm('inaccuracy');
      issue.onclick = () => openForm('issue');
      cancel.onclick = () => { form.style.display = 'none'; comment.value = ''; selectedType = null; status.textContent = ''; };
      submit.onclick = async () => {
        status.textContent = 'Sending…';
        submit.disabled = true;
        try {
          await submitFeedback(r, selectedType || 'issue', comment.value);
          status.textContent = 'Thanks — feedback recorded.';
          form.style.display = 'none';
          comment.value = '';
        } catch (err) {
          status.textContent = 'Feedback could not be sent.';
        } finally {
          submit.disabled = false;
        }
      };

      wrap.append(head, note, buttons, form, status);
      output.appendChild(wrap);
    }

    function renderResult(r) {
      const gap = GAPS_BY_ID[r.gap];
      const gapColor = gap ? gap.color : '#666';

      const s1 = el('div', 'reveal-step');
      const s1h = el('div', 'step-head');
      s1h.append(el('span', 'step-n', { text: '02 · Diagnosis' }), el('span', 'step-title', { text: 'What\u2019s wrong with the question' }));
      const s1list = el('ul', 'diag-list');
      (r.diagnosis || []).forEach(d => { const li = el('li', null, { text: d }); s1list.appendChild(li); });
      s1.append(s1h, s1list);
      output.appendChild(s1);

      const s2 = el('div', 'reveal-step');
      const s2h = el('div', 'step-head');
      s2h.append(el('span', 'step-n', { text: '03 · Transformation' }), el('span', 'step-title', { text: 'Old → new' }));
      const diffBlock = el('div', 'diff-block');
      (r.diff || []).forEach(d => {
        const line = el('div', 'diff-line ' + (d.kind === 'cut' ? 'diff-cut' : 'diff-add'));
        line.append(el('span', 'diff-mark', { text: d.kind === 'cut' ? '–' : '+' }), el('span', null, { text: d.text }));
        diffBlock.appendChild(line);
      });
      s2.append(s2h, diffBlock);
      output.appendChild(s2);

      const s3 = el('div', 'reveal-step');
      const s3h = el('div', 'step-head');
      s3h.append(el('span', 'step-n', { text: '04 · Rewrite' }), el('span', 'step-title', { text: 'SMM-neutral framing' }));
      const rBox = el('div', 'rewrite-box', { text: '\u201C' + r.rewrite + '\u201D' });
      const gapMeta = el('div', 'gap-meta');
      const gapLabel = el('span', 'rewriter-label', { text: 'Practitioner label →' });
      gapLabel.style.fontSize = '10px';
      const gapTag = el('span', 'gap-tag');
      gapTag.style.color = gapColor;
      const dot = el('span', 'dot');
      dot.style.background = gapColor;
      gapTag.append(dot, document.createTextNode(' ' + (gap ? gap.label : r.gap)));
      const gapDesc = el('span', 'gap-desc', { text: gap ? gap.desc : '' });
      const gapCaveat = el('span', 'gap-desc', { text: 'Tentative analytic prompt; return to the participant\u2019s own words before coding.' });
      gapMeta.append(gapLabel, gapTag, gapDesc, gapCaveat);
      s3.append(s3h, rBox, gapMeta);
      output.appendChild(s3);

      const s4 = el('div', 'reveal-step');
      const s4h = el('div', 'step-head');
      s4h.append(el('span', 'step-n', { text: '05 · Why this works' }));
      const whyP = el('p', null, { text: r.why });
      whyP.style.cssText = 'font-family:var(--serif);font-size:15px;line-height:1.6;color:var(--ink);margin:0';
      s4.append(s4h, whyP);
      output.appendChild(s4);

      renderFeedback(r);

      const steps = output.querySelectorAll('.reveal-step');
      steps.forEach((step, i) => {
        setTimeout(() => step.classList.add('visible'), 320 * (i + 1));
      });
    }
  };
})();
