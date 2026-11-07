import { describe, beforeEach, afterEach, it, mock } from 'node:test';
import { createFeedback } from '../public/ui/organisms/feedback.mjs';
const clock = { enable: () => mock.timers.enable({ apis: ['setTimeout'] }), reset: () => mock.timers.reset(), tick: ms => mock.timers.tick(ms) };
import assert from 'node:assert/strict';

function createDocument() {
  const document = { activeElement: null };
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.events = {}; this.isConnected = true; }
    setAttribute(key, value) { this.attributes[key] = value; }
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
    remove() { this.isConnected = false; if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
    focus() { document.activeElement = this; }
    addEventListener(type, listener) { (this.events[type] ||= []).push(listener); }
    dispatch(type, event = {}) { for (const listener of this.events[type] || []) listener(event); }
    showModal() { this.open = true; }
    close() { this.open = false; this.dispatch('close'); }
    getBoundingClientRect() { return { left: 10, top: 10, right: 200, bottom: 100 }; }
  }
  const all = () => { const visit = node => [node, ...node.children.flatMap(visit)]; return visit(document.body); };
  document.createElement = tag => new Element(tag);
  document.body = new Element('body');
  document.getElementById = id => all().find(node => node.id === id);
  document.querySelector = selector => all().find(node => selector.startsWith('.') ? node.className?.split(' ').includes(selector.slice(1)) : node.tagName === selector);
  return document;
}

describe('Atomic UI — contratos de feedback', () => {
let document, feedback;
beforeEach(() => {
  clock.enable();
  document = createDocument();
  feedback = createFeedback({ getDocument: () => document });
});
afterEach(() => clock.reset());

it('confirma só uma vez, bloqueia diálogos simultâneos e devolve o foco', async () => {
  const trigger = document.createElement('button'); trigger.focus();
  const pending = feedback.confirm({ title: 'Excluir?', message: '<img src=x onerror=alert(1)>', danger: true });
  const dialog = document.querySelector('dialog');
  assert.equal(dialog.children[2].textContent, '<img src=x onerror=alert(1)>');
  assert.equal(document.activeElement.className, 'app-confirm-btn cancel');
  assert.equal(await feedback.confirm(), false);
  dialog.children[3].children[1].onclick();
  assert.equal(await pending, true);
  assert.equal(document.querySelector('dialog'), undefined);
  assert.equal(document.activeElement, trigger);
  const next = feedback.confirm(); feedback.closeConfirmation();
  assert.equal(await next, false);
});

it('Escape, clique fora, cancelamento e fechamento nativo resolvem falso sem deixar modal preso', async () => {
  for (const action of ['escape', 'backdrop', 'button', 'native']) {
    const pending = feedback.confirm(); const dialog = document.querySelector('dialog');
    if (action === 'escape') dialog.dispatch('cancel', { preventDefault() {} });
    if (action === 'backdrop') dialog.dispatch('click', { target: dialog, clientX: 0, clientY: 0 });
    if (action === 'button') dialog.children[3].children[0].onclick();
    if (action === 'native') dialog.close();
    assert.equal(await pending, false);
    assert.equal(document.querySelector('dialog'), undefined);
  }
});

it('toast substitui o anterior com texto seguro e mantém o novo até seu próprio prazo', () => {
  feedback.toast('Primeira'); clock.tick(4000);
  feedback.toast('<script>erro</script>', { error: true });
  const current = document.querySelector('.ui-toast');
  assert.equal(current.attributes.role, 'alert');
  assert.equal(current.children[1].children[1].textContent, '<script>erro</script>');
  clock.tick(1000); assert.equal(document.querySelector('.ui-toast'), current);
  clock.tick(7999); assert.equal(document.querySelector('.ui-toast'), current);
  clock.tick(1); assert.equal(document.querySelector('.ui-toast'), undefined);
});

it('toast pausa no hover, retoma por três segundos e permite fechar', () => {
  feedback.toast('Salvo'); const box = document.querySelector('.ui-toast');
  assert.equal(box.attributes.role, 'status');
  box.onmouseenter(); clock.tick(10000); assert.equal(document.querySelector('.ui-toast'), box);
  box.onmouseleave(); clock.tick(2999); assert.equal(document.querySelector('.ui-toast'), box);
  clock.tick(1); assert.equal(document.querySelector('.ui-toast'), undefined);
  feedback.toast('Outra'); document.querySelector('.ui-toast').children[2].onclick();
  assert.equal(document.querySelector('.ui-toast'), undefined);
});

it('aviso do Super App dura um segundo, substitui anterior e preserva foco', () => {
  const input = document.createElement('input'); input.focus();
  feedback.success('Primeira'); clock.tick(600); feedback.success('Segunda');
  const current = document.getElementById('app-confirmation');
  assert.equal(current.attributes['aria-live'], 'polite');
  assert.equal(current.children[0].children[1].textContent, 'Segunda');
  assert.equal(document.activeElement, input);
  clock.tick(999); assert.equal(document.getElementById('app-confirmation'), current);
  clock.tick(1); assert.equal(document.getElementById('app-confirmation'), undefined);
});

});
