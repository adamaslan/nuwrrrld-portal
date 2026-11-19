const menuButton = document.querySelector('.menu-toggle');
const mobileNavigation = document.querySelector('#mobile-nav');
function closeMenu() {
  mobileNavigation.hidden = true;
  menuButton.setAttribute('aria-expanded', 'false');
  menuButton.querySelector('.visually-hidden').textContent = 'Open menu';
}
menuButton.addEventListener('click', () => {
  const open = menuButton.getAttribute('aria-expanded') === 'true';
  mobileNavigation.hidden = open;
  menuButton.setAttribute('aria-expanded', String(!open));
  menuButton.querySelector('.visually-hidden').textContent = open ? 'Open menu' : 'Close menu';
});
mobileNavigation.querySelectorAll('a').forEach(link => link.addEventListener('click', closeMenu));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && menuButton.getAttribute('aria-expanded') === 'true') {
    closeMenu();
    menuButton.focus();
  }
});
const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
function selectTab(tab) {
  tabs.forEach(item => {
    const active = item === tab;
    item.setAttribute('aria-selected', String(active));
    item.tabIndex = active ? 0 : -1;
    document.getElementById(item.getAttribute('aria-controls')).hidden = !active;
  });
}
tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', event => {
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;
    if (next !== undefined) {
      event.preventDefault();
      selectTab(tabs[next]);
      tabs[next].focus();
    }
  });
});
document.querySelectorAll('[data-open]').forEach(button => {
  button.addEventListener('click', () => {
    closeMenu();
    document.getElementById(button.dataset.open).showModal();
  });
});
document.querySelectorAll('dialog').forEach(dialog => {
  dialog.querySelectorAll('.close-dialog').forEach(button => button.addEventListener('click', () => dialog.close()));
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
});
