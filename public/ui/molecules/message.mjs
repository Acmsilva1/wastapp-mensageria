import { node, button } from '../atoms/dom.mjs';

/** Texto fornecido pelo app sempre entra como textContent. */
export function toastMessage(document, message, { error, title }) {
  const box = node(document, 'div', undefined, `ui-toast ${error ? 'error' : 'success'}`);
  box.setAttribute('role', error ? 'alert' : 'status');
  const icon = node(document, 'span', error ? '!' : '✓', 'ui-toast-icon');
  icon.setAttribute('aria-hidden', 'true');
  const content = node(document, 'div');
  const close = button(document, '×', 'ui-toast-close');
  close.setAttribute('aria-label', 'Fechar mensagem');
  content.append(node(document, 'strong', title), node(document, 'p', message));
  box.append(icon, content, close);
  return { box, close };
}

export function successMessage(document, message) {
  const box = node(document, 'div', undefined, 'app-confirmation');
  box.id = 'app-confirmation';
  box.setAttribute('role', 'status');
  box.setAttribute('aria-live', 'polite');
  box.setAttribute('aria-atomic', 'true');
  const card = node(document, 'div', undefined, 'app-confirmation__card');
  const icon = node(document, 'span', '✓', 'app-confirmation__icon');
  icon.setAttribute('aria-hidden', 'true');
  card.append(icon, node(document, 'span', message));
  box.append(card);
  return box;
}
