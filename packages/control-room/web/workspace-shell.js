/* One navigation and desktop menu across every Relay workspace. */
'use strict';
(() => {
  const page = location.pathname.endsWith('chat.html') ? 'chat'
    : location.pathname.endsWith('tasks.html') ? 'tasks' : 'observer';
  document.body.classList.add('unified-workspace');
  document.body.dataset.workspace = page;
  if (window.relayDesktop) {
    document.body.classList.add('is-desktop');
    document.documentElement.classList.add('is-desktop');
  }
  const header = document.createElement('header');
  header.className = 'workspace-header';
  header.innerHTML = `<a class="workspace-brand" href="./chat.html">Relay <small>协作空间</small></a>
    <nav class="workspace-nav" aria-label="工作空间导航">
      <a href="./chat.html" data-workspace-link="chat">群聊</a>
      <a href="./tasks.html" data-workspace-link="tasks">任务工作台</a>
      <a href="./" data-workspace-link="observer">观察台</a>
    </nav>
    <div class="workspace-tools"><a href="./tasks.html#clients">客户端接入</a>
    <a href="./tasks.html#settings">设置</a></div>`;
  header.querySelector(`[data-workspace-link="${page}"]`).setAttribute('aria-current', 'page');
  // The same menu implementation and anchor are used on all three pages.
  let menu = document.querySelector('#menu-button');
  if (!menu) {
    menu = document.createElement('button');
    menu.id = 'menu-button';
    menu.type = 'button';
    menu.textContent = '菜单';
    menu.hidden = true;
  }
  header.querySelector('.workspace-tools').append(menu);
  if (!document.querySelector('#menu-pop')) {
    const pop = document.createElement('div');
    pop.id = 'menu-pop';
    pop.hidden = true;
    document.body.append(pop);
  }
  document.body.prepend(header);
  window.relayMountDesktopMenu?.();
})();
