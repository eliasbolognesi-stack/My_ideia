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

  // Conta a tentativa e diz se ela cabe na janela. Para limite de vazão
  // (eventos, webhook), em que toda chamada pesa.
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

  // Só consulta, sem contar. Para o login, em que quem pesa é a tentativa
  // FALHA: um escritório inteiro sai pelo mesmo endereço de rede, e contar
  // entrada bem-sucedida travaria o time em vez de atrapalhar o atacante.
  function excedeu(chave) {
    const registro = contadores.get(chave);
    return Boolean(registro && Date.now() <= registro.expira && registro.contagem >= maximo);
  }

  // Marca uma tentativa malsucedida.
  function registrar(chave) {
    permitir(chave);
  }

  // Entrada bem-sucedida limpa o histórico daquela origem.
  function perdoar(chave) {
    contadores.delete(chave);
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
    excedeu,
    registrar,
    perdoar,
    limpar,
    nome,
    get tamanho() { return contadores.size; },
  };
}

module.exports = { criarLimitador };
