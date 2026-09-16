'use strict';

// Limitador de uso por janela de tempo, reaproveitado pelo login, pelo
// registro de eventos e pelo webhook.
//
// Cada limitador guarda um contador por chave (endereço de origem, usuário ou
// chave de API) e zera a contagem quando a janela expira. Uma varredura
// periódica remove as chaves ociosas — sem isso o mapa cresceria para sempre,
// que era o vazamento do controle de login original.

function criarLimitador({ janelaMs, maximo, nome }) {
  const contadores = new Map();

  function permitir(chave) {
    const agora = Date.now();
    const registro = contadores.get(chave);
    if (!registro || agora > registro.expira) {
      contadores.set(chave, { contagem: 1, expira: agora + janelaMs });
      return true;
    }
    registro.contagem += 1;
    return registro.contagem <= maximo;
  }

  function limpar(agora = Date.now()) {
    for (const [chave, registro] of contadores) {
      if (agora > registro.expira) contadores.delete(chave);
    }
  }

  // unref() para a varredura não segurar o processo aberto no encerramento.
  const relogio = setInterval(() => limpar(), janelaMs);
  if (typeof relogio.unref === 'function') relogio.unref();

  return {
    permitir,
    limpar,
    nome,
    get tamanho() { return contadores.size; },
  };
}

module.exports = { criarLimitador };
