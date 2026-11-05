// Asking a question in the page.
//
// A native prompt is not a dialog in a desktop window: Electron has no
// JavaScript dialog manager, so the call returns `null` without drawing a box.
// A button that waits on it therefore looks dead — the group-name prompt never
// appeared and never answered, so "新建群" did nothing at all.
//
// Every ask lives in the page instead: one code path for a browser tab and for
// the desktop shell, and the answer is visible before it is sent.
'use strict';

(() => {
  /** The dialog currently on screen; a second ask replaces it. */
  let current = null;

  const escapeText = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]
    );

  function fieldMarkup(spec, index) {
    const id = `relay-ask-field-${index}`;
    const name = escapeText(spec.name);
    const label = escapeText(spec.label ?? spec.name);
    const hint = spec.hint ? `<span class="relay-ask-hint">${escapeText(spec.hint)}</span>` : '';

    if (Array.isArray(spec.options)) {
      const options = spec.options
        .map((option) => {
          const value = typeof option === 'string' ? option : option.value;
          const text = typeof option === 'string' ? option : (option.label ?? option.value);
          const selected = String(spec.value ?? '') === String(value) ? ' selected' : '';
          return `<option value="${escapeText(value)}"${selected}>${escapeText(text)}</option>`;
        })
        .join('');
      return `<label class="relay-ask-field" for="${id}">
        <span>${label}</span>
        <select id="${id}" data-ask-field="${name}">${options}</select>
        ${hint}
      </label>`;
    }

    const placeholder = `placeholder="${escapeText(spec.placeholder ?? '')}"`;
    if (spec.multiline) {
      return `<label class="relay-ask-field" for="${id}">
        <span>${label}</span>
        <textarea id="${id}" data-ask-field="${name}" rows="3" ${placeholder} autocomplete="off" spellcheck="false">${escapeText(
          spec.value ?? ''
        )}</textarea>
        ${hint}
      </label>`;
    }
    return `<label class="relay-ask-field" for="${id}">
      <span>${label}</span>
      <input id="${id}" data-ask-field="${name}" type="text" value="${escapeText(
        spec.value ?? ''
      )}" ${placeholder} autocomplete="off" spellcheck="false" />
      ${hint}
    </label>`;
  }

  /**
   * Show a small form and resolve with its values, or `null` when dismissed.
   *
   * @param {{
   *   title: string,
   *   description?: string,
   *   confirmLabel?: string,
   *   cancelLabel?: string,
   *   fields: {
   *     name: string, label?: string, value?: string, placeholder?: string,
   *     hint?: string, required?: boolean, multiline?: boolean,
   *     options?: (string | { value: string, label?: string })[]
   *   }[]
   * }} options
   * @returns {Promise<Record<string, string> | null>}
   */
  function ask(options) {
    // One question at a time: an earlier ask gives way instead of stacking.
    if (current) current.close(null);

    const spec = options ?? {};
    const fields = Array.isArray(spec.fields) ? spec.fields : [];
    const previous = document.activeElement;
    let resolveAsk = () => {};
    let settled = false;

    const overlay = document.createElement('div');
    overlay.className = 'relay-ask-overlay';
    overlay.innerHTML = `<div class="relay-ask" role="dialog" aria-modal="true" aria-label="${escapeText(
      spec.title ?? '请填写'
    )}">
      <div class="relay-ask-head">
        <h2>${escapeText(spec.title ?? '请填写')}</h2>
        ${spec.description ? `<p>${escapeText(spec.description)}</p>` : ''}
      </div>
      <div class="relay-ask-body">${fields.map(fieldMarkup).join('')}</div>
      <div class="relay-ask-actions">
        <span class="relay-ask-keys">Enter 确认 · Esc 取消</span>
        <button type="button" class="relay-ask-button" data-ask-action="cancel">${escapeText(
          spec.cancelLabel ?? '取消'
        )}</button>
        <button type="button" class="relay-ask-button relay-ask-confirm" data-ask-action="confirm">${escapeText(
          spec.confirmLabel ?? '确定'
        )}</button>
      </div>
    </div>`;

    const inputs = [...overlay.querySelectorAll('[data-ask-field]')];
    const confirmButton = overlay.querySelector('[data-ask-action="confirm"]');

    function read() {
      const values = {};
      for (const input of inputs) values[input.dataset.askField] = String(input.value ?? '').trim();
      return values;
    }

    function blockers() {
      const values = read();
      return fields.filter((field) => field.required && !values[field.name]);
    }

    // Nothing is greyed out: an empty answer is refused with a line that says
    // which field is missing, so the button never looks dead for no reason.
    function clearNote() {
      overlay.querySelector('.relay-ask-error')?.remove();
    }

    function close(result) {
      if (settled) return;
      settled = true;
      overlay.remove();
      document.removeEventListener('keydown', onKeydown, true);
      if (current && current.overlay === overlay) current = null;
      if (previous instanceof HTMLElement && document.contains(previous)) previous.focus();
      resolveAsk(result);
    }

    function complain(missing) {
      const [first] = missing;
      const input = inputs.find((element) => element.dataset.askField === first.name);
      input?.focus();
      let note = overlay.querySelector('.relay-ask-error');
      if (!note) {
        note = document.createElement('p');
        note.className = 'relay-ask-error';
        overlay.querySelector('.relay-ask-actions')?.before(note);
      }
      note.textContent = `请填写「${first.label ?? first.name}」`;
    }

    function submit() {
      const missing = blockers();
      if (missing.length > 0) {
        complain(missing);
        return;
      }
      close(read());
    }

    function onKeydown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close(null);
        return;
      }
      if (event.key !== 'Enter' || event.isComposing) return;
      // Enter sends a one-line field; a multi-line answer needs Ctrl/Cmd+Enter so
      // a line break stays possible.
      const target = event.target;
      if (target instanceof HTMLElement && target.tagName === 'TEXTAREA' && !event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      submit();
    }

    const promise = new Promise((resolve) => {
      resolveAsk = resolve;
    });

    overlay.addEventListener('click', (event) => {
      const action = event.target instanceof Element ? event.target.closest('[data-ask-action]') : null;
      if (action) {
        if (action.dataset.askAction === 'confirm') submit();
        else close(null);
        return;
      }
      // A click on the dimmed area outside the card dismisses, as a modal should.
      if (event.target === overlay) close(null);
    });
    overlay.addEventListener('input', clearNote);
    overlay.addEventListener('change', clearNote);
    document.addEventListener('keydown', onKeydown, true);

    document.body.appendChild(overlay);
    current = { overlay, close };

    const first = inputs[0];
    if (first) {
      first.focus();
      if (first.tagName === 'INPUT') first.select();
    } else {
      confirmButton?.focus();
    }
    return promise;
  }

  window.relayAsk = ask;
})();
