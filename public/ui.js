// Padrão visual compartilhado com o tema banco do Super App.
(() => {
  const node=(tag,text,cls)=>{const element=document.createElement(tag);if(text!==undefined)element.textContent=text;if(cls)element.className=cls;return element;};
  document.documentElement.dataset.theme='light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content','#ffffff');
  let confirmation=null;
  function confirm({title='Confirmar ação',message='',confirmLabel='Confirmar',cancelLabel='Cancelar',danger=false}={}){
    if(confirmation)return Promise.resolve(false);
    const previous=document.activeElement,dialog=node('dialog',undefined,'app-confirm-modal');
    const icon=node('span',danger?'!':'✓',`ui-confirm-icon ${danger?'danger':''}`),heading=node('h4',title),copy=node('p',message),actions=node('div',undefined,'app-confirm-actions');
    heading.id='ui-confirm-title';copy.id='ui-confirm-description';dialog.setAttribute('aria-labelledby',heading.id);dialog.setAttribute('aria-describedby',copy.id);
    const cancel=node('button',cancelLabel,'app-confirm-btn cancel'),accept=node('button',confirmLabel,'app-confirm-btn confirm');cancel.type=accept.type='button';
    actions.append(cancel,accept);dialog.append(icon,heading,copy,actions);document.body.append(dialog);
    return new Promise(resolve=>{
      const finish=value=>{confirmation=null;dialog.close();dialog.remove();if(previous?.isConnected)previous.focus();resolve(value);};
      confirmation=()=>finish(false);cancel.onclick=()=>finish(false);accept.onclick=()=>finish(true);
      dialog.addEventListener('cancel',event=>{event.preventDefault();finish(false);});
      dialog.addEventListener('click',event=>{const r=dialog.getBoundingClientRect();if(event.target===dialog&&(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom))finish(false);});
      dialog.showModal();cancel.focus();
    });
  }
  function toast(message,{error=false,title=error?'Não foi possível concluir':'Concluído'}={}){
    document.querySelector('.ui-toast')?.remove();
    const box=node('div',undefined,`ui-toast ${error?'error':'success'}`);box.setAttribute('role',error?'alert':'status');
    const icon=node('span',error?'!':'✓','ui-toast-icon'),content=node('div'),close=node('button','×','ui-toast-close');
    close.type='button';close.setAttribute('aria-label','Fechar mensagem');content.append(node('strong',title),node('p',message));box.append(icon,content,close);document.body.append(box);
    let timer=setTimeout(()=>box.remove(),error?9000:5000);close.onclick=()=>{clearTimeout(timer);box.remove();};box.onmouseenter=()=>clearTimeout(timer);box.onmouseleave=()=>{timer=setTimeout(()=>box.remove(),3000);};
  }
  window.AppUI={confirm,toast,closeConfirmation:()=>confirmation?.()};
})();
