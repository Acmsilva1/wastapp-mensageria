/** Atomic UI 1.0.0 — fonte: Super App/components/ui. */
export function node(document, tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

export function button(document, text, className) {
  const element = node(document, 'button', text, className);
  element.type = 'button';
  return element;
}
