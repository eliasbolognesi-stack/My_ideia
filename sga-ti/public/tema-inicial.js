// Resolve o tema antes da primeira pintura, para não haver flash de tela
// clara. Padrão: escuro. "sistema" segue a configuração do dispositivo.
//
// Fica em arquivo próprio (e não embutido no HTML) para que a política de
// segurança de conteúdo possa proibir script embutido por completo.
(function () {
  var preferencia = 'escuro';
  try {
    preferencia = localStorage.getItem('sga_ti_tema') || 'escuro';
  } catch (e) { /* janela privada */ }
  var claro = preferencia === 'claro'
    || (preferencia === 'sistema' && window.matchMedia('(prefers-color-scheme: light)').matches);
  document.documentElement.dataset.tema = claro ? 'claro' : 'escuro';
})();
