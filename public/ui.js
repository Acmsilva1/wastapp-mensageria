import { createFeedback } from './ui/organisms/feedback.mjs';
// Padrão visual compartilhado com o tema banco do Super App.
(() => {
  document.documentElement.dataset.theme='light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content','#ffffff');
  const {confirm,toast,closeConfirmation}=createFeedback();
  window.AppUI={confirm,toast,closeConfirmation};
})();
