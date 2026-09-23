// Standalone design study: no requests to the daemon and no real approvals.
const offline = document.querySelector('#offline');
const arrival = document.querySelector('#arrival');
const home = document.querySelector('[data-screen="home"]');
const feedback = document.querySelector('.decision-feedback');
const choices = [...document.querySelectorAll('[data-choice]')];
const reset = document.querySelector('.reset-decision');
const dialog = document.querySelector('#detail');
let selected = '';
let arrivalTimer;

function updateConnection() {
  document.querySelectorAll('.connection').forEach(el => { el.hidden = !offline.checked; });
  choices.forEach(button => { button.disabled = offline.checked || Boolean(selected); });
  document.querySelectorAll('.composer button').forEach(button => { button.disabled = offline.checked; });
  arrival.disabled = offline.checked;
  // Connectivity never changes CC's Light / Dark appearance.
  feedback.textContent = offline.checked
    ? '离线时不能提交选择。恢复连接后，需要重新确认任务状态。'
    : selected ? `演示：已选择「${selected}」。没有发送给真实任务。` : '晚点再选也没关系，这一步会等你。';
  document.querySelectorAll('.composer').forEach(form => {
    form.nextElementSibling.textContent = offline.checked ? '仍可写草稿，重连后由你发送。' : '';
  });
}
offline.addEventListener('change', updateConnection);

function greet() {
  clearTimeout(arrivalTimer);
  home.classList.remove('arrived');
  home.querySelector('.dark').setAttribute('aria-hidden', 'false');
  home.querySelector('.light').setAttribute('aria-hidden', 'true');
  home.querySelector('.greeting').textContent = 'CC 正安静地待着。';
  arrivalTimer = setTimeout(() => {
    home.classList.add('arrived');
    home.querySelector('.dark').setAttribute('aria-hidden', 'true');
    home.querySelector('.light').setAttribute('aria-hidden', 'false');
    home.querySelector('.greeting').textContent = '你来啦，陪我坐一会儿。';
  }, 900);
}
arrival.addEventListener('click', greet);
greet();

choices.forEach(button => button.addEventListener('click', () => {
  if (offline.checked || selected) return;
  selected = button.dataset.choice;
  reset.hidden = false;
  updateConnection();
}));
reset.addEventListener('click', () => { selected = ''; reset.hidden = true; updateConnection(); });

document.querySelectorAll('.composer').forEach(form => {
  const input = form.querySelector('input');
  const key = `cc-mobile-study-draft-${form.dataset.draft}`;
  try { input.value = localStorage.getItem(key) || ''; } catch { /* Storage may be unavailable. */ }
  input.addEventListener('input', () => {
    try { localStorage.setItem(key, input.value); }
    catch { form.nextElementSibling.textContent = '草稿仅保留在当前页面。'; }
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (offline.checked || !input.value.trim()) return;
    form.nextElementSibling.textContent = '这是交互样板，未发送；你的草稿保留着。';
  });
});

const panels = {
  tasks: '<p class="eyebrow">一起做 · 示例</p><h2>首页换新</h2><p>Claude 正在检查导航，Codex 等待检查结论。</p><p>手机上先看进展、做决定；完整对话与文件操作留在工作页面。本轮只演示「此刻」。</p>',
  memories: '<p class="eyebrow">回忆 · 示例</p><h2>昨天留下的小故事</h2><img src="../cc-sticker-study/postcard-night.svg" alt="夜晚明信片"><p>日记、明信片和已完成的事情，放在这里慢慢翻。</p>',
  settings: '<p class="eyebrow">设置 · 样板说明</p><h2>随身 CC</h2><p>当前展示模拟内容，不会连接电脑或修改任何任务。页面顶部可体验到来与断线。</p><p>正式产品的电脑配对、通知和账户设置将在这里展开。</p>',
  artwork: '<p class="eyebrow">示例成果 / 原图</p><h2>咖啡馆的一小会儿</h2><img src="../cc-sticker-study/postcard-coffee.svg" alt="咖啡馆明信片完整原图"><p>你说那里总有烘豆香。我把那一小会儿画下来了。</p><a href="../cc-sticker-study/postcard-coffee.svg" download="cc-coffee-postcard.svg">保存 SVG 原图</a>',
};
function openPanel(name) {
  document.querySelector('#detail-content').innerHTML = panels[name];
  dialog.showModal();
}
document.querySelectorAll('[data-dialog]').forEach(button => button.addEventListener('click', () => openPanel(button.dataset.dialog)));
document.querySelectorAll('.settings').forEach(button => button.addEventListener('click', () => openPanel('settings')));
dialog.querySelector('.close').addEventListener('click', () => dialog.close());
