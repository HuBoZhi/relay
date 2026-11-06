/* Shared desktop chrome for the chat and task pages. Browsers keep their own chrome. */
'use strict';
window.relayMountDesktopMenu = function () {
  const bridge = window.relayDesktop;
  if (!bridge?.menu) return;
  document.body.classList.add('is-desktop');
  const button = document.querySelector('#menu-button');
  const pop = document.querySelector('#menu-pop');
  if (!button || !pop || button.dataset.bound) return;
  button.dataset.bound = 'true';
  button.hidden = false;
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  pop.setAttribute('role', 'menu');
  pop.setAttribute('aria-label', '应用菜单');
  const close = (focus = false) => {
    pop.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (focus) button.focus();
  };
  button.onclick = async () => {
    if (!pop.hidden) { close(); return; }
    button.disabled = true;
    try {
      const model = await bridge.menu();
      pop.replaceChildren();
      for (const group of model) {
        const label = document.createElement('div');
        label.className = 'group';
        label.textContent = group.label;
        pop.append(label);
        for (const item of group.items) {
          const el = document.createElement(item.type === 'separator' ? 'hr' : 'button');
          if (item.type !== 'separator') {
            el.type = 'button';
            el.setAttribute('role', 'menuitem');
            el.textContent = item.label;
            el.onclick = async () => {
              close();
              try { await bridge.run(item.id); } catch { showError(); }
            };
          }
          pop.append(el);
        }
      }
      pop.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      pop.querySelector('button')?.focus();
    } catch { showError(); }
    finally { button.disabled = false; }
  };
  function showError() {
    const toast = document.querySelector('#toast');
    if (toast) {
      toast.textContent = '应用菜单暂时不可用，请重试。';
      toast.dataset.tone = 'bad';
      toast.hidden = false;
    }
  }
  button.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); button.click(); }
  });
  pop.addEventListener('keydown', (event) => {
    const items = [...pop.querySelectorAll('button')];
    let index = items.indexOf(document.activeElement);
    if (event.key === 'ArrowDown') index = (index + 1) % items.length;
    else if (event.key === 'ArrowUp') index = (index + items.length - 1) % items.length;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = items.length - 1;
    else if (event.key === 'Tab') { close(); return; }
    else return;
    event.preventDefault();
    items[index]?.focus();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !pop.hidden) { event.preventDefault(); close(true); }
  });
  document.addEventListener('click', (event) => {
    if (!pop.hidden && !pop.contains(event.target) && !button.contains(event.target)) close();
  });
};
