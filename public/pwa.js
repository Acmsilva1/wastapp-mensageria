(() => {
  const install = document.querySelector('#install-app'), message = document.querySelector('#pwa-message');
  const copy = document.querySelector('#pwa-copy'), update = document.querySelector('#pwa-update');
  if(!install || !message) return;
  let prompt, waiting, reloading = false;
  const show = text => { copy.textContent=text; message.hidden=false; };
  document.querySelector('#pwa-dismiss')?.addEventListener('click', () => { message.hidden=true; });
  window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); prompt=event; install.hidden=false; });
  window.addEventListener('appinstalled', () => { install.hidden=true; prompt=null; message.hidden=true; });
  install.addEventListener('click', async () => {
    if(!prompt) return;
    try { await prompt.prompt(); await prompt.userChoice; }
    finally { prompt=null; install.hidden=true; }
  });
  if(!matchMedia('(display-mode: standalone)').matches && /iPad|iPhone|iPod/.test(navigator.userAgent)) {
    show('Para instalar: abra o menu Compartilhar e escolha Adicionar à Tela de Início.');
  }
  update?.addEventListener('click', async () => { if(window.AppUI && !await AppUI.confirm({title:'Atualizar aplicativo?',message:'A nova versão será aplicada e a página será recarregada. Salve suas alterações antes de continuar.',confirmLabel:'Atualizar agora'}))return; waiting?.postMessage({type:'SKIP_WAITING'}); });
  const offer = worker => { waiting=worker; show('Uma nova versão do app está disponível.'); update.hidden=false; };
  if('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', async () => {
      try {
        const registration = await navigator.serviceWorker.register('/sw.js', {scope:'/',updateViaCache:'none'});
        if(registration.waiting && navigator.serviceWorker.controller) offer(registration.waiting);
        registration.addEventListener('updatefound', () => {
          const worker=registration.installing;
          worker?.addEventListener('statechange', () => { if(worker.state==='installed' && navigator.serviceWorker.controller) offer(worker); });
        });
        document.addEventListener('visibilitychange', () => { if(!document.hidden) registration.update().catch(()=>{}); });
      } catch { show('O modo app não pôde ser preparado. Você pode continuar usando o painel online.'); }
    });
    navigator.serviceWorker.addEventListener('controllerchange', () => { if(!reloading && waiting){reloading=true;location.reload();} });
  }
})();
