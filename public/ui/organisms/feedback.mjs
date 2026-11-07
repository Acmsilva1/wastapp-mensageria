import { node, button } from '../atoms/dom.mjs';
import { toastMessage, successMessage } from '../molecules/message.mjs';

export const UI_VERSION = '1.0.0';

/** Estado isolado por aplicação; temas e regras de negócio pertencem ao consumidor. */
export function createFeedback({ getDocument = () => globalThis.document } = {}) {
  let confirmation = null;
  let dismissToast = null;
  let successTimer;

  function confirm({ title = 'Confirmar ação', message = '', confirmLabel = 'Confirmar', cancelLabel = 'Cancelar', danger = false } = {}) {
    if (confirmation) return Promise.resolve(false);
    const document = getDocument();
    const previous = document.activeElement;
    const dialog = node(document, 'dialog', undefined, 'app-confirm-modal');
    const icon = node(document, 'span', danger ? '!' : '✓', `ui-confirm-icon ${danger ? 'danger' : ''}`);
    icon.setAttribute('aria-hidden', 'true');
    const heading = node(document, 'h4', title);
    const copy = node(document, 'p', message);
    heading.id = 'ui-confirm-title';
    copy.id = 'ui-confirm-description';
    dialog.setAttribute('aria-labelledby', heading.id);
    dialog.setAttribute('aria-describedby', copy.id);
    const actions = node(document, 'div', undefined, 'app-confirm-actions');
    const cancel = button(document, cancelLabel, 'app-confirm-btn cancel');
    const accept = button(document, confirmLabel, 'app-confirm-btn confirm');
    actions.append(cancel, accept);
    dialog.append(icon, heading, copy, actions);
    document.body.append(dialog);
    return new Promise(resolve => {
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        confirmation = null;
        if (dialog.open) dialog.close();
        dialog.remove();
        if (previous?.isConnected) previous.focus();
        resolve(value);
      };
      confirmation = () => finish(false);
      cancel.onclick = () => finish(false);
      accept.onclick = () => finish(true);
      dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
      dialog.addEventListener('close', () => finish(false));
      dialog.addEventListener('click', event => {
        const rect = dialog.getBoundingClientRect();
        if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) finish(false);
      });
      dialog.showModal();
      cancel.focus();
    });
  }

  function toast(message, { error = false, title = error ? 'Não foi possível concluir' : 'Concluído' } = {}) {
    const document = getDocument();
    dismissToast?.();
    document.querySelector('.ui-toast')?.remove();
    const { box, close } = toastMessage(document, message, { error, title });
    document.body.append(box);
    let timer;
    const dismiss = () => { clearTimeout(timer); box.remove(); if (dismissToast === dismiss) dismissToast = null; };
    dismissToast = dismiss;
    timer = setTimeout(dismiss, error ? 9000 : 5000);
    close.onclick = dismiss;
    box.onmouseenter = () => clearTimeout(timer);
    box.onmouseleave = () => { clearTimeout(timer); timer = setTimeout(dismiss, 3000); };
  }

  function success(message) {
    const document = getDocument();
    clearTimeout(successTimer);
    document.getElementById('app-confirmation')?.remove();
    const box = successMessage(document, message);
    document.body.append(box);
    successTimer = setTimeout(() => box.remove(), 1000);
  }

  return { confirm, toast, success, closeConfirmation: () => confirmation?.() };
}
